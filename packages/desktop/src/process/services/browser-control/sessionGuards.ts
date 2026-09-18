/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 应用内浏览器 session 上的安全闸门。
 *
 * 这里装的是权限、导航、重定向和证书这四类处理器 —— 全都装在 CDP 通道之外，理由和下载
 * 处理一样，而且更要紧：之前这几个处理器只在 startCdpBridge 里注册，而那个函数被
 * `cdpStartupEnabled` 包着。也就是说用户一旦关掉「允许 Agent 操作浏览器」，浏览器 tab
 * 照常能用，但 `persist:aionui-browser` 这个 partition 上一个权限处理器都没有 ——
 * Electron 的默认行为是**授予**，于是关掉 Agent 控制反而让网页更容易拿到摄像头和麦克风。
 * 装在这里之后，这些闸门与 Agent 控制开关无关，始终生效。
 *
 * 具体的判定逻辑一概不在本文件，而在 policies/ 下的纯函数里；这里只负责把它们接到
 * Electron 的事件上，并把副作用执行出来。
 *
 * Security gates installed on the in-app browser's session: permissions, navigation, redirects,
 * and certificates. All of them live outside the CDP bridge for the same reason download handling
 * does, only more urgently — until now they were registered inside startCdpBridge, which sits
 * behind `cdpStartupEnabled`. With agent browser control switched off, Browser tabs kept working
 * while the `persist:aionui-browser` partition had no permission handler at all, and Electron's
 * default is to *grant*. Turning agent control off therefore made it easier, not harder, for a
 * page to reach the camera and microphone. Installed here, these gates hold regardless of that
 * switch.
 *
 * No decision is made in this file. The judgements are pure functions under policies/; this only
 * wires them to Electron's events and carries out the effects.
 */

import { BROWSER_SESSION_PARTITION } from '@/common/config/constants';
import { app, session, type WebContents } from 'electron';
import { evaluateCertificateError } from './policies/dialogPolicy';
import {
  classifyHostname,
  describeNetworkZone,
  evaluateRedirect,
  type BrowserNetworkZone,
} from './policies/networkPolicy';
import { classifyBrowserPermission, resolveSyncPermission } from './policies/permissionPolicy';

/** 一次被闸门挡下的操作，供上层告知用户 / A blocked action, for the layer above to surface. */
export type BrowserGuardEvent = {
  kind: 'navigation' | 'redirect' | 'certificate' | 'permission';
  url: string;
  message: string;
};

export type BrowserSessionGuardOptions = {
  /**
   * 用户授权过的内网 origin。以函数形式传入而不是一个集合快照：授权可以在运行期变，
   * 快照会让闸门停留在装配那一刻的状态。
   *
   * Origins the user allowed to reach private addresses. Passed as a function rather than as a
   * snapshot set, because the grant can change at runtime and a snapshot would freeze the gate
   * at the moment it was installed.
   */
  allowedPrivateOrigins?: () => ReadonlySet<string>;
  onBlocked?: (event: BrowserGuardEvent) => void;
};

const hostnameOf = (rawUrl: string): string => {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return rawUrl;
  }
};

