/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { session, webContents, type Debugger, type WebContents } from 'electron';
import { WebSocketServer, type WebSocket } from 'ws';
import { BROWSER_SESSION_PARTITION } from '../../../common/config/constants';
import {
  BrowserControlCoordinator,
  BrowserTargetRegistry,
  blockedCdpCapability,
  challengeReadBlockedError,
  navigationBlockedError,
  noBrowserTargetError,
  OriginRateLimiter,
  pausedWriteError,
  rateLimitedNavigationError,
  sensitiveReadBlockedError,
  targetCreateTimeoutError,
  targetCreateUnavailableError,
  unknownTargetError,
  unsupportedBrowserCommandError,
  validateBrowserNavigation,
} from '../../services/browser-control';
import {
  browserDownloadDirectory,
  ensureUniqueDownloadPath,
  safeDownloadFileName,
  type BrowserDownloadEvent,
} from '../../services/browser-control/browserDownloads';
import { getManagedBrowserCredentialStore } from '../../services/browser-control/managedCredentialStore';
import { classifyBrowserResponse } from '../../services/browser-control/policies/challengeClassifier';
import {
  DEFAULT_MAX_DOWNLOAD_BYTES,
  createBrowserDownloadId,
} from '../../services/browser-control/policies/downloadPolicy';
import {
  isMainFramePdfResponse,
  pdfFileNameFromUrl,
} from '../../services/browser-control/policies/pdfResponseClassifier';
import { buildVersionPayload, tokensMatch, type CdpRequest, type TargetInfo } from './cdpTargetProtocol';

const HOST = '127.0.0.1';
const WS_PATH = '/aionui-cdp';
const BROWSER_CONTEXT_ID = 'aionui-browser-context';

export type BrowserTargetRegistration = {
  tabId: string;
  webContentsId: number;
  scopeId: string;
  title: string;
  url: string;
  active: boolean;
  requestId?: string;
};

export type BrowserTargetCommand = { tabId: string; targetId: string; requestId: string; url?: string };

export type CdpBridgeHandle = {
  port: number;
  token: string;
  attachedWebContentsId: () => number | null;
  targetCount: () => number;
  attach: (webContentsId: number) => { ok: true } | { ok: false; reason: string };
  detach: (webContentsId?: number) => void;
  register: (registration: BrowserTargetRegistration) => { ok: true; targetId: string } | { ok: false; reason: string };
  unregister: (webContentsId: number) => void;
  pause: (tabId: string) => boolean;
  resume: (tabId: string) => boolean;
  close: () => Promise<void>;
};

export type CdpBridgeOptions = {
  onTargetRequired?: () => void | Promise<void>;
  onCreateTarget?: (command: Omit<BrowserTargetCommand, 'tabId' | 'targetId'>) => void | Promise<void>;
  onActivateTarget?: (command: BrowserTargetCommand) => void | Promise<void>;
  onCloseTarget?: (command: BrowserTargetCommand) => void | Promise<void>;
  onTargetControlStateChanged?: (event: BrowserTargetControlStateEvent) => void;
  onTargetActivityChanged?: (event: { tabId: string; targetId: string; active: boolean }) => void;
  targetAttachTimeoutMs?: number;
  /**
   * PDF 拦截落盘完成时触发，与 installBrowserDownloadPolicy 的 onEvent 共用同一个
   * IPC 事件，让「打开 PDF 预览 tab」始终只有一条代码路径。
   *
   * Fires when a PDF interception finishes writing to disk. Shares the same IPC event
   * as installBrowserDownloadPolicy's onEvent, so "open a PDF preview tab" stays a
   * single code path.
   */
  onPdfDownload?: (event: BrowserDownloadEvent) => void;
};

export type BrowserTargetControlState =
  | 'ready'
  | 'userTakeover'
  | 'challengeRequired'
  | 'rateLimited'
  | 'authenticationRequired'
  | 'accessDenied';

export type BrowserTargetControlStateEvent = {
  tabId: string;
  targetId: string;
  state: BrowserTargetControlState;
  retryAt?: number | null;
};

type AttachedTarget = {
  contents: WebContents;
  dbg: Debugger;
  onMessage: (event: unknown, method: string, params: unknown) => void;
  onDestroyed: () => void;
};

