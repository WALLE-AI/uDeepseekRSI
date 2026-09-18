/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BrowserWindow } from 'electron';
import { app, session, shell } from 'electron';
import { ipcBridge } from '@/common';
import { BROWSER_SESSION_PARTITION } from '@/common/config/constants';
import {
  browserDownloadDirectory,
  installBrowserDownloadPolicy,
  isInsideDirectory,
} from '@process/services/browser-control/browserDownloads';
import { getManagedBrowserCredentialStore } from '@process/services/browser-control/managedCredentialStore';
import { installBrowserSessionGuards } from '@process/services/browser-control/sessionGuards';
import { ProcessConfig } from '@process/utils/initStorage';
import { getZoomFactor, setZoomFactor } from '@process/utils/zoom';
import { getCdpStatus, updateCdpConfig } from '@process/utils/configureChromium';
import { getCdpBridgeHandle } from '@process/utils/cdpBridgeRegistry';
import { getGpuStatus, setGpuUserOverride } from '@process/utils/gpuRecovery';
import { initApplicationBridgeCore } from './applicationBridgeCore';
import type { IStartOnBootStatus } from '@/common/adapter/ipcBridge';
import { restartApplication } from './restartApplication';

let mainWindowRef: BrowserWindow | null = null;

/**
 * 等待用户答复的下载确认，按 download id 索引。
 *
 * 超时是必需的，不是保险措施：渲染进程崩掉、窗口被关掉、或者用户干脆没看见通知，
 * 这个 Promise 就永远不会 resolve，而挂在它后面的是一个暂停中的 DownloadItem。
 * 到点按「拒绝」处理 —— 没人回答不等于同意。
 *
 * Download confirmations awaiting the user's answer, keyed by download id. The timeout is a
 * requirement rather than a safety net: if the renderer crashes, the window is closed, or the
 * user simply never sees the prompt, the promise never settles and a paused DownloadItem hangs
 * off it. Expiry counts as a refusal — nobody answering is not the same as agreeing.
 */
const pendingDownloadConfirmations = new Map<string, (allowed: boolean) => void>();

const DOWNLOAD_CONFIRMATION_TIMEOUT_MS = 2 * 60 * 1000;

const START_ON_BOOT_UNSUPPORTED_MESSAGE = 'Start on boot is only available in packaged macOS and Windows apps.';
export const START_ON_BOOT_WINDOWS_ARG = '--start-on-boot';

const isStartOnBootSupported = (): boolean => {
  return app.isPackaged && (process.platform === 'darwin' || process.platform === 'win32');
};

const getStartOnBootWindowsArgs = (): string[] => [START_ON_BOOT_WINDOWS_ARG];

const getLoginItemSettings = () => {
  return process.platform === 'win32'
    ? app.getLoginItemSettings({ args: getStartOnBootWindowsArgs() })
    : app.getLoginItemSettings();
};

export function wasLaunchedAtLogin(): boolean {
  if (!app.isPackaged) {
    return false;
  }

  if (process.platform === 'darwin') {
    return Boolean(getLoginItemSettings().wasOpenedAtLogin);
  }

  if (process.platform === 'win32') {
    return process.argv.includes(START_ON_BOOT_WINDOWS_ARG);
  }

  return false;
}

export function getStartOnBootStatus(): IStartOnBootStatus {
  if (!isStartOnBootSupported()) {
    return {
      supported: false,
      enabled: false,
      isPackaged: app.isPackaged,
      platform: process.platform,
    };
  }

  const settings = getLoginItemSettings();
  const enabled =
    process.platform === 'win32'
      ? Boolean(settings.openAtLogin || settings.executableWillLaunchAtLogin)
      : Boolean(settings.openAtLogin);

  return {
    supported: true,
    enabled,
    isPackaged: app.isPackaged,
    platform: process.platform,
  };
}

export function setStartOnBootEnabled(enabled: boolean): IStartOnBootStatus {
  const currentStatus = getStartOnBootStatus();
  if (!currentStatus.supported) {
    return currentStatus;
  }

  app.setLoginItemSettings({
    openAtLogin: enabled,
    ...(process.platform === 'win32'
      ? {
          args: getStartOnBootWindowsArgs(),
          enabled: true,
        }
      : {}),
  });

  return getStartOnBootStatus();
}

