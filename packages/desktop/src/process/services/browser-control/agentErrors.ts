/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent 能看到的浏览器错误文案。
 *
 * 这些字符串最终会穿过 CDP -> Puppeteer -> MCP 三层，作为工具调用的失败结果落进模型的
 * 上下文。模型对它们的唯一处理方式是「读一遍，然后决定下一步」——所以每一条都必须回答
 * 两个问题：出了什么事（稳定的大写前缀，便于统计和模型模式匹配），以及现在该做什么。
 *
 * 之前的文案只回答了第一个问题。像「requires an explicit user-confirmed AionUi workflow」
 * 这种说法对人类读者是清楚的，对模型则是死路：它不知道该重试、该换工具、还是该问用户，
 * 实际表现就是原地重试到放弃。
 *
 * The browser error text an agent actually sees. These strings travel through CDP ->
 * Puppeteer -> MCP and land in the model's context as a failed tool result. The model's only
 * response is to read one and decide what to do next, so every message answers two questions:
 * what happened (a stable upper-case prefix, which also gives telemetry a join key), and what
 * to do now.
 *
 * The previous wording answered only the first. "requires an explicit user-confirmed AionUi
 * workflow" is clear to a human reader and a dead end for a model: it cannot tell whether to
 * retry, switch tools, or ask the user, so in practice it retries until it gives up.
 *
 * 纯字符串构造，不碰 IO，因此可以完整单测。
 * Pure string construction with no IO, so it is fully unit-testable.
 */

import type { BrowserControlErrorCode } from './types';

/** `CODE: sentence` — the shape every agent-visible browser error shares. */
export const agentError = (code: BrowserControlErrorCode, nextStep: string): string => `${code}: ${nextStep}`;

/**
 * 一个 CDP 命令被能力黑名单拒绝。
 *
 * 这类能力（文件选择、JS 对话框、cookie 写入、下载行为）都有 AionUi 自己的、带用户确认的
 * 实现路径，Agent 永远拿不到原始命令。所以这里明确说「不要重试」——否则模型会把它当成
 * 偶发失败。
 *
 * A CDP command was refused by the capability blocklist. Each of these capabilities (file
 * choosers, JS dialogs, cookie writes, download behaviour) has its own user-confirmed AionUi
 * path and is never reachable from raw agent control, so the message says "do not retry"
 * outright — otherwise the model reads it as a transient failure.
 */
export const capabilityBlockedError = (method: string): string =>
  agentError(
    'CAPABILITY_BLOCKED',
    `${method} is handled by AionUi's own user-confirmed workflow and is never available to agent control. Do not retry it. Tell the user what you need them to do, then continue with the rest of the task.`
  );

/** Cookies and submitted form data are structurally out of reach; retrying cannot help. */
export const sensitiveReadBlockedError = (): string =>
  agentError(
    'SENSITIVE_READ_BLOCKED',
    'Browser cookies and submitted form data are never exposed to agent control. Do not retry. Continue without them, and ask the user if the task genuinely cannot proceed.'
  );

/**
 * 没有可操作的标签。
 *
 * 指向 list_pages 而不是 new_page：标签可能其实存在，只是这次命令的 session 没绑上。
 * 先看一眼比直接开新标签更省，也避免在用户屏幕上堆空白页。
 *
 * No usable tab. Points at list_pages rather than new_page because a tab may well exist and
 * merely not be bound to this command's session; looking first is cheaper than opening one,
 * and avoids piling blank pages onto the user's screen.
 */
export const noBrowserTargetError = (): string =>
  agentError(
    'NO_TARGET',
    'No browser tab is attached to this command. Call list_pages first; if it returns nothing, call new_page to open one.'
  );

/**
 * 引用了一个不存在的 targetId。
 *
 * 几乎总是「模型记住了一个已经被关掉的标签」，所以下一步是重新列一遍，而不是重试。
 *
 * A targetId that does not exist. Almost always a tab the model remembered after it was
 * closed, so the next step is to re-list rather than retry.
 */
export const unknownTargetError = (targetId: string): string =>
  agentError(
    'TARGET_CLOSED',
    `No browser tab with id ${targetId || '(unspecified)'}. It was probably closed. Call list_pages to get the current tabs and use one of those ids.`
  );

/** Tab creation is wired through the renderer; without it the agent must reuse what exists. */
export const targetCreateUnavailableError = (): string =>
  agentError(
    'NO_TARGET',
    'Opening new browser tabs is not available in this session. Call list_pages and reuse an existing tab, or ask the user to open one.'
  );

