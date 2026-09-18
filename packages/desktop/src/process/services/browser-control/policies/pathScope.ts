/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 路径包含性判定。
 *
 * 单独成文件是因为下载和上传都要用它，而这两条链路都是安全边界：下载要确认「在文件夹中
 * 显示」的目标确实是我们存下去的文件，上传要确认 Agent 给的路径确实在工作区里。两处共用
 * 同一份实现，边界规则才不会各写各的然后悄悄分叉。
 *
 * 这个模块刻意不 import electron —— 它是纯路径运算，保持无副作用才能在没有 Electron
 * 二进制的环境里直接单测。
 *
 * Path containment checks, in their own module because both the download and the upload path
 * need them and both are security boundaries: downloads must confirm that a "reveal in folder"
 * target really is a file we wrote, uploads must confirm that an agent-supplied path really is
 * inside the workspace. Sharing one implementation is what stops the two boundary rules from
 * being written twice and quietly drifting apart.
 *
 * This module deliberately imports nothing from electron — it is pure path arithmetic, and
 * staying side-effect free is what makes it unit-testable without an Electron binary.
 */

import path from 'node:path';

/**
 * candidate 是否严格位于 root 内部。
 *
 * 三处刻意的设计：
 * 1. 先 resolve 再比较，否则 `a/../../b` 这种写法会绕过任何字符串前缀检查；
 * 2. `candidate === root` 返回 false —— 「在目录里」不包括目录本身，上传一个目录、
 *    或者把下载目录本身当成下载结果，都不是合法结果；
 * 3. 用 `path.relative` 而不是 `startsWith(root)` —— 后者会让 `/work/project-evil`
 *    通过 `/work/project` 的前缀匹配。
 *
 * Whether `candidate` sits strictly inside `root`. Three deliberate choices: paths are
 * resolved before comparison, since otherwise `a/../../b` walks straight past any string
 * prefix check; `candidate === root` is false, because "inside the directory" does not
 * include the directory itself; and `path.relative` is used rather than `startsWith(root)`,
 * which would let `/work/project-evil` pass a prefix match against `/work/project`.
 */
export const isPathInsideRoot = (root: string, candidate: string): boolean => {
  if (!root || !candidate) return false;
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedCandidate === resolvedRoot) return false;
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
};

/**
 * 找出第一个包含 candidate 的 root，找不到返回 null。
 *
 * 返回具体命中的 root（而不是一个 boolean），是为了让调用方能在 realpath 之后拿同一个
 * root 再查一次 —— 符号链接逃逸检测需要「解析前后落在同一个根」这个更强的条件。
 *
 * The first root containing `candidate`, or null. Returning the matching root rather than a
 * boolean lets the caller re-check against that same root after resolving symlinks — escape
 * detection needs the stronger condition that both the literal and the real path land in one
 * and the same root.
 */
export const findContainingRoot = (roots: readonly string[], candidate: string): string | null => {
  for (const root of roots) {
    if (isPathInsideRoot(root, candidate)) return root;
  }
  return null;
};