export function setApplicationMainWindow(win: BrowserWindow): void {
  mainWindowRef = win;
}

export function initApplicationBridge(): void {
  // Platform-agnostic handlers: systemInfo, updateSystemInfo, getPath
  initApplicationBridgeCore();

  /**
   * 下载处理装在这里，而不是 CDP 通道里：用户关掉「允许 Agent 操作浏览器」时
   * startCdpBridge 整个不会执行，但浏览器 tab 照常能用、下载照常会发生。
   * initApplicationBridge 是无条件调用的，所以这条策略始终生效。
   *
   * Download handling is installed here rather than in the CDP bridge: with agent browser
   * control switched off, startCdpBridge never runs at all, yet Browser tabs keep working
   * and downloads keep happening. initApplicationBridge is called unconditionally, so this
   * policy always applies.
   */
  installBrowserDownloadPolicy(
    (event) => {
      ipcBridge.preview.browserDownloadLocal.emit(event);
    },
    {
      confirm: (request) =>
        new Promise<boolean>((resolve) => {
          // 一次性 settle：超时和用户答复可能同时到，第二次调用必须是空操作。
          // Settle once: the timeout and the user's answer can race, and the second must be a no-op.
          let settled = false;
          const finish = (allowed: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            pendingDownloadConfirmations.delete(request.id);
            resolve(allowed);
          };
          const timer = setTimeout(() => finish(false), DOWNLOAD_CONFIRMATION_TIMEOUT_MS);
          pendingDownloadConfirmations.set(request.id, finish);
          ipcBridge.preview.browserDownloadConfirmLocal.emit(request);
        }),
    }
  );

  /**
   * 权限、证书和重定向闸门，和下载策略同理，装在无条件执行的地方。
   * 之前它们在 startCdpBridge 里，于是关掉 Agent 浏览器控制之后整个 partition 上
   * 一个权限处理器都没有 —— Electron 的默认是授予。
   *
   * Permission, certificate, and redirect gates, installed unconditionally for the same reason as
   * the download policy. They used to live in startCdpBridge, which meant that switching agent
   * browser control off left the partition with no permission handler at all — and Electron's
   * default is to grant.
   */
  installBrowserSessionGuards();

  ipcBridge.application.resolveBrowserDownload.provider(async ({ id, allow }) => {
    const pending = pendingDownloadConfirmations.get(id);
    // 没有对应项说明已经超时或已经答复过了，直接返回成功：渲染进程无事可做。
    // No entry means it already timed out or was already answered; report success, since there
    // is nothing for the renderer to do about it either way.
    pending?.(allow);
    return { success: true };
  });

  ipcBridge.application.restart.provider(async () => {
    // Backend subprocess shutdown is handled by backendManager.stop() in the
    // main window's before-quit hook; agent children are killed transitively
    // when backend exits.
    return restartApplication(app);
  });

  ipcBridge.application.isDevToolsOpened.provider(() => {
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      return Promise.resolve(mainWindowRef.webContents.isDevToolsOpened());
    }
    return Promise.resolve(false);
  });

  ipcBridge.application.openDevTools.provider(() => {
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      const win = mainWindowRef;
      const wasOpen = win.webContents.isDevToolsOpened();

      if (wasOpen) {
        win.webContents.closeDevTools();
        return Promise.resolve(false);
      } else {
        return new Promise((resolve) => {
          const onOpened = () => {
            win.webContents.off('devtools-opened', onOpened);
            resolve(true);
          };

          win.webContents.once('devtools-opened', onOpened);
          win.webContents.openDevTools();

          setTimeout(() => {
            win.webContents.off('devtools-opened', onOpened);
            if (win.isDestroyed()) {
              resolve(false);
              return;
            }
            resolve(win.webContents.isDevToolsOpened());
          }, 500);
        });
      }
    }
    return Promise.resolve(false);
  });

  ipcBridge.application.getZoomFactor.provider(() => Promise.resolve(getZoomFactor()));

  ipcBridge.application.setZoomFactor.provider(async ({ factor }) => {
    const updatedFactor = setZoomFactor(factor);
    try {
      await ProcessConfig.set('ui.zoomFactor', updatedFactor);
    } catch (error) {
      console.error('[ApplicationBridge] Failed to persist zoom factor:', error);
    }
    return updatedFactor;
  });

  ipcBridge.application.writeRendererLog.provider(async ({ level, tag, message, data }) => {
    const prefix = `[Renderer:${tag}] ${message}`;
    const args = data === undefined ? [prefix] : [prefix, data];
    if (level === 'error') {
      console.error(...args);
    } else if (level === 'warn') {
      console.warn(...args);
    } else if (level === 'debug') {
      console.debug(...args);
    } else {
      console.info(...args);
    }
  });

  // CDP status and configuration
  ipcBridge.application.getCdpStatus.provider(async () => {
    try {
      const status = getCdpStatus();
      const handle = getCdpBridgeHandle();
      const targetCount = handle?.targetCount() ?? 0;
      return {
        success: true,
        data: {
          ...status,
          health: !status.enabled ? 'disabled' : targetCount > 0 ? 'ready' : 'noTarget',
          targetCount,
        },
      };
    } catch (e) {
      return { success: false, msg: e.message || e.toString() };
    }
  });

  ipcBridge.application.updateCdpConfig.provider(async (config) => {
    try {
      const updatedConfig = updateCdpConfig(config);
      return { success: true, data: updatedConfig };
    } catch (e) {
      return { success: false, msg: e.message || e.toString() };
    }
  });

  /**
   * 清空应用内浏览器的登录态与缓存。
   *
   * 登录态是全局共享的（所有 tab、所有项目共用一个 partition），所以这里是唯一
   * 的"退出全部网站"入口。已打开的浏览器 tab 需要刷新后才会体现，这在设置项的
   * 说明文案里告诉用户。
   *
   * Clear the in-app browser's sign-in state and cache. Sign-in state is globally
   * shared (one partition across all tabs and projects), so this is the only way
   * to sign out everywhere. Already-open browser tabs reflect it after a reload,
   * which the settings copy tells the user.
   */
  ipcBridge.application.clearBrowserData.provider(async () => {
    try {
      const browserSession = session.fromPartition(BROWSER_SESSION_PARTITION);
      // clearStorageData 只清 cookie 和各类 storage，不含 HTTP 缓存和认证缓存 ——
      // 而设置里的文案承诺了「清理缓存」，所以三个都要清。
      //
      // clearStorageData covers cookies and storages but neither the HTTP cache nor
      // the HTTP auth cache, and the settings copy promises the cache is cleared.
      await browserSession.clearStorageData();
      await browserSession.clearCache();
      await browserSession.clearAuthCache();
      return { success: true };
    } catch (e) {
      return { success: false, msg: e instanceof Error ? e.message : String(e) };
    }
  });

  /**
   * 只允许显示受控下载目录里的文件。
   *
   * 渲染进程传来的路径不能直接交给系统文件管理器：那等于给了任意路径一个「在资源管理器
   * 里打开」的能力。这里用 isInsideDirectory 做包含性校验（已 resolve，且拒绝 `..`
   * 逃逸和 `AionUi-evil` 这类前缀同名目录），只有确实是我们刚存下去的文件才放行。
   * 不用 shell.openPath：那会直接执行下载下来的文件。
   *
   * Only files inside the controlled downloads directory may be revealed. A
   * renderer-supplied path cannot go straight to the OS file manager — that would grant
   * "show me any path" to the renderer. isInsideDirectory performs a resolved containment
   * check that rejects `..` escapes and prefix-sharing siblings like `AionUi-evil`, so only
   * a file we actually saved gets through. Deliberately not shell.openPath, which would
   * execute the downloaded file.
   */
  ipcBridge.application.revealBrowserDownload.provider(async ({ savePath }) => {
    try {
      if (!savePath || !isInsideDirectory(browserDownloadDirectory(), savePath)) {
        return { success: false, msg: 'The path is outside the browser downloads directory.' };
      }
      shell.showItemInFolder(savePath);
      return { success: true };
    } catch (e) {
      return { success: false, msg: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcBridge.application.reportBrowserWebContentsId.provider(async (registration) => {
    /**
     * 把单目标 CDP 通道附加到侧边浏览器。
     *
     * 每次浏览器 tab 切换都会重报一次：通道同时只服务一个目标，切换即改附加对象，
     * 这样 Agent 操作的始终是用户当前看到的那个页面。多 tab 情况下这是刻意的取舍 ——
     * 与其同时暴露 10 个 webContents，不如只暴露活跃的那一个。
     *
     * Attaches the single-target CDP bridge to the in-app browser. Re-reported on every
     * browser tab switch: the bridge serves one target at a time, so switching re-points
     * it and the agent always drives the page the user is actually looking at. With
     * multiple tabs this is a deliberate trade-off — exposing only the active webContents
     * rather than all ten at once.
     */
    try {
      const handle = getCdpBridgeHandle();
      if (!handle) return { success: false, msg: 'Agent browser control is not enabled.' };
      const result = handle.register(registration);
      if (result.ok === false) return { success: false, msg: result.reason };
      console.log(`[CDP] Registered Browser target ${result.targetId} for tab ${registration.tabId}.`);
      return { success: true, data: { targetId: result.targetId } };
    } catch (e) {
      return { success: false, msg: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcBridge.application.detachBrowserWebContentsId.provider(async ({ webContentsId }) => {
    try {
      const handle = getCdpBridgeHandle();
      if (!handle) return { success: true };
      handle.unregister(webContentsId);
      return { success: true };
    } catch (e) {
      return { success: false, msg: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcBridge.application.pauseBrowserTarget.provider(async ({ tabId }) => {
    const handle = getCdpBridgeHandle();
    if (!handle) return { success: false, msg: 'Agent browser control is not enabled.' };
    return handle.pause(tabId) ? { success: true } : { success: false, msg: 'Browser target is not available.' };
  });

  ipcBridge.application.resumeBrowserTarget.provider(async ({ tabId }) => {
    const handle = getCdpBridgeHandle();
    if (!handle) return { success: false, msg: 'Agent browser control is not enabled.' };
    return handle.resume(tabId) ? { success: true } : { success: false, msg: 'Browser target is not available.' };
  });

  ipcBridge.application.listManagedBrowserCredentials.provider(async () => {
    try {
      return { success: true, data: await getManagedBrowserCredentialStore().list() };
    } catch (error) {
      return { success: false, msg: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcBridge.application.saveManagedBrowserCredential.provider(async (credential) => {
    try {
      const id = await getManagedBrowserCredentialStore().save(credential);
      return { success: true, data: { id } };
    } catch (error) {
      return { success: false, msg: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcBridge.application.removeManagedBrowserCredential.provider(async ({ id }) => {
    try {
      await getManagedBrowserCredentialStore().remove(id);
      return { success: true };
    } catch (error) {
      return { success: false, msg: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcBridge.application.getStartOnBootStatus.provider(async () => {
    try {
      return { success: true, data: getStartOnBootStatus() };
    } catch (e) {
      return { success: false, msg: e.message || e.toString() };
    }
  });

  ipcBridge.application.setStartOnBoot.provider(async ({ enabled }) => {
    try {
      const status = setStartOnBootEnabled(enabled);
      if (!status.supported) {
        return { success: false, msg: START_ON_BOOT_UNSUPPORTED_MESSAGE, data: status };
      }
      return { success: true, data: status };
    } catch (e) {
      return { success: false, msg: e.message || e.toString() };
    }
  });

  ipcBridge.application.getGpuStatus.provider(async () => {
    try {
      return { success: true, data: getGpuStatus() };
    } catch (e) {
      return { success: false, msg: e.message || e.toString() };
    }
  });

  ipcBridge.application.setGpuOverride.provider(async ({ override }) => {
    try {
      return { success: true, data: setGpuUserOverride(override) };
    } catch (e) {
      return { success: false, msg: e.message || e.toString() };
    }
  });
}
