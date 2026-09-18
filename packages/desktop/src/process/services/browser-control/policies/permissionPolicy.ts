/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 设备与能力权限策略。
 *
 * 在普通浏览器里，摄像头、麦克风、位置这些权限的请求总是跟着一次用户操作发生的 ——
 * 用户点了「加入会议」，所以弹窗出现时他知道这是自己招来的。应用内浏览器没有这个前提：
 * 导航可能由 Agent 发起，弹窗对用户来说是凭空出现的，而「凭空出现的弹窗」恰恰是
 * 点击疲劳最严重、最容易被随手放行的场景。
 *
 * 所以分成三档，且没有「默认允许」这一档：
 *
 * - `deny`  —— 静默拒绝。给那些在受控浏览器里根本没有合理用途的能力（串口、USB、HID…），
 *              连问都不问，问了只会训练用户点「允许」；
 * - `ask`   —— 必须由用户决定。摄像头、麦克风、位置、通知、屏幕共享、外部协议都在这里；
 * - `allow` —— 只给不涉及任何设备、数据或外部程序的能力（全屏）。
 *
 * 未知权限走 `deny`：Electron 会随版本增加新的权限名，默认拒绝意味着新增的能力不会
 * 因为我们没来得及更新这张表而自动获得放行。
 *
 * Device and capability permission policy. In an ordinary browser a camera, microphone, or
 * location request always follows a user action — the user pressed "join meeting", so the prompt
 * is something they summoned. The in-app browser has no such premise: the navigation may have
 * been initiated by the agent, so from the user's side the prompt appears out of nowhere, and an
 * out-of-nowhere prompt is precisely the case where click fatigue is worst and "Allow" gets
 * pressed reflexively.
 *
 * Hence three tiers, with no "allowed by default" among them: `deny` silently refuses
 * capabilities that have no legitimate use in a controlled browser (serial, USB, HID) — asking
 * would only train the user to press Allow; `ask` requires the user to decide, and covers camera,
 * microphone, location, notifications, screen sharing, and external protocols; `allow` is
 * reserved for capabilities touching no device, no data, and no external program.
 *
 * Unknown permissions fall to `deny`. Electron adds permission names as it evolves, and denying
 * by default means a newly introduced capability is never waved through merely because this table
 * has not caught up with it.
 */

export type BrowserPermissionDecision = 'allow' | 'ask' | 'deny';

/**
 * 只涉及页面自身呈现的能力。
 * Capabilities touching nothing but the page's own presentation.
 */
const AUTO_ALLOWED = new Set(['fullscreen']);

/**
 * 需要用户决定的能力。
 * 对应执行方案里点名的那几项：摄像头、麦克风、位置、通知、屏幕共享、external protocol。
 *
 * Capabilities requiring a user decision — the set named in the execution plan: camera,
 * microphone, geolocation, notifications, screen sharing, and external protocols.
 */
const USER_DECIDED = new Set([
  'media',
  'audioCapture',
  'videoCapture',
  'display-capture',
  'geolocation',
  'notifications',
  'clipboard-read',
  'clipboard-sanitized-write',
  'openExternal',
  'fileSystem',
  'window-management',
  'keyboardLock',
  'pointerLock',
]);

export type BrowserPermissionVerdict = {
  decision: BrowserPermissionDecision;
  /** 询问用户时展示的一句话 / The single line shown when asking the user. */
  prompt?: string;
};

const PROMPTS: Record<string, string> = {
  media: 'use your camera and microphone',
  audioCapture: 'use your microphone',
  videoCapture: 'use your camera',
  'display-capture': 'share your screen',
  geolocation: 'know your location',
  notifications: 'send you notifications',
  'clipboard-read': 'read your clipboard',
  'clipboard-sanitized-write': 'write to your clipboard',
  openExternal: 'open another app on your computer',
  fileSystem: 'read and write files on your computer',
  'window-management': 'see the windows on your screen',
  keyboardLock: 'take over your keyboard shortcuts',
  pointerLock: 'capture your mouse pointer',
};

export const classifyBrowserPermission = (permission: string): BrowserPermissionVerdict => {
  if (AUTO_ALLOWED.has(permission)) return { decision: 'allow' };
  if (USER_DECIDED.has(permission)) {
    return { decision: 'ask', prompt: PROMPTS[permission] ?? `use ${permission}` };
  }
  return { decision: 'deny' };
};

/**
 * 同步场景下的判定。
 *
 * `setPermissionCheckHandler` 是同步的 —— 它必须立刻返回 true/false，没有机会去问用户。
 * 所以 `ask` 在这里只能降级成 false。这不是妥协：那个 handler 回答的是「这个能力现在
 * 是否已经被授予」，尚未询问过的能力本来就不算已授予。
 *
 * The synchronous verdict. `setPermissionCheckHandler` must answer true or false immediately and
 * has no opportunity to ask, so `ask` degrades to false there. That is not a compromise: the
 * handler answers "is this capability currently granted", and a capability nobody has been asked
 * about is by definition not granted.
 */
