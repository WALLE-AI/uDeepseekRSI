/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 浏览器文件上传的准入策略。
 *
 * 威胁模型很直接：网页上的 `<input type="file">` 由远端页面控制，而填充它的路径来自
 * Agent。如果不校验，一次「请上传你的简历」就能变成「上传 ~/.ssh/id_rsa」——
 * 页面拿到的是文件内容，用户看到的只是一次普通上传。
 *
 * 因此路径必须逐条过三道闸：
 *
 * 1. 必须是绝对路径。相对路径的解释依赖进程 CWD，而主进程的 CWD 不是用户能预期的东西；
 * 2. resolve 之后必须落在某个 allowlist 根目录内（挡掉 `..` 和任意绝对路径）；
 * 3. realpath 之后必须仍落在**同一个**根目录内（挡掉符号链接逃逸）。
 *
 * 第 3 步单独存在是有原因的：工作区里放一个指向 `/etc/shadow` 的符号链接，前两步全都通过，
 * 只有解析真实路径才看得出来。
 *
 * Admission policy for browser file uploads. The threat model is direct: the `<input
 * type="file">` belongs to a remote page while the path filling it comes from the agent. Without
 * validation, "please upload your résumé" becomes "upload ~/.ssh/id_rsa" — the page receives the
 * contents and the user sees an ordinary upload.
 *
 * Every path therefore passes three gates: it must be absolute (relative paths are interpreted
 * against the process CWD, which is not something a user can predict for the main process); after
 * resolution it must land inside an allowlisted root (defeating `..` and arbitrary absolute
 * paths); and after resolving symlinks it must still land inside *the same* root. That last gate
 * exists on its own merit — a symlink in the workspace pointing at `/etc/shadow` passes the first
 * two and is only visible once the real path is resolved.
 */

import path from 'node:path';
import { findContainingRoot, isPathInsideRoot } from './pathScope';

export type BrowserUploadRejection =
  | 'INVALID_PATH'
  | 'NOT_ABSOLUTE'
  | 'OUTSIDE_WORKSPACE'
  | 'SYMLINK_ESCAPE'
  | 'NOT_A_FILE'
  | 'TOO_LARGE';

export type BrowserUploadResolution =
  | { ok: true; path: string; root: string; size: number }
  | { ok: false; code: BrowserUploadRejection; message: string };

/**
 * 单个上传文件的大小上限，默认 256 MB。
 *
 * 上限的意义不在于「网站受不受得了」，而在于主进程：读一个几 GB 的文件会把整个界面卡住。
 *
 * Per-file upload size cap, 256 MB by default. The cap is about the main process rather than
 * about what the site can take — reading a multi-gigabyte file freezes the entire UI.
 */
export const DEFAULT_MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

/**
 * 文件系统探针，由调用方注入。
 *
 * 注入而不是直接 import fs：这样整套判定逻辑可以在没有真实符号链接的环境里单测 ——
 * 而符号链接逃逸恰恰是最需要测、又最难在 CI 上真实构造的分支（Windows 上创建符号链接
 * 默认需要管理员权限）。
 *
 * Filesystem probes, injected rather than importing `fs` directly so the whole decision can be
 * unit-tested without real symlinks — and symlink escape is both the branch that most needs
 * testing and the hardest to construct for real in CI (creating a symlink on Windows requires
 * elevation by default).
 */
export type BrowserUploadProbe = {
  /** 解析符号链接后的真实路径；不存在时抛错 / Real path after resolving symlinks; throws if absent. */
  realPath: (candidate: string) => string;
  /** 目标的类型与大小；不存在时返回 null / Kind and size of the target, or null if absent. */
  stat: (candidate: string) => { isFile: boolean; size: number } | null;
};

