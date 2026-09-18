/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 应用内浏览器的下载兜底。
 *
 * 为什么需要：Chromium 遇到不能内联渲染的响应（典型是带 Content-Disposition: attachment
 * 的 PDF）会把这次导航降级成下载。在此之前整个应用没有任何 will-download 处理，于是
 * 下载既不会保存、也不会报错 —— 页面留在原地，did-fail-load 报 ERR_ABORTED(-3) 被忽略，
 * 用户只看到一片空白。
 *
 * 这里负责下载链路的 IO 侧：落盘位置、重名消解、暂停/取消，以及把结果报给用户。
 * 「这次下载该不该存」的判断不在这里，而在 policies/downloadPolicy.ts —— 那一层是纯函数，
 * 可以脱离 Electron 单测，本文件只负责把它的结论执行出来。
 *
 * Download handling for the in-app browser.
 *
 * Why it exists: Chromium turns a navigation it cannot render inline (typically a PDF
 * served with Content-Disposition: attachment) into a download. Until now nothing in the
 * app handled will-download, so such a download was neither saved nor reported — the page
 * stayed put and did-fail-load reported ERR_ABORTED(-3), which is ignored, leaving the user
 * with a blank panel.
 *
 * This file owns the IO half of the download path: where the file lands, collision handling,
 * pausing and cancelling, and reporting the outcome. Whether a download should be saved at all
 * is decided in policies/downloadPolicy.ts — pure functions, unit-testable without Electron —
 * and this file only carries that verdict out.
 */

import { BROWSER_SESSION_PARTITION } from '@/common/config/constants';
import { app, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  createBrowserDownloadId,
  DEFAULT_MAX_DOWNLOAD_BYTES,
  evaluateBrowserDownload,
  isPdfDownload,
  stripBidiControls,
  type BrowserDownloadReason,
} from './policies/downloadPolicy';
import { isPathInsideRoot } from './policies/pathScope';

/** 下载结束状态 / Terminal state of a download. */
export type BrowserDownloadState = 'completed' | 'cancelled' | 'interrupted' | 'blocked';

export type BrowserDownloadEvent = {
  /** 稳定 id，整个生命周期不变 / Stable id, unchanged for the download's lifetime. */
  id: string;
  state: BrowserDownloadState;
  /** 最终落盘的文件名 / The file name actually written. */
  fileName: string;
  /** 仅 completed 时有值 / Present only when completed. */
  savePath?: string;
  /** 仅 blocked 时有值 / Present only when blocked. */
  reason?: BrowserDownloadReason | 'declined';
  /** 仅 completed 时有值：这个下载是不是 PDF / Present only when completed: whether this download is a PDF. */
  isPdf?: boolean;
};

/**
 * 需要用户点头时的询问入口。
 *
 * 由调用方注入而不是在这里直接弹窗：主进程没有 i18n，而这个问题必须用用户的语言问。
 * 返回 false 或抛错都按「拒绝」处理 —— 问不出来就不该替用户答应。
 *
 * The hook used to ask for approval, injected rather than raising a dialog here: the main process
 * has no i18n and this question has to be asked in the user's language. Both a false answer and a
 * thrown error count as a refusal — if the user cannot be asked, agreeing on their behalf is not
 * an option.
 */
export type BrowserDownloadConfirm = (request: {
  id: string;
  fileName: string;
  reason: 'executable' | 'script';
}) => Promise<boolean>;

/** 受控下载目录名，位于系统下载目录下 / Controlled sub-directory of the OS downloads folder. */
export const BROWSER_DOWNLOAD_DIR_NAME = 'AionUi';

/**
 * 文件名里不能出现的字符：Windows 非法字符，外加两种路径分隔符。
 * Characters a file name must not contain: the Windows-illegal set plus both separators.
 */
const ILLEGAL_FILE_NAME_CHARACTERS = new RegExp('[<>:"|?*/\\\\]', 'g');

/** Windows 保留设备名，作为文件名会直接失败 / Windows reserved device names — invalid as file names. */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * 文件名长度上限。文件系统限制通常是 255 字节，留出 " (999)" 和扩展名的余量。
 * Cap on file name length. Filesystems usually stop at 255 bytes; this leaves room for
 * a " (999)" disambiguation suffix and the extension.
 */
const MAX_FILE_NAME_LENGTH = 180;

/**
 * 把服务端给的文件名收紧成一个安全的路径片段。
 *
 * 这个名字完全由远端站点控制，所以按不可信输入处理：先取 basename 掐掉目录穿越，
 * 再替换掉各平台的非法字符与控制字符，最后处理 Windows 的保留名和结尾点号 ——
 * 这些在 Windows 上会让写入直接失败。
 *
 * Harden a server-supplied file name into one safe path segment. The name is entirely
 * controlled by the remote site, so it is treated as untrusted input: basename first to
 * defeat directory traversal, then illegal and control characters, then Windows reserved
 * names and trailing dots, which would otherwise make the write fail outright.
 */