type ConnectionState = {
  id: string;
  ws: WebSocket;
  discover: boolean;
  autoAttach: boolean;
  sessions: Map<string, string>;
  sessionByTarget: Map<string, string>;
};

const targetInfo = (target: ReturnType<BrowserTargetRegistry['get']>): TargetInfo | null =>
  target
    ? {
        targetId: target.targetId,
        type: 'page',
        title: target.title,
        url: target.url,
        attached: true,
        canAccessOpener: false,
        browserContextId: BROWSER_CONTEXT_ID,
      }
    : null;

const send = (ws: WebSocket, payload: unknown): void => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
};

const sendError = (ws: WebSocket, id: number | undefined, message: string, sessionId?: string): void => {
  send(ws, { id: id ?? 0, error: { code: -32000, message }, sessionId });
};

const writeJson = (res: ServerResponse, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
};

export const startCdpBridge = async (options: CdpBridgeOptions = {}): Promise<CdpBridgeHandle> => {
  const token = randomBytes(24).toString('hex');
  /**
   * 等一个新标签挂上来的窗口。
   *
   * 这条路不是一次 IPC 往返就完事：主进程发 openLocal -> 渲染进程建 tab -> 挂载 webview ->
   * webview 拿到 webContentsId -> 再 invoke 回来注册。冷启动时渲染进程还在忙，5s 经常不够。
   *
   * 超时的代价不是「没开成」—— 标签通常随后还是会出现，只是 Agent 已经收到了失败，于是
   * 可能再调一次 new_page，屏幕上多出一个空白页。把窗口放宽到 10s 换掉的正是这种幻影标签。
   * 真失败（渲染进程压根没建）很罕见，多等 5s 可以接受。
   *
   * How long to wait for a new tab to attach. This is not a single IPC round trip: the main
   * process emits openLocal, the renderer creates the tab, mounts the webview, reads its
   * webContentsId, and only then invokes back to register. During a cold start the renderer is
   * still busy and 5s often is not enough.
   *
   * Timing out does not mean the tab never opened — it usually shows up moments later, but the
   * agent already has a failure and may call new_page again, leaving a phantom blank tab on the
   * user's screen. Widening the window to 10s buys away exactly that. A genuine failure (the
   * renderer never created it) is rare, so the extra 5s costs little.
   */
  const timeoutMs = options.targetAttachTimeoutMs ?? 10_000;
  const browserSession = session.fromPartition(BROWSER_SESSION_PARTITION);
  const registry = new BrowserTargetRegistry(() => `aionui-browser-${randomUUID()}`);
  const coordinator = new BrowserControlCoordinator();
  const rateLimiter = new OriginRateLimiter();
  const managedCredentialStore = getManagedBrowserCredentialStore();
  const attached = new Map<string, AttachedTarget>();
  const connections = new Set<ConnectionState>();
  const pendingCreates = new Map<string, (targetId: string | null) => void>();
  const writeQueues = new Map<string, Promise<void>>();
  const agentNavigatingWebContents = new Set<number>();

  // Permission, navigation, and certificate gates for this partition are installed by
  // installBrowserSessionGuards (services/browser-control/sessionGuards.ts) at application
  // startup, not here. They used to live in this function, which meant they only existed while
  // agent browser control was enabled — with the feature switched off the partition had no
  // permission handler at all and Electron's default is to grant. They now hold either way, and
  // Agent/CDP commands still cannot bypass them.
  const controlState = new Map<string, { state: BrowserTargetControlState; retryAt?: number | null }>();
  /**
   * 每个 target 的 PDF 拦截状态：主 frame id（用来判定顶层导航），以及正在等待
   * loadingFinished 的请求 id/url。见 Fix B 相关分支。
   *
   * Per-target PDF interception state: the main frame id (used to recognize a
   * top-level navigation) and the request id/url currently awaiting
   * loadingFinished. See the Fix B branches below.
   */
  const pdfState = new Map<
    string,
    { mainFrameId: string | null; pendingPdfRequestId: string | null; pendingPdfUrl: string }
  >();

  const handlePdfInterception = async (dbg: Debugger, requestId: string, url: string): Promise<void> => {
    try {
      const response = (await dbg.sendCommand('Network.getResponseBody', { requestId })) as {
        body: string;
        base64Encoded: boolean;
      };
      const buffer = response.base64Encoded ? Buffer.from(response.body, 'base64') : Buffer.from(response.body, 'utf8');
      if (buffer.byteLength > DEFAULT_MAX_DOWNLOAD_BYTES) return;

      const fileName = safeDownloadFileName(pdfFileNameFromUrl(url));
      const directory = browserDownloadDirectory();
      fs.mkdirSync(directory, { recursive: true });
      const savePath = ensureUniqueDownloadPath(path.join(directory, fileName), (candidate) =>
        fs.existsSync(candidate)
      );
      fs.writeFileSync(savePath, buffer);

      // 此时原生渲染早已注定失败，晚一点 stop 不会有任何损失，反而避免了跟 body 读取抢跑。
      // The native render is doomed by this point; stopping late costs nothing and avoids
      // racing the body read.
      void dbg.sendCommand('Page.stopLoading').catch(() => {});

      options.onPdfDownload?.({ id: createBrowserDownloadId(), state: 'completed', fileName, savePath, isPdf: true });
    } catch {
      // 静默放弃：不会比今天「一片空白」更糟。
      // Silently give up: never worse than today's blank panel.
    }
  };

  const setControlState = (targetId: string, state: BrowserTargetControlState, retryAt?: number | null): void => {
    controlState.set(targetId, { state, retryAt });
    if (state !== 'ready') coordinator.release(targetId);
    const target = registry.get(targetId);
    if (target) options.onTargetControlStateChanged?.({ tabId: target.tabId, targetId, state, retryAt });
  };

  const blockedWriteReason = (targetId: string): string | null => {
    const current = controlState.get(targetId);
    if (!current || current.state === 'ready') return null;
    if (current.state === 'rateLimited' && current.retryAt && current.retryAt <= Date.now()) {
      setControlState(targetId, 'ready');
      return null;
    }
    return pausedWriteError(current.state, current.retryAt);
  };

  const blockedSensitiveReadReason = (targetId: string, method: string): string | null => {
    if (
      method === 'Network.getCookies' ||
      method === 'Network.getAllCookies' ||
      method === 'Storage.getCookies' ||
      method === 'Network.getRequestPostData'
    ) {
      return sensitiveReadBlockedError();
    }
    const state = controlState.get(targetId)?.state;
    if (state !== 'challengeRequired' && state !== 'authenticationRequired') return null;
    if (
      method.startsWith('Runtime.') ||
      method.startsWith('DOM.') ||
      method.startsWith('Accessibility.') ||
      method === 'Network.getResponseBody' ||
      method === 'Page.captureScreenshot'
    ) {
      return challengeReadBlockedError(state);
    }
    return null;
  };

  const isWriteCommand = (method: string): boolean =>
    method.startsWith('Input.') ||
    method === 'Runtime.evaluate' ||
    method === 'Runtime.callFunctionOn' ||
    method === 'Page.navigate' ||
    method === 'Page.reload' ||
    method.startsWith('DOM.set') ||
    method.startsWith('Network.setCookie');

  browserSession.webRequest.onBeforeRequest((details, callback) => {
    if (!agentNavigatingWebContents.has(details.webContentsId) || details.resourceType !== 'mainFrame') {
      callback({});
      return;
    }
    const policy = validateBrowserNavigation(details.url);
    if (policy.ok === false) {
      agentNavigatingWebContents.delete(details.webContentsId);
      callback({ cancel: true });
      return;
    }
    callback({});
  });
  browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
    void managedCredentialStore
      .headersFor(details.url)
      .then((headers) => {
        if (!headers) {
          callback({ requestHeaders: details.requestHeaders });
          return;
        }
        const sensitiveNames = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
        const requestHeaders = Object.fromEntries(
          Object.entries(details.requestHeaders).filter(([name]) => !sensitiveNames.has(name.toLowerCase()))
        );
        callback({ requestHeaders: { ...requestHeaders, ...headers } });
      })
      .catch(() => callback({ requestHeaders: details.requestHeaders }));
  });

  const ensureSession = (connection: ConnectionState, targetId: string): { sessionId: string; created: boolean } => {
    const existing = connection.sessionByTarget.get(targetId);
    if (existing) return { sessionId: existing, created: false };
    const sessionId = `aionui-session-${randomUUID()}`;
    connection.sessions.set(sessionId, targetId);
    connection.sessionByTarget.set(targetId, sessionId);
    return { sessionId, created: true };
  };

  const emitAttached = (connection: ConnectionState, targetId: string): string | null => {
    const info = targetInfo(registry.get(targetId));
    if (!info) return null;
    const route = ensureSession(connection, targetId);
    if (route.created) {
      send(connection.ws, {
        method: 'Target.attachedToTarget',
        params: { sessionId: route.sessionId, targetInfo: info, waitingForDebugger: false },
      });
    }
    return route.sessionId;
  };

  const unregister = (webContentsId: number): void => {
    const removed = registry.unregisterByWebContents(webContentsId);
    if (!removed) return;
    coordinator.forgetTarget(removed.targetId);
    agentNavigatingWebContents.delete(removed.webContentsId);
    controlState.delete(removed.targetId);
    pdfState.delete(removed.targetId);
    const state = attached.get(removed.targetId);
    attached.delete(removed.targetId);
    if (state) {
      try {
        state.dbg.removeListener('message', state.onMessage);
        state.contents.removeListener('destroyed', state.onDestroyed);
        if (state.dbg.isAttached()) state.dbg.detach();
      } catch {
        // Target teardown is idempotent.
      }
    }
    for (const connection of connections) {
      const sessionId = connection.sessionByTarget.get(removed.targetId);
      if (sessionId) {
        connection.sessions.delete(sessionId);
        connection.sessionByTarget.delete(removed.targetId);
        send(connection.ws, { method: 'Target.detachedFromTarget', params: { sessionId, targetId: removed.targetId } });
      }
      if (connection.discover) {
        send(connection.ws, { method: 'Target.targetDestroyed', params: { targetId: removed.targetId } });
      }
    }
  };

  const register = (
    registration: BrowserTargetRegistration
  ): { ok: true; targetId: string } | { ok: false; reason: string } => {
    const contents = webContents.fromId(registration.webContentsId);
    if (!contents || contents.isDestroyed()) return { ok: false, reason: 'Browser webContents is not available.' };
    if (contents.getType() !== 'webview') return { ok: false, reason: 'Only Browser webviews may be registered.' };
    if (contents.session !== browserSession) {
      return { ok: false, reason: 'The webview does not use the Browser session partition.' };
    }
    const registeredContents = registry.getByWebContents(registration.webContentsId);
    if (registeredContents && registeredContents.tabId !== registration.tabId) {
      return { ok: false, reason: 'The webview is already registered to another Browser tab.' };
    }

    const previous = registry.getByTab(registration.tabId);
    if (previous && previous.webContentsId !== registration.webContentsId) {
      agentNavigatingWebContents.delete(previous.webContentsId);
    }
    const record = registry.register(registration);
    const existingAttachment = attached.get(record.targetId);
    if (existingAttachment && existingAttachment.contents.id !== contents.id) {
      attached.delete(record.targetId);
      try {
        existingAttachment.dbg.removeListener('message', existingAttachment.onMessage);
        existingAttachment.contents.removeListener('destroyed', existingAttachment.onDestroyed);
        if (existingAttachment.dbg.isAttached()) existingAttachment.dbg.detach();
      } catch {
        // A renderer replacement may already have destroyed the old target.
      }
    }
    if (!attached.has(record.targetId)) {
      const dbg = contents.debugger;
      try {
        if (!dbg.isAttached()) dbg.attach('1.3');
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
      /**
       * 主动打开 Network/Page 域，不等外部 CDP 客户端来开。不这样做的话，classify
       * 挑战/限流和下面的 PDF 拦截都只在有真实 Agent 会话连着、并且它自己发了
       * enable 的时候才会生效 —— 大多数手动浏览的场景里，这两个域从来没被打开过。
       *
       * Proactively enable the Network/Page domains instead of waiting for an external
       * CDP client to do it. Without this, both the existing challenge/rate-limit
       * classification and the PDF interception below only ever fire while a real agent
       * session is attached and has enabled them itself — in most manual browsing, these
       * domains are never turned on at all.
       */
      void dbg.sendCommand('Page.enable').catch(() => {});
      void dbg.sendCommand('Network.enable').catch(() => {});
      pdfState.set(record.targetId, { mainFrameId: null, pendingPdfRequestId: null, pendingPdfUrl: '' });
      const onMessage = (_event: unknown, method: string, params: unknown) => {
        if (method === 'Page.frameStoppedLoading') {
          agentNavigatingWebContents.delete(registration.webContentsId);
        }
        if (method === 'Page.frameNavigated') {
          const event = params as { frame?: { id?: string; parentId?: string; url?: string } };
          if (!event.frame?.parentId) {
            const pdf = pdfState.get(record.targetId);
            if (pdf) pdf.mainFrameId = event.frame?.id ?? null;
            const updated = registry.updateDocument(record.targetId, { url: event.frame?.url });
            const updatedInfo = targetInfo(updated);
            if (updatedInfo) {
              for (const connection of connections) {
                if (connection.discover) {
                  send(connection.ws, { method: 'Target.targetInfoChanged', params: { targetInfo: updatedInfo } });
                }
              }
            }
          }
        }
        if (method === 'Network.responseReceived') {
          const event = params as {
            type?: string;
            response?: { status?: number; url?: string; headers?: Record<string, string | number> };
          };
          if (typeof event.response?.status === 'number') {
            const block = classifyBrowserResponse({
              status: event.response.status,
              headers: event.response.headers,
            });
            if (block.kind === 'cloudflareChallenge') setControlState(record.targetId, 'challengeRequired');
            else if (block.kind === 'rateLimited') {
              const retryAt = rateLimiter.recordRateLimit(event.response.url ?? record.url, block.retryAt);
              setControlState(record.targetId, 'rateLimited', retryAt);
            } else if (block.kind === 'authenticationRequired' && event.type === 'Document') {
              setControlState(record.targetId, 'authenticationRequired');
            } else if (block.kind === 'accessDenied' && event.type === 'Document') {
              setControlState(record.targetId, 'accessDenied');
            } else if (event.type === 'Document' && event.response.status >= 200 && event.response.status < 400) {
              agentNavigatingWebContents.delete(registration.webContentsId);
              rateLimiter.recordSuccess(event.response.url ?? record.url);
              const current = controlState.get(record.targetId)?.state;
              if (current && current !== 'userTakeover') setControlState(record.targetId, 'ready');
            }
          }
        }
        /**
         * Fix B：顶层导航是 PDF 时，原生 PDFium 在 partition+plugins 组合下注定渲染失败
         * （electron/electron#27121）。等 loadingFinished 而不是在 responseReceived 就动手，
         * 是为了拿到完整的 body 再读 —— 到那时原生渲染已经无从谈起，晚一点 stop 没有代价。
         *
         * Fix B: when the top-level navigation is a PDF, the native PDFium renderer is doomed
         * to fail under the partition+plugins combination (electron/electron#27121). Acting on
         * loadingFinished rather than responseReceived ensures the body is complete before it's
         * read — by then the native render is moot anyway, so acting late costs nothing.
         */
        if (method === 'Network.responseReceived') {
          const event = params as {
            type?: string;
            frameId?: string;
            requestId?: string;
            response?: { url?: string; mimeType?: string };
          };
          const pdf = pdfState.get(record.targetId);
          if (
            pdf &&
            isMainFramePdfResponse({
              type: event.type,
              frameId: event.frameId,
              mainFrameId: pdf.mainFrameId,
              mimeType: event.response?.mimeType,
            })
          ) {
            pdf.pendingPdfRequestId = event.requestId ?? null;
            pdf.pendingPdfUrl = event.response?.url ?? '';
          }
        }
        if (method === 'Network.loadingFinished') {
          const event = params as { requestId?: string };
          const pdf = pdfState.get(record.targetId);
          if (pdf?.pendingPdfRequestId && event.requestId === pdf.pendingPdfRequestId) {
            const requestId = pdf.pendingPdfRequestId;
            const url = pdf.pendingPdfUrl;
            pdf.pendingPdfRequestId = null;
            void handlePdfInterception(dbg, requestId, url);
          }
        }
        if (method === 'Network.loadingFailed') {
          const event = params as { requestId?: string };
          const pdf = pdfState.get(record.targetId);
          if (pdf && pdf.pendingPdfRequestId === event.requestId) pdf.pendingPdfRequestId = null;
        }
        for (const connection of connections) {
          const sessionId = connection.sessionByTarget.get(record.targetId);
          if (sessionId) send(connection.ws, { method, params: params ?? {}, sessionId });
        }
      };
      const onDestroyed = () => unregister(registration.webContentsId);
      contents.setWindowOpenHandler(({ url }) => {
        const policy = validateBrowserNavigation(url);
        if (policy.ok && options.onCreateTarget) {
          void options.onCreateTarget({ requestId: randomUUID(), url: policy.data.href });
        }
        return { action: 'deny' };
      });
      dbg.on('message', onMessage);
      contents.once('destroyed', onDestroyed);
      attached.set(record.targetId, { contents, dbg, onMessage, onDestroyed });
    }

    const info = targetInfo(registry.get(record.targetId));
    for (const connection of connections) {
      if (!previous && connection.discover && info) {
        send(connection.ws, { method: 'Target.targetCreated', params: { targetInfo: info } });
      }
      if (previous && connection.discover && info) {
        send(connection.ws, { method: 'Target.targetInfoChanged', params: { targetInfo: info } });
      }
      if (connection.autoAttach) emitAttached(connection, record.targetId);
    }
    if (registration.requestId) {
      pendingCreates.get(registration.requestId)?.(record.targetId);
      pendingCreates.delete(registration.requestId);
    }
    return { ok: true, targetId: record.targetId };
  };

  const waitForCreatedTarget = (requestId: string): Promise<string | null> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingCreates.delete(requestId);
        resolve(null);
      }, timeoutMs);
      pendingCreates.set(requestId, (targetId) => {
        clearTimeout(timer);
        resolve(targetId);
      });
    });

  const handleMessage = async (connection: ConnectionState, raw: string): Promise<void> => {
    let request: CdpRequest;
    try {
      request = JSON.parse(raw) as CdpRequest;
    } catch {
      return;
    }
    const { id, method = '', params = {}, sessionId } = request;
    const reply = (result: Record<string, unknown> = {}) => send(connection.ws, { id, result, sessionId });

    if (method === 'Target.setDiscoverTargets') {
      connection.discover = params.discover === true;
      reply();
      if (connection.discover) {
        for (const target of registry.list()) {
          send(connection.ws, { method: 'Target.targetCreated', params: { targetInfo: targetInfo(target) } });
        }
      }
      return;
    }
    if (method === 'Target.setAutoAttach') {
      if (sessionId) {
        reply();
        return;
      }
      connection.autoAttach = params.autoAttach !== false;
      reply();
      if (connection.autoAttach) for (const target of registry.list()) emitAttached(connection, target.targetId);
      return;
    }
    if (method === 'Target.getTargets') {
      reply({ targetInfos: registry.list().map((target) => targetInfo(target)) });
      return;
    }
    if (method === 'Target.getTargetInfo') {
      const requested = typeof params.targetId === 'string' ? params.targetId : registry.list()[0]?.targetId;
      const info = requested ? targetInfo(registry.get(requested)) : null;
      if (!info) sendError(connection.ws, id, unknownTargetError(requested ?? ''), sessionId);
      else reply({ targetInfo: info });
      return;
    }
    if (method === 'Target.getBrowserContexts') {
      reply({ browserContextIds: [BROWSER_CONTEXT_ID] });
      return;
    }
    if (method === 'Target.attachToTarget') {
      const targetId = typeof params.targetId === 'string' ? params.targetId : '';
      const routedSession = registry.get(targetId) ? emitAttached(connection, targetId) : null;
      if (!routedSession) sendError(connection.ws, id, unknownTargetError(targetId), sessionId);
      else reply({ sessionId: routedSession });
      return;
    }
    if (method === 'Target.detachFromTarget') {
      const routedSession = typeof params.sessionId === 'string' ? params.sessionId : sessionId;
      const targetId = routedSession ? connection.sessions.get(routedSession) : undefined;
      if (routedSession) connection.sessions.delete(routedSession);
      if (targetId) connection.sessionByTarget.delete(targetId);
      reply();
      return;
    }
    if (method === 'Target.createTarget') {
      const url = typeof params.url === 'string' ? params.url : 'about:blank';
      const policy = validateBrowserNavigation(url);
      if (policy.ok === false) {
        sendError(connection.ws, id, navigationBlockedError(policy.message), sessionId);
        return;
      }
      const requestId = randomUUID();
      if (!options.onCreateTarget) {
        sendError(connection.ws, id, targetCreateUnavailableError(), sessionId);
        return;
      }
      const waiting = waitForCreatedTarget(requestId);
      await options.onCreateTarget({ requestId, url: policy.data.href });
      const targetId = await waiting;
      if (!targetId) sendError(connection.ws, id, targetCreateTimeoutError(), sessionId);
      else reply({ targetId });
      return;
    }
    if (method === 'Target.activateTarget') {
      const targetId = typeof params.targetId === 'string' ? params.targetId : '';
      const target = registry.get(targetId);
      if (!target) sendError(connection.ws, id, unknownTargetError(targetId), sessionId);
      else {
        await options.onActivateTarget?.({ tabId: target.tabId, targetId, requestId: randomUUID() });
        reply();
      }
      return;
    }
    if (method === 'Target.closeTarget') {
      const targetId = typeof params.targetId === 'string' ? params.targetId : '';
      const target = registry.get(targetId);
      if (!target) sendError(connection.ws, id, unknownTargetError(targetId), sessionId);
      else {
        await options.onCloseTarget?.({ tabId: target.tabId, targetId, requestId: randomUUID() });
        reply({ success: true });
      }
      return;
    }
    if (
      method === 'Target.createBrowserContext' ||
      method === 'Target.disposeBrowserContext' ||
      method === 'Browser.close'
    ) {
      sendError(connection.ws, id, unsupportedBrowserCommandError(method), sessionId);
      return;
    }

    const targetId = sessionId ? connection.sessions.get(sessionId) : undefined;
    const state = targetId ? attached.get(targetId) : undefined;
    if (!state || state.contents.isDestroyed()) {
      sendError(connection.ws, id, noBrowserTargetError(), sessionId);
      return;
    }
    const capabilityBlock = blockedCdpCapability(method);
    if (capabilityBlock) {
      sendError(connection.ws, id, capabilityBlock, sessionId);
      return;
    }
    if (method === 'Page.bringToFront' && targetId) {
      const target = registry.get(targetId);
      if (target) await options.onActivateTarget?.({ tabId: target.tabId, targetId, requestId: randomUUID() });
      reply();
      return;
    }
    if (method === 'Page.navigate') {
      const requestedUrl = typeof params.url === 'string' ? params.url : '';
      const policy = validateBrowserNavigation(requestedUrl);
      if (policy.ok === false) {
        sendError(connection.ws, id, navigationBlockedError(policy.message), sessionId);
        return;
      }
      const retryAt = rateLimiter.blockedUntil(policy.data.href);
      if (retryAt) {
        sendError(connection.ws, id, rateLimitedNavigationError(retryAt), sessionId);
        return;
      }
      agentNavigatingWebContents.add(state.contents.id);
    }
    const blockReason = targetId && isWriteCommand(method) ? blockedWriteReason(targetId) : null;
    if (blockReason) {
      sendError(connection.ws, id, blockReason, sessionId);
      return;
    }
    const sensitiveReadReason = targetId ? blockedSensitiveReadReason(targetId, method) : null;
    if (sensitiveReadReason) {
      sendError(connection.ws, id, sensitiveReadReason, sessionId);
      return;
    }
    const execute = async (): Promise<void> => {
      try {
        const target = targetId ? registry.get(targetId) : null;
        if (target && isWriteCommand(method)) {
          options.onTargetActivityChanged?.({ tabId: target.tabId, targetId: target.targetId, active: true });
        }
        const result = (await state.dbg.sendCommand(method, params)) ?? {};
        reply(result as Record<string, unknown>);
      } catch (error) {
        sendError(connection.ws, id, error instanceof Error ? error.message : String(error), sessionId);
      } finally {
        const target = targetId ? registry.get(targetId) : null;
        if (target && isWriteCommand(method)) {
          options.onTargetActivityChanged?.({ tabId: target.tabId, targetId: target.targetId, active: false });
        }
      }
    };
    if (!targetId || !isWriteCommand(method)) {
      await execute();
      return;
    }
    const lease = coordinator.acquireWrite(targetId, {
      conversationId: connection.id,
      turnId: connection.id,
      controlSessionId: connection.id,
    });
    if (lease.ok === false) {
      sendError(connection.ws, id, `${lease.code}: ${lease.message}`, sessionId);
      return;
    }
    const previous = writeQueues.get(targetId) ?? Promise.resolve();
    const queued = previous.catch(() => {}).then(execute);
    writeQueues.set(targetId, queued);
    await queued;
    if (writeQueues.get(targetId) === queued) writeQueues.delete(targetId);
  };

  const httpServer: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    // Discovery is diagnostic only. The credential is inherited by the bundled
    // launcher and must never be disclosed through an unauthenticated endpoint.
    const wsUrl = `ws://${HOST}:${port}${WS_PATH}`;
    if (url.pathname === '/json/version') {
      writeJson(res, buildVersionPayload(wsUrl, process.versions.chrome ?? '0.0.0.0'));
      return;
    }
    if (url.pathname === '/json/list' || url.pathname === '/json') {
      writeJson(
        res,
        registry.list().map((target) => ({ ...targetInfo(target), id: target.targetId, webSocketDebuggerUrl: wsUrl }))
      );
      return;
    }
    res.writeHead(404).end('not found');
  });

  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    if (url.pathname !== WS_PATH || !tokensMatch(token, url.searchParams.get('token') ?? '')) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const connection: ConnectionState = {
        id: randomUUID(),
        ws,
        discover: false,
        autoAttach: false,
        sessions: new Map(),
        sessionByTarget: new Map(),
      };
      connections.add(connection);
      ws.on('message', (data) => void handleMessage(connection, data.toString()));
      const releaseConnection = () => {
        connections.delete(connection);
        coordinator.releaseAll(connection.id);
      };
      ws.on('close', releaseConnection);
      ws.on('error', releaseConnection);
      if (registry.list().length === 0) void options.onTargetRequired?.();
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, HOST, () => {
      const address = httpServer.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('Could not determine bridge port.'));
    });
  });

  return {
    port,
    token,
    attachedWebContentsId: () => registry.list().find((target) => target.active)?.webContentsId ?? null,
    targetCount: () => registry.list().length,
    attach: (webContentsId) => {
      const contents = webContents.fromId(webContentsId);
      if (!contents) return { ok: false, reason: 'Browser webContents is not available.' };
      const result = register({
        tabId: `legacy-${webContentsId}`,
        webContentsId,
        scopeId: 'legacy',
        title: contents.getTitle(),
        url: contents.getURL(),
        active: true,
      });
      return result.ok ? { ok: true } : result;
    },
    detach: (webContentsId) => {
      if (webContentsId !== undefined) unregister(webContentsId);
      else for (const target of registry.list()) unregister(target.webContentsId);
    },
    register,
    unregister,
    pause: (tabId) => {
      const target = registry.getByTab(tabId);
      if (!target) return false;
      coordinator.userTakeover(target.targetId);
      setControlState(target.targetId, 'userTakeover');
      return true;
    },
    resume: (tabId) => {
      const target = registry.getByTab(tabId);
      if (!target) return false;
      coordinator.resume(target.targetId);
      setControlState(target.targetId, 'ready');
      return true;
    },
    close: async () => {
      browserSession.webRequest.onBeforeRequest(null);
      browserSession.webRequest.onBeforeSendHeaders(null);
      for (const target of registry.list()) unregister(target.webContentsId);
      for (const resolve of pendingCreates.values()) resolve(null);
      pendingCreates.clear();
      for (const connection of connections) connection.ws.close();
      connections.clear();
      await new Promise<void>((resolve) => wss.close(() => httpServer.close(() => resolve())));
    },
  };
};