export const resolveBrowserUploadPath = (
  request: {
    requestedPath: string;
    /** 允许上传的根目录（工作区、会话附件目录等）/ Roots uploads may come from. */
    allowedRoots: readonly string[];
    maxBytes?: number;
  },
  probe: BrowserUploadProbe
): BrowserUploadResolution => {
  const { requestedPath, allowedRoots } = request;
  const maxBytes = request.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES;

  if (typeof requestedPath !== 'string' || requestedPath.trim() === '') {
    return { ok: false, code: 'INVALID_PATH', message: 'No file path was supplied.' };
  }
  // NUL 会让部分系统调用在字符串中途截断，从而使校验过的路径和实际打开的路径不是同一个。
  // A NUL truncates some syscalls mid-string, so the validated path and the opened path would
  // not be the same path.
  if (requestedPath.includes('\0')) {
    return { ok: false, code: 'INVALID_PATH', message: 'The file path contains an illegal character.' };
  }
  if (!path.isAbsolute(requestedPath)) {
    return { ok: false, code: 'NOT_ABSOLUTE', message: 'Only absolute file paths can be uploaded.' };
  }
  if (allowedRoots.length === 0) {
    return { ok: false, code: 'OUTSIDE_WORKSPACE', message: 'No directory is currently allowed for uploads.' };
  }

  const normalized = path.resolve(requestedPath);
  const root = findContainingRoot(allowedRoots, normalized);
  if (!root) {
    return {
      ok: false,
      code: 'OUTSIDE_WORKSPACE',
      message: 'Only files inside the current workspace can be uploaded.',
    };
  }

  let realTarget: string;
  let realRoot: string;
  try {
    realTarget = probe.realPath(normalized);
    // 根目录本身也要解析：工作区自己可能就是一个符号链接（macOS 上 /tmp 就是），
    // 不解析的话真实路径与未解析的根永远比不上。
    // The root is resolved too: the workspace may itself be a symlink (on macOS /tmp is one),
    // and without resolving it the real target could never be matched against it.
    realRoot = probe.realPath(root);
  } catch {
    return { ok: false, code: 'INVALID_PATH', message: 'The file could not be found.' };
  }

  if (!isPathInsideRoot(realRoot, realTarget)) {
    return {
      ok: false,
      code: 'SYMLINK_ESCAPE',
      message: 'That path is a link pointing outside the workspace and cannot be uploaded.',
    };
  }

  const stats = probe.stat(realTarget);
  if (!stats) return { ok: false, code: 'INVALID_PATH', message: 'The file could not be found.' };
  if (!stats.isFile) return { ok: false, code: 'NOT_A_FILE', message: 'Only regular files can be uploaded.' };
  if (stats.size > maxBytes) {
    return { ok: false, code: 'TOO_LARGE', message: 'The file is larger than the upload limit.' };
  }

  return { ok: true, path: realTarget, root: realRoot, size: stats.size };
};

/**
 * 批量解析。任意一条不合法就整批拒绝，不做「跳过坏的、传好的」。
 *
 * 部分成功在这里是错的语义：页面拿到的文件数与 Agent 以为传上去的对不上，后续每一步推理
 * 都建立在错误的前提上，而且用户没有任何提示。要么全传，要么明确失败。
 *
 * Resolve a batch. Any invalid entry rejects the whole batch rather than skipping the bad ones.
 * Partial success is the wrong semantics here: the page would receive a different set of files
 * from the one the agent believes it sent, every subsequent step would reason from a false
 * premise, and the user would see no indication. All or an explicit failure.
 */
export const resolveBrowserUploadPaths = (
  request: { requestedPaths: readonly string[]; allowedRoots: readonly string[]; maxBytes?: number },
  probe: BrowserUploadProbe
): { ok: true; paths: string[] } | { ok: false; code: BrowserUploadRejection; message: string } => {
  const resolved: string[] = [];
  for (const requestedPath of request.requestedPaths) {
    const outcome = resolveBrowserUploadPath(
      { requestedPath, allowedRoots: request.allowedRoots, maxBytes: request.maxBytes },
      probe
    );
    if (outcome.ok === false) return outcome;
    resolved.push(outcome.path);
  }
  return { ok: true, paths: resolved };
};
