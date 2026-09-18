/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 对话框、离开确认与证书错误的结构化处理。
 *
 * 这三件事在普通浏览器里都是原生模态框，而在这里它们同时面对两个「用户」：真实用户，和
 * 驱动导航的 Agent。原生模态框对后者是不可见的 —— 它会静静地把整个 webContents 挂住，
 * Agent 看到的只是一个再也不返回的命令，而真实用户看到的是一个自己没招来的弹窗。
 *
 * 所以这里不让它们以原生模态框的形式发生，而是转成结构化状态：每一次都带上稳定 id、
 * 来源 origin、类型和文案，交给上层决定是展示给用户、还是按策略自动回答。
 *
 * Structured handling of dialogs, unload prompts, and certificate errors. All three are native
 * modals in an ordinary browser, but here they face two "users" at once: the real one, and the
 * agent driving the navigation. A native modal is invisible to the latter — it quietly wedges the
 * whole webContents, so the agent sees a command that never returns while the real user sees a
 * prompt they never summoned.
 *
 * None of them is therefore allowed to happen as a native modal. Each becomes structured state
 * carrying a stable id, the originating origin, a kind, and its text, leaving it to the layer
 * above to decide between showing it to the user and answering it by policy.
 */

import { randomUUID } from 'node:crypto';

export type BrowserDialogKind = 'alert' | 'confirm' | 'prompt' | 'beforeUnload' | 'certificateError';

export type BrowserDialogRequest = {
  kind: BrowserDialogKind;
  /** 触发这次对话框的页面 origin / Origin of the page raising it. */
  origin: string;
  message?: string;
  /**
   * 这次导航是不是 Agent 发起的。决定了对话框该展示还是该按策略自动回答。
   * Whether the agent initiated this navigation — the thing that decides between showing the
   * dialog and answering it by policy.
   */
  agentInitiated: boolean;
};

export type BrowserDialogState = {
  id: string;
  kind: BrowserDialogKind;
  origin: string;
  message: string;
  /** 上层该展示给用户，还是直接按 `defaultAnswer` 回掉 / Show it, or answer with `defaultAnswer`. */
  disposition: 'show' | 'autoAnswer';
  /** autoAnswer 时用的答案 / The answer used when auto-answering. */
  defaultAnswer: boolean;
};

/** 一次对话框在其生命周期内的稳定标识 / A dialog's stable identity for its whole lifetime. */
export const createBrowserDialogId = (): string => `dlg-${randomUUID()}`;

/**
 * 把一次对话框请求转成结构化状态。
 *
 * Agent 驱动时一律自动回答「否」而不是展示：展示会把一个用户没有上下文的弹窗推到他面前
 * （他并不知道 Agent 正在哪一页做什么），而自动回答「否」在语义上正是「未获得许可」——
 * confirm 返回 false、prompt 返回 null，与用户按下取消完全一致，页面本来就必须处理这条路径。
 *
 * Turn a dialog request into structured state. Under agent control it is always auto-answered in
 * the negative rather than shown: showing it would push a prompt at a user with no context for it
 * (they do not know what the agent is doing on which page), while answering no means exactly
 * "permission not given" — `confirm` returns false and `prompt` returns null, indistinguishable
 * from the user pressing Cancel, a path the page has to handle anyway.
 */
export const describeBrowserDialog = (
  request: BrowserDialogRequest,
  id: string = createBrowserDialogId()
): BrowserDialogState => ({
  id,
  kind: request.kind,
  origin: request.origin,
  message: request.message?.slice(0, 2000) ?? '',
  disposition: request.agentInitiated ? 'autoAnswer' : 'show',
  defaultAnswer: false,
});

export type BrowserUnloadContext = {
  /** 关闭 / 导航是不是用户点出来的 / Whether the close or navigation came from the user. */
  userInitiated: boolean;
  /** 页面注册了 beforeunload 处理器 / The page registered a beforeunload handler. */
  hasUnloadHandler: boolean;
};

export type BrowserUnloadVerdict =
  | { action: 'proceed' }
  | { action: 'confirm'; message: string }
  | { action: 'refuse'; message: string };

