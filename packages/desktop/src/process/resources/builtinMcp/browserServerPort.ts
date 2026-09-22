/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 解析应用内浏览器 MCP 该连接的 CDP 地址。
 *
 * 单独成文件是为了可测试：browserServer.ts 是个有顶层副作用的启动脚本（会 spawn
 * 子进程），没法直接在单测里 import。
 *
 * Resolves which CDP endpoint the in-app browser MCP should connect to. Kept in
 * its own module for testability: browserServer.ts is an entry script with
 * top-level side effects (it spawns a child), so it cannot be imported by tests.
 */

const DEFAULT_CDP_HOST = '127.0.0.1';

export type ResolveBrowserUrlDeps = {
  env: NodeJS.ProcessEnv;
};

const toBrowserUrl = (port: number): string | null => {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return `http://${DEFAULT_CDP_HOST}:${port}`;
};

/**
 * 只认自己进程树继承下来的端口。
 *
 * 端口由 Electron 主进程写进 AIONUI_CDP_ACTIVE_PORT，经 aioncore 继承到这里，所以
 * 「拿不到」只有两种情况：CDP 被用户关掉了，或者不是从应用里启动的。两种情况都应当
 * 拒绝启动，而不是去猜一个端口——猜错会把 Agent 连到另一个实例的浏览器上。
 *
 * Only trust the port inherited down this process tree. The Electron main process
 * writes it into AIONUI_CDP_ACTIVE_PORT and aioncore passes it down, so failing to
 * read it means one of two things: the user disabled CDP, or this was not launched by
 * the app. Both must refuse to start rather than guess a port — guessing wrong
 * connects the agent to a *different* instance's browser.
 */
export const resolveBrowserUrl = (deps: ResolveBrowserUrlDeps): string | null => {
  const { env } = deps;

  const rawPort = env.AIONUI_CDP_ACTIVE_PORT?.trim();
  if (rawPort) {
    const fromEnv = toBrowserUrl(Number(rawPort));
    if (fromEnv) return fromEnv;
  }

  return null;
};

/**
 * 私有 CDP 通道的访问口令。
 *
 * 口令由主进程随机生成，经子进程环境传给内置 launcher。HTTP discovery 只返回不可直接
 * 连接的无口令地址；launcher 直接构造带口令的 WebSocket 地址。缺少端口或口令时必须退出，
 * 不能回退为启动用户不可见的独立 Chrome。
 *
 * The main process generates this token and passes it only through the child-process environment.
 * HTTP discovery returns an unusable token-free URL; the bundled launcher builds the authenticated
 * WebSocket endpoint directly. Missing credentials must terminate startup rather than launch a
 * separate hidden Chrome.
 */
export const resolveBridgeToken = (deps: ResolveBrowserUrlDeps): string | null => {
  const raw = deps.env.AIONUI_CDP_BRIDGE_TOKEN?.trim();
  return raw ? raw : null;
};

/** Build the authenticated direct WebSocket endpoint used by the bundled MCP runtime. */
export const resolveBrowserWsEndpoint = (deps: ResolveBrowserUrlDeps): string | null => {
  const browserUrl = resolveBrowserUrl(deps);
  const token = resolveBridgeToken(deps);
  if (!browserUrl || !token) return null;
  const url = new URL(browserUrl);
  url.protocol = 'ws:';
  url.pathname = '/aionui-cdp';
  url.searchParams.set('token', token);
  return url.toString();
};