export const safeDownloadFileName = (suggested: string): string => {
  const fallback = `download-${Date.now()}`;
  // Both separators, because a Windows-style name can arrive on POSIX and vice versa.
  const base = path.basename(suggested.replace(/\\/g, '/').split('/').pop() ?? '');
  /**
   * 控制字符按字符码过滤，而不是写进正则：控制字符类会触发 no-control-regex，
   * 而按码点过滤同样精确，也不会误伤中日韩等非 ASCII 文件名。
   *
   * Control characters are filtered by char code rather than folded into the regex: a
   * control-character class trips no-control-regex, while filtering by code point is just
   * as precise and leaves non-ASCII names (CJK and friends) intact.
   */
  /**
   * 双向文本控制字符先剥掉：它们不可见，却能让文件管理器把 `.exe` 显示成 `.pdf`，
   * 让用户看到的名字和磁盘上的名字不是同一个。剥掉之后扩展名策略读到的也是真实扩展名。
   *
   * Bidirectional controls come off first: they are invisible yet make a file manager render
   * `.exe` as `.pdf`, so the name the user reads is not the name on disk. Stripping them also
   * means the extension policy reads the real extension.
   */
  const printable = Array.from(stripBidiControls(base))
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join('');
  // Illegal on Windows, and the separators would re-introduce a path. Spaces and hyphens
  // are ordinary file-name characters and are deliberately left alone.
  const cleaned = printable
    .replace(ILLEGAL_FILE_NAME_CHARACTERS, '_')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim();
  if (!cleaned) return fallback;

  const extension = path.extname(cleaned);
  const stem = cleaned.slice(0, cleaned.length - extension.length);
  if (WINDOWS_RESERVED_NAME.test(stem)) return `_${cleaned}`;
  if (cleaned.length <= MAX_FILE_NAME_LENGTH) return cleaned;

  // Truncate the stem, never the extension: the extension is what decides how the file opens.
  const room = Math.max(1, MAX_FILE_NAME_LENGTH - extension.length);
  return `${stem.slice(0, room)}${extension}`;
};

/**
 * 重名时追加 `(1)`、`(2)`…，避免静默覆盖已有文件。
 *
 * `exists` 由调用方注入，这样这段逻辑可以脱离真实文件系统单测。
 *
 * Append `(1)`, `(2)`… on collision so an existing file is never silently overwritten.
 * `exists` is injected so this can be unit-tested without touching a real filesystem.
 */
export const ensureUniqueDownloadPath = (target: string, exists: (candidate: string) => boolean): string => {
  if (!exists(target)) return target;
  const directory = path.dirname(target);
  const extension = path.extname(target);
  const stem = path.basename(target, extension);
  for (let index = 1; index < 1000; index++) {
    const candidate = path.join(directory, `${stem} (${index})${extension}`);
    if (!exists(candidate)) return candidate;
  }
  return path.join(directory, `${stem}-${Date.now()}${extension}`);
};

/**
 * candidate 是否确实落在 directory 内部。
 *
 * 用于「在文件夹中显示」的入口：那个入口会把路径交给系统文件管理器，所以必须先确认
 * 它指向我们自己的下载目录，而不是渲染进程传来的任意路径。
 *
 * 判定本身在 policies/pathScope.ts —— 上传那条链路要做同样的包含性检查，两边共用一份
 * 实现，边界规则才不会各写各的。这里保留这个名字是因为它已经是对外 API。
 *
 * Whether `candidate` really sits inside `directory`. Used by the reveal entry point, which
 * hands a path to the OS file manager and must therefore confirm it points at our own downloads
 * directory rather than an arbitrary renderer-supplied path.
 *
 * The check itself lives in policies/pathScope.ts: the upload path needs the same containment
 * rule, and sharing one implementation is what keeps the two boundaries from drifting. This name
 * stays because it is already public API.
 */
export const isInsideDirectory = (directory: string, candidate: string): boolean =>
  isPathInsideRoot(directory, candidate);

/** 受控下载目录的绝对路径 / Absolute path of the controlled downloads directory. */
export const browserDownloadDirectory = (): string => path.join(app.getPath('downloads'), BROWSER_DOWNLOAD_DIR_NAME);

/**
 * 给应用内浏览器的 session 装上下载处理。
 *
 * 必须在 CDP 通道之外注册：用户关掉「允许 Agent 操作浏览器」时 startCdpBridge 整个不会
 * 执行（index.ts 里由 cdpStartupEnabled 包着），但浏览器 tab 照常可用，下载也照常会发生。
 *
 * Install download handling on the in-app browser's session. This must be registered
 * outside the CDP bridge: when the user turns off agent browser control, startCdpBridge is
 * never called at all (it sits behind cdpStartupEnabled in index.ts), yet Browser tabs keep
 * working and downloads keep happening.
 */