export const resolveSyncPermission = (permission: string): boolean =>
  classifyBrowserPermission(permission).decision === 'allow';

/**
 * 危险到不该出现在「用户确认」流程里的协议。
 *
 * 之所以不是「弹窗问一下」：这几个协议的后果用一句话讲不清楚，而讲不清楚的确认框等于
 * 没有确认。`file:` 读本地文件，`javascript:`/`data:` 在当前页执行脚本，`ms-msdt:` 等
 * 是已知被用来做 RCE 的 Windows 协议处理器。
 *
 * Schemes too dangerous to route through a confirmation flow at all. Not "just ask", because
 * their consequences cannot be stated in one sentence, and a confirmation the user cannot
 * understand is not a confirmation. `file:` reads local files, `javascript:` and `data:` execute
 * in the current page, and handlers such as `ms-msdt:` are known Windows RCE vectors.
 */
const FORBIDDEN_PROTOCOLS = new Set([
  'file:',
  'javascript:',
  'data:',
  'blob:',
  'vbscript:',
  'ms-msdt:',
  'search-ms:',
  'ms-officecmd:',
  'shell:',
  'smb:',
]);

/** 日常且后果可以一句话讲清的协议 / Everyday schemes whose consequence fits in one sentence. */
const CONFIRMABLE_PROTOCOLS = new Set(['mailto:', 'tel:', 'sms:', 'callto:', 'webcal:']);

export type ExternalProtocolVerdict =
  | { decision: 'ask'; protocol: string; prompt: string }
  | { decision: 'deny'; protocol: string; reason: string };

/**
 * 页面想把一个非 http(s) 链接交给系统处理时的判定。
 * The verdict when a page asks the OS to handle a non-http(s) link.
 */
export const classifyExternalProtocol = (rawUrl: string): ExternalProtocolVerdict => {
  let protocol: string;
  try {
    protocol = new URL(rawUrl).protocol.toLowerCase();
  } catch {
    return { decision: 'deny', protocol: '', reason: 'The link is not a valid URL.' };
  }
  if (FORBIDDEN_PROTOCOLS.has(protocol)) {
    return { decision: 'deny', protocol, reason: `Links of type ${protocol} are never opened from the browser.` };
  }
  if (CONFIRMABLE_PROTOCOLS.has(protocol)) {
    return { decision: 'ask', protocol, prompt: `open this ${protocol.replace(':', '')} link in another app` };
  }
  // 既不在白名单也不在黑名单的自定义协议：能问就问，但绝不自动放行。
  // A custom scheme in neither list: ask if there is anyone to ask, but never open it silently.
  return { decision: 'ask', protocol, prompt: `open a ${protocol.replace(':', '')} link in another app` };
};

/**
 * 「同一个来源 + 同一个权限」的用户决定记忆。
 *
 * 没有它，一个页面可以在循环里反复请求权限，把用户逼到点「允许」为止 —— 这不是理论上的
 * 攻击，是野外常见的做法。记住一次决定（无论允许还是拒绝）之后不再重复询问，是让拒绝
 * 真正有效的唯一方式。
 *
 * 刻意只存在内存里，随 session 生命周期消失：权限授予是敏感状态，持久化就意味着用户在
 * 某一刻的一次点击会无限期生效，而应用里并没有一个「撤销已授予权限」的入口。
 *
 * Memory of the user's decision per origin and permission. Without it a page can request the same
 * permission in a loop until the user presses Allow — not a theoretical attack but common
 * practice in the wild. Remembering the decision either way, and not asking again, is the only
 * thing that makes a refusal actually stick.
 *
 * Deliberately in memory only, living and dying with the session: a permission grant is sensitive
 * state, and persisting it would make one click at one moment effective indefinitely, in an app
 * that offers no way to revoke a grant.
 */
export class BrowserPermissionLedger {
  private readonly decisions = new Map<string, boolean>();

  private static key(origin: string, permission: string): string {
    return `${origin} ${permission}`;
  }

  /** 已记录的决定；从未问过时返回 undefined / The recorded decision, or undefined if never asked. */
  public recall(origin: string, permission: string): boolean | undefined {
    return this.decisions.get(BrowserPermissionLedger.key(origin, permission));
  }

  public remember(origin: string, permission: string, granted: boolean): void {
    this.decisions.set(BrowserPermissionLedger.key(origin, permission), granted);
  }

  /** 清空全部记忆，供「清除浏览数据」调用 / Forget everything, for the clear-browsing-data entry point. */
  public clear(): void {
    this.decisions.clear();
  }

  public get size(): number {
    return this.decisions.size;
  }
}
