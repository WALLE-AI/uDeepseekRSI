/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 构造 `<webview>` 的属性表。
 *
 * 抽成纯函数是因为 WebviewHost 在 jsdom 下渲染不出来（`<webview>` 是 Electron 专有标签，
 * 永远不会挂载），所以这里的取舍必须能脱离组件单测 —— 与 webviewHistory.ts 同样的理由。
 *
 * Builds the attribute map for a `<webview>`. Extracted as a pure function because
 * WebviewHost cannot be rendered under jsdom (`<webview>` is an Electron-only tag that
 * never mounts), so these decisions have to be unit-testable outside the component —
 * the same reasoning that produced webviewHistory.ts.
 */

/**
 * 不可信页面的默认 webPreferences。
 *
 * 这个 webview 会加载任意外部网页，三个开关都按「页面不可信」来设。contextIsolation=yes
 * 是刻意打开的：Electron 官方建议即使关掉 nodeIntegration 也保持隔离，多一层纵深。我们不
 * 依赖与页面共享 JS 上下文；StarOffice 的缩放脚本只通过 console-message 发数值事件，隔离
 * 开着照样成立。别为了图方便把它改回 no：那样以后任何 preload / IPC 暴露都会被不可信页面
 * 直接摸到。
 *
 * Hostile-page defaults. This webview renders arbitrary external pages, so all three flags
 * assume the page is untrusted. contextIsolation is deliberately on: Electron recommends
 * keeping it even with nodeIntegration off, for defence in depth. Nothing here needs a
 * shared JS context; the StarOffice zoom helper only sends numeric events through
 * `console-message`, which works with isolation enabled. Do not flip this back to `no` for
 * convenience: any future preload or IPC surface would then be directly reachable by
 * untrusted pages.
 */
const UNTRUSTED_PAGE_WEB_PREFERENCES = 'contextIsolation=yes, nodeIntegration=no, nativeWindowOpen=no';

export type WebviewAttributeOptions = {
  /** 缓存 / 会话隔离用的 partition / Partition for cache and session isolation. */
  partition?: string;
  /**
   * 打开 Chromium 内置 PDF 阅读器。仅浏览器 tab 使用。
   *
   * 关掉时 Chromium 不会渲染 PDF，而是把这次导航降级成下载 —— 页面留在原地，
   * did-fail-load 报 ERR_ABORTED(-3) 并被忽略，用户只看到一片空白。浏览器 tab 要
   * 表现得像浏览器，所以这里必须打开；其余 webview（OAuth、设置、Office 预览）
   * 用不到，保持关闭以免无谓地扩大插件面。
   *
   * Enable Chromium's built-in PDF viewer. Browser tabs only.
   *
   * With it off Chromium does not render PDFs — it reclassifies the navigation as a
   * download, the page stays where it was, and did-fail-load reports ERR_ABORTED(-3),
   * which is ignored, so the user just sees a blank panel. A Browser tab has to behave
   * like a browser, so it opts in; every other webview (OAuth, settings, Office preview)
   * has no use for it and stays off rather than widening the plugin surface.
   */
  allowPdfViewer?: boolean;
};

/**
 * Electron 的 webview 布尔属性是「看有没有这个属性」，不是看值：
 * `plugins="false"` 反而等于打开。所以关闭时必须整个键都不写，而不是写成 'false'。
 *
 * Electron's webview boolean attributes are presence-based (`hasAttribute`), not
 * value-based: `plugins="false"` would *enable* it. When disabled the key must therefore
 * be omitted entirely rather than set to 'false'.
 */
export const buildWebviewAttributes = ({
  partition,
  allowPdfViewer,
}: WebviewAttributeOptions): Record<string, string> => {
  const attributes: Record<string, string> = {
    allowpopups: 'false',
    webpreferences: UNTRUSTED_PAGE_WEB_PREFERENCES,
  };
  if (partition) attributes.partition = partition;
  if (allowPdfViewer) attributes.plugins = 'true';
  return attributes;
};
