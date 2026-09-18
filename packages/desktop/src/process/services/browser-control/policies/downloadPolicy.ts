/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 下载准入策略。
 *
 * 应用内浏览器的下载和普通浏览器的下载有两个差别，都指向同一个结论：不能默认放行。
 * 其一，导航可能是 Agent 发起的，用户根本没按过任何「下载」按钮；其二，文件落在一个
 * 用户不一定会去看的受控目录里，一个恶意文件可以在那里安静地躺很久。
 *
 * 所以这里按「文件会造成什么后果」分级，而不是按「文件是什么类型」：
 *
 * - 可执行文件 / 脚本 —— 双击即运行，必须由用户确认；
 * - 超过体积上限 —— 直接拒绝，理由是磁盘和主进程，不是安全；
 * - 其余 —— 放行。
 *
 * 判定全部基于最终落盘的文件名，而不是 Content-Type：服务端给的 MIME 完全可以撒谎，
 * 而决定双击行为的是扩展名。MIME 只用来加一条判据，不用来放宽。
 *
 * Admission policy for downloads. Two things separate an in-app browser download from an
 * ordinary one, and both point the same way: it cannot be allowed by default. The navigation may
 * have been initiated by the agent, with the user never having pressed anything resembling a
 * download button; and the file lands in a controlled directory the user has no particular reason
 * to look at, where a hostile file can sit quietly for a long time.
 *
 * Grading is therefore by consequence rather than by file kind: anything that runs on
 * double-click needs the user's confirmation; anything over the size cap is refused outright (for
 * the sake of the disk and the main process, not for security); everything else is allowed.
 *
 * Every judgement is made on the file name that will actually be written rather than on the
 * Content-Type, because a server is free to lie about the MIME type while it is the extension
 * that decides what a double-click does. The MIME type only ever adds a reason to be stricter,
 * never a reason to relax.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** 单个下载的体积上限，默认 2 GiB / Per-download size cap, 2 GiB by default. */
export const DEFAULT_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;

export type BrowserDownloadAction = 'allow' | 'confirm' | 'block';

export type BrowserDownloadReason = 'executable' | 'script' | 'tooLarge';

export type BrowserDownloadVerdict = {
  action: BrowserDownloadAction;
  reason?: BrowserDownloadReason;
  /** 给用户看的一句话理由 / A one-line reason, shown to the user. */
  message?: string;
};

/**
 * 双击即运行的扩展名。
 *
 * 含 `.dll`/`.sys` 这类本身不会被双击执行的文件，是因为它们的用途是被别的程序加载 ——
 * 落在下载目录里的 DLL 是 DLL 劫持的原料，危险程度不比 exe 低。
 *
 * Extensions that run on double-click. `.dll` and `.sys` are included even though they are not
 * themselves double-clicked: their purpose is to be loaded by another program, and a DLL sitting
 * in a downloads directory is the raw material for DLL hijacking, no less dangerous than an exe.
 */
const EXECUTABLE_EXTENSIONS = new Set([
  '.action',
  '.apk',
  '.app',
  '.appimage',
  '.appx',
  '.bin',
  '.cmd',
  '.com',
  '.command',
  '.cpl',
  '.deb',
  '.dll',
  '.dmg',
  '.exe',
  '.gadget',
  '.inf',
  '.ipa',
  '.jar',
  '.lnk',
  '.msc',
  '.msi',
  '.msix',
  '.msp',
  '.pkg',
  '.pif',
  '.rpm',
  '.run',
  '.scf',
  '.scr',
  '.sys',
  '.url',
  '.workflow',
]);

/**
 * 需要解释器、但同样是「打开就执行」的扩展名。
 * Extensions that need an interpreter yet still execute on open.
 */
const SCRIPT_EXTENSIONS = new Set([
  '.bash',
  '.bat',
  '.hta',
  '.js',
  '.jse',
  '.mjs',
  '.ps1',
  '.psm1',
  '.py',
  '.reg',
  '.rb',
  '.sh',
  '.vb',
  '.vbe',
  '.vbs',
  '.wsf',
  '.wsh',
  '.zsh',
]);

/**
 * 声称「这是可执行内容」的 MIME。
 *
 * 只作为补充判据：扩展名被剥掉、或者站点用一个看不出来的名字发一个 exe 时，MIME 是
 * 唯一剩下的线索。反过来，一个可执行扩展名不会因为 MIME 写着 text/plain 就被放行。
 *
 * MIME types that claim to carry executable content. Used only as an additional signal — when
 * the extension has been stripped, or the site serves an exe under an innocuous name, the MIME
 * type is the only clue left. The converse never applies: an executable extension is not
 * excused by a `text/plain` MIME type.
 */
const EXECUTABLE_MIME_TYPES = new Set([
  'application/vnd.microsoft.portable-executable',
  'application/x-dosexec',
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-executable',
  'application/x-mach-binary',
  'application/x-elf',
  'application/x-sharedlib',
]);