export const installBrowserSessionGuards = (options: BrowserSessionGuardOptions = {}): void => {
  /**
   * session.fromPartition 在 app ready 之前会抛 "Session can only be received when app is
   * ready"，而 initApplicationBridge 是在 main 进程模块加载时调用的，早于 whenReady。
   * 把注册推迟到 ready，而不是把调用点挪走：调用方不必关心自己处在启动的哪个阶段。
   * 推迟不会漏事件 —— 任何 webContents 和任何 session 都只可能在 ready 之后出现。
   *
   * session.fromPartition throws "Session can only be received when app is ready" before the
   * app is ready, and initApplicationBridge is called at main-process module load, ahead of
   * whenReady. The registration is deferred rather than the call site moved, so callers need
   * not know which point of startup they are at. Nothing is missed by deferring: no webContents
   * and no session can exist before ready.
   */
  if (!app.isReady()) {
    void app.whenReady().then(() => installBrowserSessionGuards(options));
    return;
  }

  const browserSession = session.fromPartition(BROWSER_SESSION_PARTITION);
  const allowedPrivateOrigins = () => options.allowedPrivateOrigins?.() ?? new Set<string>();
  const report = (event: BrowserGuardEvent) => options.onBlocked?.(event);

  /**
   * 权限：`ask` 在这两个 handler 里都落到「拒绝」。
   *
   * setPermissionCheckHandler 是同步的，本来就没有询问用户的机会；
   * setPermissionRequestHandler 虽然是异步的，但目前还没有询问用户的界面，
   * 所以只有 policies 里判为 `allow` 的能力（不碰设备、不碰数据的那些）会通过。
   * 这是保守的一侧：没问过的权限不算已授予。
   *
   * Permissions: `ask` resolves to a refusal in both handlers. setPermissionCheckHandler is
   * synchronous and has no opportunity to ask; setPermissionRequestHandler is asynchronous but
   * there is not yet any UI to ask with, so only the capabilities the policy grades as `allow` —
   * those touching no device and no data — get through. That is the conservative side: a
   * permission nobody was asked about is not granted.
   */
  browserSession.setPermissionCheckHandler((_contents, permission) => resolveSyncPermission(permission));
  browserSession.setPermissionRequestHandler((_contents, permission, callback) => {
    const verdict = classifyBrowserPermission(permission);
    if (verdict.decision !== 'allow' && verdict.prompt) {
      report({ kind: 'permission', url: '', message: `A page was not allowed to ${verdict.prompt}.` });
    }
    callback(verdict.decision === 'allow');
  });

  /**
   * 证书错误：永远不放行。
   *
   * `event.preventDefault()` + `callback(true)` 是 Electron 应用里最常见的一行
   * 「先让它跑起来」，而它等于把这个 partition 上的 HTTPS 全部降级成可被中间人改写。
   * 这里 preventDefault 只是为了接管默认行为，答复始终是 false。
   *
   * Certificate errors are never waved through. `event.preventDefault()` followed by
   * `callback(true)` is the most common line of make-it-work code in Electron apps, and it
   * downgrades every HTTPS connection on this partition to one a middlebox can rewrite.
   * preventDefault here only takes over the default handling; the answer is always false.
   */
  app.on('certificate-error', (event, contents, url, error, _certificate, callback) => {
    if (contents.session !== browserSession) return;
    event.preventDefault();
    const verdict = evaluateCertificateError({ error, hostname: hostnameOf(url), agentInitiated: true });
    callback(false);
    report({ kind: 'certificate', url, message: verdict.message });
  });

  const guardNavigation = (contents: WebContents): void => {
    /**
     * 首次导航只挡一类地址：云元数据端点和链路本地地址。
     *
     * 这里刻意比 {@link evaluateNetworkTarget} 宽。那个函数服务的是 Agent 发起的导航，
     * 默认拒绝 loopback 和内网是对的；但 will-navigate 上跑的多数是用户自己的操作，
     * 用同一套判定会把「在应用内浏览器里打开 localhost:3000 看看自己的开发服务器」
     * 一起挡掉 —— 那是这个浏览器本来就该能做的事。
     *
     * 留下的这一类不一样：169.254.169.254 这样的地址没有任何「用户想看看」的读法，
     * 它只在一种情况下被访问，就是有人在偷云凭证。
     *
     * The initial navigation blocks one category only: cloud metadata endpoints and link-local
     * addresses. This is deliberately more permissive than {@link evaluateNetworkTarget}, which
     * serves agent-initiated navigation where refusing loopback and private ranges by default is
     * right. Most of what reaches will-navigate is the user's own action, and applying the same
     * rule would also block opening localhost:3000 to look at one's own dev server — something
     * this browser is supposed to be able to do. The remaining category is different: an address
     * like 169.254.169.254 has no "the user wanted to look at it" reading, and is visited in one
     * situation only, which is someone stealing cloud credentials.
     */
    contents.on('will-navigate', (event, url) => {
      let zone: BrowserNetworkZone;
      try {
        zone = classifyHostname(new URL(url).hostname);
      } catch {
        return;
      }
      if (zone !== 'metadata' && zone !== 'linkLocal') return;
      event.preventDefault();
      report({ kind: 'navigation', url, message: describeNetworkZone(zone) });
    });

    /**
     * 重定向单独查一遍，而且比首次导航更严。
     *
     * 首次导航的地址是用户或 Agent 明确给出的，重定向的落点则完全由远端决定 ——
     * 一个公网页面可以用 302 把浏览器指向 127.0.0.1，借这一跳读到本机服务。
     * 所以这里用 evaluateRedirect：从公网跳进内网一律拒绝，哪怕落点 origin 在白名单里。
     *
     * Redirects are checked separately and more strictly than the initial navigation. The first
     * address was named explicitly by the user or the agent, whereas a redirect's destination is
     * chosen entirely by the remote end — a public page can 302 the browser to 127.0.0.1 and
     * read a local service through that hop. evaluateRedirect therefore refuses any public ->
     * private hop, allowlisted destination or not.
     */
    contents.on('will-redirect', (event, url) => {
      const verdict = evaluateRedirect(contents.getURL(), url, {
        allowedPrivateOrigins: allowedPrivateOrigins(),
      });
      if (verdict.allowed !== false) return;
      event.preventDefault();
      report({ kind: 'redirect', url, message: verdict.reason });
    });
  };

  /**
   * 逐个 webContents 挂，而不是在 session 上挂一次：导航事件是 webContents 级的，
   * session 上没有对应事件。用 session 身份比较来筛选 —— Electron 对同一个 partition
   * 返回同一个 Session 对象，所以引用相等就是可靠的判据。
   *
   * Hooked per webContents rather than once on the session, because navigation events are
   * webContents-level and the session has no equivalent. Membership is decided by session
   * identity: Electron returns the same Session object for a given partition, so reference
   * equality is a reliable test.
   */
  app.on('web-contents-created', (_event, contents) => {
    if (contents.session !== browserSession) return;
    guardNavigation(contents);
  });
};