/**
 * 关闭一个注册了 beforeunload 的 tab 时该怎么做。
 *
 * 分成两条完全不同的路径，因为「谁在关」决定了丢掉的是谁的东西：
 *
 * - 用户在关 —— 页面声明有未保存内容，问一句再关。这就是普通浏览器的行为；
 * - Agent 在关 —— 直接拒绝。Agent 没有立场替用户丢掉用户自己填的表单，而且它也无从判断
 *   那份未保存内容值不值钱。拒绝之后 Agent 会看到一个明确的失败，用户的输入还在。
 *
 * What to do when closing a tab that registered beforeunload. Two entirely different paths,
 * because who is closing decides whose work is being discarded. If the user is closing, the page
 * has declared unsaved content and gets to ask once — ordinary browser behaviour. If the agent is
 * closing, it is refused: the agent has no standing to discard a form the user filled in, and no
 * way to judge what that unsaved content is worth. The refusal gives the agent an explicit
 * failure and leaves the user's input where it was.
 */
export const evaluateUnloadPrompt = (context: BrowserUnloadContext): BrowserUnloadVerdict => {
  if (!context.hasUnloadHandler) return { action: 'proceed' };
  if (context.userInitiated) {
    return { action: 'confirm', message: 'This page has unsaved changes. Close it anyway?' };
  }
  return {
    action: 'refuse',
    message: 'This tab has unsaved changes and was not closed. Close it yourself if you no longer need it.',
  };
};

/**
 * Chromium 自己也不允许用户点「继续访问」的证书错误。
 *
 * 这几类不是「证书配得不对」，而是「有人在中间」或「证书已被明确宣告无效」。给一个
 * 「仍要继续」的按钮等于把一次确认变成一次自伤，所以这里也不给。
 *
 * Certificate errors Chromium itself does not let the user click through. These do not mean "the
 * certificate is misconfigured" but "someone is in the middle" or "this certificate has been
 * explicitly declared invalid". Offering a Proceed button would turn a confirmation into an act
 * of self-harm, so none is offered here either.
 */
const UNRECOVERABLE_CERTIFICATE_ERRORS = new Set([
  'net::ERR_CERT_REVOKED',
  'net::ERR_CERT_KNOWN_INTERCEPTION_BLOCKED',
  'net::ERR_SSL_PINNED_KEY_NOT_IN_CERT_CHAIN',
  'net::ERR_CERT_SYMANTEC_LEGACY',
  'net::ERR_CERT_INVALID',
]);

export type BrowserCertificateVerdict = { action: 'refuse'; message: string } | { action: 'confirm'; message: string };

/**
 * 证书错误的处理。
 *
 * 两条硬规则：
 *
 * 1. 永远不自动信任。`event.preventDefault()` + `callback(true)` 是 Electron 应用里最常见的
 *    一行「先让它跑起来」的代码，而它把整个 HTTPS 降级成明文可改；
 * 2. Agent 驱动的导航一律拒绝，连问都不问。证书错误意味着这一跳的内容不可信，而 Agent
 *    接下来要做的事情全部建立在这些内容之上 —— 它没有能力识别自己读到的是被篡改过的页面。
 *
 * Handling of certificate errors, under two hard rules. Never trust automatically:
 * `event.preventDefault()` followed by `callback(true)` is the single most common line of
 * make-it-work code in Electron apps, and it downgrades all of HTTPS to plaintext-modifiable.
 * And refuse agent-driven navigations outright, without asking: a certificate error means this
 * hop's content is untrustworthy, everything the agent does next is built on that content, and it
 * has no way to tell that what it read had been tampered with.
 */
export const evaluateCertificateError = (context: {
  error: string;
  hostname: string;
  agentInitiated: boolean;
}): BrowserCertificateVerdict => {
  if (UNRECOVERABLE_CERTIFICATE_ERRORS.has(context.error)) {
    return {
      action: 'refuse',
      message: `The connection to ${context.hostname} is not private and cannot be continued (${context.error}).`,
    };
  }
  if (context.agentInitiated) {
    return {
      action: 'refuse',
      message: `The certificate for ${context.hostname} is not valid (${context.error}). Agent navigation was stopped.`,
    };
  }
  return {
    action: 'confirm',
    message: `The certificate for ${context.hostname} is not valid (${context.error}). Continue anyway?`,
  };
};