/**
 * 关掉对「浏览网页」毫无价值的上游工具类别。
 *
 * chrome-devtools-mcp 默认打开 input/navigation/emulation/performance/network/debugging/memory
 * 七类，实际注册 27 个工具。其中 memory/performance/emulation 三类贡献的 6 个工具
 * （take_heapsnapshot、performance_* 三件套、emulate、resize_page）是给前端性能调优用的，
 * Agent 在本应用里永远不会需要，而且多数在这个自研 CDP 伪装层上根本跑不通 —— 它们要的
 * tracing 域和 Page.setDownloadBehavior 要么没实现要么在黑名单里。
 *
 * 留着的代价不是「多几个用不上的工具」，而是每次会话都要把它们的 schema 塞进上下文，
 * 并且给模型多 6 个选错的机会。
 *
 * Turn off upstream tool categories that carry no value for browsing. chrome-devtools-mcp
 * enables seven categories by default, registering 27 tools; the memory/performance/emulation
 * three contribute six (take_heapsnapshot, the performance_* trio, emulate, resize_page) that
 * exist for front-end performance work. The agent here never needs them, and most cannot even
 * run against this hand-written CDP facade — the tracing domain is not implemented and
 * Page.setDownloadBehavior is on the blocklist. Keeping them costs a schema in every session's
 * context plus six more ways for the model to pick the wrong tool.
 *
 * 注意：lighthouse_audit 属 debugging 类，和 take_snapshot / take_screenshot 同类，
 * 没法靠类别单独摘掉 —— 由 browserServer.ts 的工具抑制名单处理。
 *
 * Note: lighthouse_audit shares the debugging category with take_snapshot and take_screenshot,
 * so it cannot be dropped by category; browserServer.ts's suppression list handles it.
 */
const DISABLED_TOOL_CATEGORIES = ['--no-category-memory', '--no-category-performance', '--no-category-emulation'];

/**
 * 截图尺寸上限。
 *
 * image token 按尺寸而不是编码字节计算，所以这个上限直接决定一张截图的成本：
 * 1600x1200 约 2560 token，1280x960 约 1640，1024x768 约 1050。
 *
 * 选 1280x960 而不是更激进的 1024x768，是因为这个上限只在用户把浏览器面板拉得很大时才
 * 真正生效 —— 面板通常没有 1600 宽，这时无论设多少都不会缩放。一旦生效，线性缩放比例
 * 就直接决定小字还认不认得出：1280 相对 1600 缩 20%，12px 的正文还有约 9.6px；1024 缩
 * 36%，只剩 7.7px，已经在「看不清」的边缘。截图本来就只在「必须看清长什么样」时才用，
 * 把它压到看不清等于白花这笔 token。
 *
 * Screenshot size caps. Image tokens scale with dimensions rather than encoded bytes, so this
 * cap sets the cost of one screenshot directly: 1600x1200 is roughly 2560 tokens, 1280x960 about
 * 1640, and 1024x768 about 1050.
 *
 * 1280x960 rather than a more aggressive 1024x768 because the cap only bites when the user has
 * made the browser panel large — a typical panel is narrower than 1600, and then no value
 * changes anything. When it does bite, the linear scale factor decides whether small text stays
 * legible: 1280 is a 20% reduction from 1600, leaving 12px body text at about 9.6px, while 1024
 * is 36% and leaves 7.7px, which is on the edge of unreadable. Screenshots are only taken when
 * the answer depends on what something looks like, so shrinking them past legibility wastes the
 * tokens entirely.
 */
const SCREENSHOT_MAX_WIDTH = '1280';
const SCREENSHOT_MAX_HEIGHT = '960';

/** Build the local runtime argv. No package manager or shell participates at launch. */
export const buildMcpSpawnCommand = (deps: {
  platform: string;
  runtimeExecutable: string;
  runtimeEntry: string;
  wsEndpoint: string;
}): { command: string; args: string[]; windowsHide: boolean } => {
  return {
    command: deps.runtimeExecutable,
    args: [
      deps.runtimeEntry,
      '--ws-endpoint',
      deps.wsEndpoint,
      '--page-id-routing',
      '--no-usage-statistics',
      '--no-performance-crux',
      '--no-javascript-evaluation',
      '--redact-network-headers',
      ...DISABLED_TOOL_CATEGORIES,
      '--screenshot-format',
      'webp',
      '--screenshot-max-width',
      SCREENSHOT_MAX_WIDTH,
      '--screenshot-max-height',
      SCREENSHOT_MAX_HEIGHT,
    ],
    windowsHide: deps.platform === 'win32',
  };
};
