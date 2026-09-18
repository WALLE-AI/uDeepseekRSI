/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PDF.js 模块的共享类型。
 *
 * pdfjs-dist 是动态 import 进来的（它连 worker 有好几 MB，不该进首屏包），所以模块本身
 * 要作为值在组件之间传递。这里给它一个具名类型，省得每个组件各写一遍
 * `typeof import('pdfjs-dist')`，也避免有人图省事改成静态 import 而悄悄把包体撑大。
 *
 * Shared types for the PDF.js module. pdfjs-dist is loaded via dynamic import — it is several
 * megabytes with its worker and has no business in the initial bundle — so the module is passed
 * between components as a value. Naming the type here saves repeating
 * `typeof import('pdfjs-dist')` in every component, and removes the temptation to "simplify" it
 * into a static import that would quietly inflate the bundle.
 */

export type PdfjsModule = typeof import('pdfjs-dist');

/** PDF.js 文本层实例 / An instance of PDF.js's text layer. */
export type PdfTextLayer = InstanceType<PdfjsModule['TextLayer']>;