export const installBrowserDownloadPolicy = (
  onEvent: (event: BrowserDownloadEvent) => void,
  options: { confirm?: BrowserDownloadConfirm; maxBytes?: number } = {}
): void => {
  /**
   * 同 sessionGuards：session.fromPartition 在 app ready 之前会抛异常，而调用点
   * initApplicationBridge 早于 whenReady。推迟注册，而不是把调用点挪走。
   *
   * As in sessionGuards: session.fromPartition throws before the app is ready, and the call
   * site (initApplicationBridge) runs ahead of whenReady. Defer the registration rather than
   * move the call site.
   */
  if (!app.isReady()) {
    void app.whenReady().then(() => installBrowserDownloadPolicy(onEvent, options));
    return;
  }

  const browserSession = session.fromPartition(BROWSER_SESSION_PARTITION);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;

  browserSession.on('will-download', (_event, item) => {
    const id = createBrowserDownloadId();
    const fileName = safeDownloadFileName(item.getFilename());
    const mimeType = item.getMimeType();
    const isPdf = isPdfDownload(fileName, mimeType);
    const verdict = evaluateBrowserDownload({
      fileName,
      mimeType,
      totalBytes: item.getTotalBytes(),
      maxBytes,
    });

    if (verdict.action === 'block') {
      item.cancel();
      onEvent({ id, state: 'blocked', fileName, reason: verdict.reason });
      return;
    }

    let savePath: string | null = null;
    /**
     * 用户拒绝、或体积超限而取消的下载，`done` 会报 `cancelled`。那是一次被策略挡下的
     * 下载，不是「下载失败」，两者给用户的提示完全不同 —— 所以先记下原因，在 `done` 里
     * 用它把状态改写成 blocked。
     *
     * A download cancelled by a refusal or by the size cap reports `cancelled` from `done`.
     * That is a download stopped by policy rather than a failed one, and the two deserve
     * different messages — so the reason is recorded here and used in `done` to rewrite the
     * state as blocked.
     */
    let blockedReason: BrowserDownloadEvent['reason'] | null = null;

    try {
      const directory = browserDownloadDirectory();
      fs.mkdirSync(directory, { recursive: true });
      savePath = ensureUniqueDownloadPath(path.join(directory, fileName), (candidate) => fs.existsSync(candidate));
      /**
       * 设了保存路径，系统「另存为」对话框就不会弹出来。不设的话 Electron 会弹一个
       * 原生对话框 —— 对 Agent 驱动的导航来说，那等于凭空冒出一个用户没预期的窗口。
       *
       * Setting the save path suppresses the native Save As dialog. Without it Electron
       * shows one, which for an agent-driven navigation means a window the user never
       * asked for appearing out of nowhere.
       */
      item.setSavePath(savePath);
    } catch {
      // Fall through: the download still runs, and `done` reports whatever happened.
    }

    /**
     * Content-Length 可以缺失，也可以撒谎。事前判定挡不住「声明 1 KB 然后一直传」，
     * 只有边收边量才行 —— 否则磁盘会被一个 Agent 无意触发的下载写满。
     *
     * Content-Length can be absent and can lie. The up-front check cannot stop a response that
     * declares 1 KB and then streams without end; only measuring as bytes arrive can, and
     * without it an agent-triggered download can fill the disk.
     */
    item.on('updated', () => {
      if (blockedReason || item.getReceivedBytes() <= maxBytes) return;
      blockedReason = 'tooLarge';
      item.cancel();
    });

    item.once('done', (_doneEvent, state) => {
      const resolved: BrowserDownloadState = blockedReason
        ? 'blocked'
        : state === 'completed'
          ? 'completed'
          : state === 'cancelled'
            ? 'cancelled'
            : 'interrupted';
      onEvent({
        id,
        state: resolved,
        fileName,
        savePath: resolved === 'completed' && savePath ? savePath : undefined,
        reason: blockedReason ?? undefined,
        isPdf: resolved === 'completed' ? isPdf : undefined,
      });
      // 被挡下的下载已经写了一截，留在下载目录里既占空间，又会让用户以为文件是完整的。
      // A blocked download has already written a partial file; leaving it costs space and makes
      // the user believe they have the whole thing.
      if (blockedReason && savePath) {
        try {
          fs.rmSync(savePath, { force: true });
        } catch {
          // Best effort: an undeletable partial file is not worth failing the event for.
        }
      }
    });

    if (verdict.action !== 'confirm') return;

    const confirm = options.confirm;
    const reason = verdict.reason === 'script' ? 'script' : 'executable';
    if (!confirm) {
      blockedReason = 'declined';
      item.cancel();
      return;
    }

    /**
     * 暂停再问。不暂停的话下载会在用户思考期间跑完，`cancel()` 就成了空操作 ——
     * 文件已经在磁盘上了，确认框变成一个纯粹的表演。
     *
     * Pause, then ask. Without pausing the download finishes while the user is deciding and
     * `cancel()` becomes a no-op — the file is already on disk and the confirmation was pure
     * theatre.
     */
    item.pause();
    void confirm({ id, fileName, reason })
      .catch(() => false)
      .then((allowed) => {
        try {
          // 用户在回答期间可能已经关掉了 tab，此时 DownloadItem 早已结束。
          // The user may have closed the tab while deciding, in which case the item is long done.
          if (item.getState() !== 'progressing') return;
          if (allowed) {
            item.resume();
            return;
          }
          blockedReason = 'declined';
          item.cancel();
        } catch {
          // The underlying item is gone; `done` has already reported the outcome.
        }
      });
  });
};