/**
 * 导航被网络策略挡下。
 *
 * 保留 networkPolicy 给出的具体原因（私网、云元数据、协议不支持等），只是补上前缀和
 * 「别换写法重试」——这类拦截是按目标地址判定的，改 URL 形状绕不过去，模型试了只是浪费轮次。
 *
 * A navigation refused by the network policy. Keeps networkPolicy's specific reason (private
 * range, cloud metadata, unsupported scheme) and only adds the prefix plus "do not reshape the
 * URL and retry" — the decision is made on the resolved target, so retrying burns turns.
 */
export const navigationBlockedError = (reason: string): string =>
  agentError('NAVIGATION_BLOCKED', `${reason} Do not retry with a different URL shape; use a public source instead.`);

/** CDP commands that would reach outside the in-app browser's single-context model. */
export const unsupportedBrowserCommandError = (method: string): string =>
  agentError(
    'CAPABILITY_BLOCKED',
    `${method} does not apply to the in-app browser, which has one shared context that the agent cannot create, dispose, or close. Do not retry; use list_pages, new_page, and close_page instead.`
  );

/** The renderer did not finish creating and registering the tab inside the wait window. */
export const targetCreateTimeoutError = (): string =>
  agentError(
    'TARGET_CREATE_TIMEOUT',
    'The browser tab did not attach in time. Call list_pages to check whether it appeared anyway, then retry once.'
  );

/**
 * 写命令被控制状态机冻结时，按状态给出不同的下一步。
 *
 * 分状态而不是一句通用文案，是因为这五种状态对模型的要求完全相反：等用户、问用户、退避、
 * 换来源。给一句「paused」等于什么都没说。
 *
 * Write commands frozen by the control state machine, with a different next step per state.
 * Split rather than generic because the five states demand opposite behaviour — wait for the
 * user, ask the user, back off, or switch sources. A single "paused" says none of that.
 */
export const pausedWriteError = (state: string, retryAt?: number | null): string => {
  if (state === 'userTakeover') {
    return agentError(
      'USER_TOOK_CONTROL',
      'The user took over this tab. Stop issuing write commands and wait until they hand control back.'
    );
  }
  if (state === 'challengeRequired') {
    return agentError(
      'CHALLENGE_REQUIRED',
      'This page is showing a verification challenge. Ask the user to complete it in the Browser tab, then retry once.'
    );
  }
  if (state === 'rateLimited') {
    const until = typeof retryAt === 'number' ? ` Retry after ${new Date(retryAt).toISOString()}.` : '';
    return agentError(
      'RATE_LIMITED',
      `This site is rate limiting requests.${until} Do not retry sooner with a different URL shape; work on something else or use another source.`
    );
  }
  if (state === 'authenticationRequired') {
    return agentError(
      'AUTHENTICATION_REQUIRED',
      'This page needs a signed-in session. Ask the user to sign in from the Browser tab, then retry once.'
    );
  }
  if (state === 'accessDenied') {
    return agentError(
      'ACCESS_DENIED',
      'This site refused access. Do not retry; find the information from a different source.'
    );
  }
  return agentError('TARGET_BUSY', `Browser write commands are paused (${state}). Wait before retrying.`);
};

/**
 * 挑战/登录态期间的敏感读拦截。
 *
 * 和 pausedWriteError 分开：读命令被挡的原因是「页面上现在是验证界面，读到的东西没有意义
 * 而且可能含凭据」，下一步和写命令一样是找用户，但模型需要知道读也被挡了，否则会以为
 * 换个读工具就能绕过去。
 *
 * Sensitive reads blocked during a challenge or sign-in wall. Kept separate from
 * pausedWriteError: reads are blocked because the page currently shows a verification UI, so
 * whatever is read is meaningless and may carry credentials. The next step matches the write
 * case, but the model needs to know reads are blocked too — otherwise it assumes a different
 * read tool will get around it.
 */
export const challengeReadBlockedError = (state: string): string =>
  agentError(
    state === 'authenticationRequired' ? 'AUTHENTICATION_REQUIRED' : 'CHALLENGE_REQUIRED',
    'The page is showing a verification or sign-in wall, so its content is not readable by the agent. Ask the user to complete it in the Browser tab, then retry once.'
  );

/** A navigation the rate limiter is still holding down. */
export const rateLimitedNavigationError = (retryAt: number): string =>
  agentError(
    'RATE_LIMITED',
    `This site is rate limiting requests. Retry after ${new Date(retryAt).toISOString()}; until then use another source rather than retrying with a different URL shape.`
  );