/**
 * 双向文本控制字符。
 *
 * 在 `invoice` 后面插一个 U+202E（从右向左覆盖），`invoice<RLO>fdp.exe` 在文件管理器里
 * 会显示成 `invoiceexe.pdf` —— 用户读到的是 .pdf，真实扩展名是 .exe。扩展名检查抓得住
 * 这个文件，但展示给用户的文件名必须和磁盘上的一致，否则确认对话框本身就在骗人。
 *
 * 字符按码点书写而不是直接嵌进正则：这些字符在源码里不可见，直接写等于留下一段谁也
 * 看不出来、也没法安全编辑的正则。
 *
 * Bidirectional text control characters. A U+202E (right-to-left override) after `invoice` makes
 * `invoice<RLO>fdp.exe` render in a file manager as `invoiceexe.pdf`: the user reads .pdf while
 * the real extension is .exe. The extension check catches the file either way, but the name shown
 * to the user has to match the name on disk — otherwise the confirmation dialog is itself lying.
 *
 * Written as code points rather than embedded literally, since these characters are invisible in
 * source and inlining them would leave a regex nobody can read or safely edit.
 */
const BIDI_CONTROL_CHARACTERS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** 去掉双向文本控制字符 / Strip bidirectional text control characters. */
export const stripBidiControls = (name: string): string => name.replace(BIDI_CONTROL_CHARACTERS, '');

/** 一次下载在整个生命周期内的稳定标识 / A download's stable identity for its whole lifetime. */
export const createBrowserDownloadId = (): string => `dl-${randomUUID()}`;

export type BrowserDownloadKind = 'executable' | 'script' | 'other';

/**
 * 文件名（与可选 MIME）对应的风险类别。
 * The risk class implied by a file name, and optionally its MIME type.
 */
export const classifyDownloadKind = (fileName: string, mimeType?: string): BrowserDownloadKind => {
  const extension = path.extname(stripBidiControls(fileName)).toLowerCase();
  if (EXECUTABLE_EXTENSIONS.has(extension)) return 'executable';
  if (SCRIPT_EXTENSIONS.has(extension)) return 'script';
  // MIME 只加严不放宽：扩展名看不出问题时，它是最后一条线索。
  // The MIME type only tightens, never relaxes: with an innocuous extension it is the last clue.
  const normalizedMime = mimeType?.split(';')[0]?.trim().toLowerCase();
  if (normalizedMime && EXECUTABLE_MIME_TYPES.has(normalizedMime)) return 'executable';
  return 'other';
};

/**
 * 这次下载落盘后是不是一个 PDF。
 *
 * 判定和 classifyDownloadKind 一样以文件名为准，MIME 只是补充：扩展名被剥掉、或者站点
 * 用一个看不出来的名字发 PDF 时，MIME 是唯一剩下的线索。
 *
 * Whether the file this download writes to disk is a PDF. Judged by file name first, the
 * same as classifyDownloadKind, with the MIME type only as a fallback signal — for when the
 * extension has been stripped or the site serves a PDF under an innocuous name.
 */
export const isPdfDownload = (fileName: string, mimeType?: string): boolean => {
  const extension = path.extname(stripBidiControls(fileName)).toLowerCase();
  if (extension === '.pdf') return true;
  const normalizedMime = mimeType?.split(';')[0]?.trim().toLowerCase();
  return normalizedMime === 'application/pdf';
};

export type BrowserDownloadRequest = {
  fileName: string;
  mimeType?: string;
  /**
   * 服务端声明的总字节数。分块传输时为 0 或负数，表示未知 ——
   * 未知不构成拒绝理由，改由 {@link exceedsDownloadLimit} 在传输过程中兜底。
   *
   * Total bytes as declared by the server; 0 or negative for a chunked transfer, meaning unknown.
   * Unknown is not grounds for refusal — {@link exceedsDownloadLimit} covers it mid-transfer.
   */
  totalBytes?: number;
  maxBytes?: number;
};

export const evaluateBrowserDownload = (request: BrowserDownloadRequest): BrowserDownloadVerdict => {
  const maxBytes = request.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  const totalBytes = request.totalBytes ?? 0;

  if (totalBytes > maxBytes) {
    return {
      action: 'block',
      reason: 'tooLarge',
      message: 'The file is larger than the download limit and was not saved.',
    };
  }

  const kind = classifyDownloadKind(request.fileName, request.mimeType);
  if (kind === 'executable') {
    return {
      action: 'confirm',
      reason: 'executable',
      message: 'This download is a program. Running it can change or damage your computer.',
    };
  }
  if (kind === 'script') {
    return {
      action: 'confirm',
      reason: 'script',
      message: 'This download is a script. Opening it runs commands on your computer.',
    };
  }
  return { action: 'allow' };
};

/**
 * 传输过程中的体积兜底。
 *
 * 必需，因为 Content-Length 可以缺失也可以撒谎：声明 1 KB 然后一直传下去，磁盘会被写满，
 * 而事前判定完全看不出来。
 *
 * The size backstop during transfer. Necessary because Content-Length can be absent and can lie:
 * a response declaring 1 KB and then streaming without end fills the disk, and nothing in the
 * up-front check would see it.
 */
export const exceedsDownloadLimit = (receivedBytes: number, maxBytes: number = DEFAULT_MAX_DOWNLOAD_BYTES): boolean =>
  receivedBytes > maxBytes;
