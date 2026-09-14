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
 * 用户只看到一片空白。这里不实现完整的下载工作流（那是执行方案里的 PR 10），只做一件事：
 * 让结果可见 —— 存到受控目录，然后把结果告诉用户。
 *
 * Download fallback for the in-app browser.
 *
 * Why it exists: Chromium turns a navigation it cannot render inline (typically a PDF
 * served with Content-Disposition: attachment) into a download. Until now nothing in the
 * app handled will-download, so such a download was neither saved nor reported — the page
 * stayed put and did-fail-load reported ERR_ABORTED(-3), which is ignored, leaving the user
 * with a blank panel. This is not the full download workflow (that is PR 10 of the
 * execution plan); it does one thing: make the outcome visible by saving to a controlled
 * directory and reporting what happened.
 */

import { BROWSER_SESSION_PARTITION } from '@/common/config/constants';
import { app, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/** 下载结束状态 / Terminal state of a download. */
export type BrowserDownloadState = 'completed' | 'cancelled' | 'interrupted';

export type BrowserDownloadEvent = {
  state: BrowserDownloadState;
  /** 最终落盘的文件名 / The file name actually written. */
  fileName: string;
  /** 仅 completed 时有值 / Present only when completed. */
  savePath?: string;
};

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
  const printable = Array.from(base)
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
 * 它指向我们自己的下载目录，而不是渲染进程传来的任意路径。先 resolve 再比较，
 * 并要求带上分隔符，否则 `/downloads/AionUi-evil` 会被 `/downloads/AionUi` 前缀匹配放行。
 *
 * Whether `candidate` really sits inside `directory`. Used by the reveal entry point,
 * which hands a path to the OS file manager and must therefore confirm it points at our
 * own downloads directory rather than an arbitrary renderer-supplied path. Paths are
 * resolved before comparison and the separator is required, otherwise
 * `/downloads/AionUi-evil` would pass a prefix match against `/downloads/AionUi`.
 */
export const isInsideDirectory = (directory: string, candidate: string): boolean => {
  const root = path.resolve(directory);
  const resolved = path.resolve(candidate);
  if (resolved === root) return false;
  const relative = path.relative(root, resolved);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

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
export const installBrowserDownloadPolicy = (onEvent: (event: BrowserDownloadEvent) => void): void => {
  const browserSession = session.fromPartition(BROWSER_SESSION_PARTITION);

  browserSession.on('will-download', (_event, item) => {
    const fileName = safeDownloadFileName(item.getFilename());
    let savePath: string | null = null;

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

    item.once('done', (_doneEvent, state) => {
      const resolved: BrowserDownloadState =
        state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted';
      onEvent({
        state: resolved,
        fileName,
        savePath: resolved === 'completed' && savePath ? savePath : undefined,
      });
    });
  });
};
