/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 应用内浏览器的安全策略层。
 *
 * 这一层里的模块全部是纯逻辑，不 import electron、不碰文件系统、不发网络请求 ——
 * 需要 IO 的地方一律由调用方注入探针。这样做有两个具体收益：所有分支都能在没有 Electron
 * 二进制的环境里单测（符号链接逃逸、DNS rebinding 这类分支在真实环境里极难构造），
 * 以及策略判定与副作用分离，读代码时不必在「它决定了什么」和「它做了什么」之间来回跳。
 *
 * The security policy layer for the in-app browser. Every module here is pure logic: no electron
 * import, no filesystem, no network — where IO is needed, the caller injects a probe. Two concrete
 * benefits: every branch is unit-testable without an Electron binary (symlink escape and DNS
 * rebinding are close to impossible to construct for real), and decisions stay separated from
 * effects, so reading the code never means jumping between what it decided and what it did.
 */

export * from './actionPolicy';
export * from './challengeClassifier';
export * from './dialogPolicy';
export * from './downloadPolicy';
export * from './networkPolicy';
export * from './pathScope';
export * from './pdfResponseClassifier';
export * from './permissionPolicy';
export * from './rateLimitPolicy';
export * from './uploadPolicy';
