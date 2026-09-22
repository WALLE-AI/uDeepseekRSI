/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  agentError,
  capabilityBlockedError,
  challengeReadBlockedError,
  navigationBlockedError,
  noBrowserTargetError,
  pausedWriteError,
  rateLimitedNavigationError,
  sensitiveReadBlockedError,
  targetCreateTimeoutError,
  targetCreateUnavailableError,
  unknownTargetError,
  unsupportedBrowserCommandError,
} from '@process/services/browser-control/agentErrors';

/**
 * 每条文案都要通过两项检查：稳定的大写前缀（模型据此分类、遥测据此聚合），以及一句
 * 可执行的下一步。少了前缀，统计就没有 join key；少了下一步，模型只会原地重试。
 *
 * Every message passes two checks: a stable upper-case prefix (how the model classifies and
 * how telemetry aggregates) and one actionable next step. Without the prefix telemetry has no
 * join key; without the next step the model just retries in place.
 */
const ACTIONABLE = /\b(Call|Ask|Tell|Wait|Retry|Do not retry|Continue|Stop|find|use)\b/;

const allMessages = (): Array<[string, string]> => [
  ['capabilityBlocked', capabilityBlockedError('DOM.setFileInputFiles')],
  ['sensitiveReadBlocked', sensitiveReadBlockedError()],
  ['noBrowserTarget', noBrowserTargetError()],
  ['unknownTarget', unknownTargetError('aionui-browser-1')],
  ['targetCreateUnavailable', targetCreateUnavailableError()],
  ['targetCreateTimeout', targetCreateTimeoutError()],
  ['navigationBlocked', navigationBlockedError('The host resolves to a private address.')],
  ['unsupportedBrowserCommand', unsupportedBrowserCommandError('Browser.close')],
  ['rateLimitedNavigation', rateLimitedNavigationError(Date.UTC(2026, 0, 1))],
  ['pausedWrite:userTakeover', pausedWriteError('userTakeover')],
  ['pausedWrite:challengeRequired', pausedWriteError('challengeRequired')],
  ['pausedWrite:rateLimited', pausedWriteError('rateLimited', Date.UTC(2026, 0, 1))],
  ['pausedWrite:authenticationRequired', pausedWriteError('authenticationRequired')],
  ['pausedWrite:accessDenied', pausedWriteError('accessDenied')],
  ['challengeRead:challenge', challengeReadBlockedError('challengeRequired')],
  ['challengeRead:auth', challengeReadBlockedError('authenticationRequired')],
];

describe('agentError', () => {
  it('formats as CODE: sentence', () => {
    expect(agentError('TARGET_BUSY', 'Do something else.')).toBe('TARGET_BUSY: Do something else.');
  });
});

describe('browser agent error messages', () => {
  it.each(allMessages())('%s starts with a stable upper-case code', (_label, message) => {
    expect(message).toMatch(/^[A-Z][A-Z_]+: \S/);
  });

  it.each(allMessages())('%s tells the agent what to do next', (_label, message) => {
    expect(message).toMatch(ACTIONABLE);
  });
});

describe('capabilityBlockedError', () => {
  it('names the method so the model can tell which capability it lost', () => {
    expect(capabilityBlockedError('Network.setCookie')).toContain('Network.setCookie');
  });

  it('forbids retrying, because the block is structural rather than transient', () => {
    expect(capabilityBlockedError('Network.setCookie')).toContain('Do not retry');
  });
});

describe('pausedWriteError', () => {
  it('maps each control state to its own code, since the required behaviour differs', () => {
    expect(pausedWriteError('userTakeover')).toMatch(/^USER_TOOK_CONTROL: /);
    expect(pausedWriteError('challengeRequired')).toMatch(/^CHALLENGE_REQUIRED: /);
    expect(pausedWriteError('rateLimited')).toMatch(/^RATE_LIMITED: /);
    expect(pausedWriteError('authenticationRequired')).toMatch(/^AUTHENTICATION_REQUIRED: /);
    expect(pausedWriteError('accessDenied')).toMatch(/^ACCESS_DENIED: /);
  });

  it('includes the retry time only when one is known', () => {
    const at = Date.UTC(2026, 0, 1, 12, 30);
    expect(pausedWriteError('rateLimited', at)).toContain(new Date(at).toISOString());
    expect(pausedWriteError('rateLimited')).not.toContain('Retry after');
  });

  it('falls back to a generic pause rather than inventing a code for an unknown state', () => {
    expect(pausedWriteError('somethingNew')).toMatch(/^TARGET_BUSY: /);
    expect(pausedWriteError('somethingNew')).toContain('somethingNew');
  });
});

describe('challengeReadBlockedError', () => {
  it('reports the sign-in wall under its own code so the user is asked to sign in, not to verify', () => {
    expect(challengeReadBlockedError('authenticationRequired')).toMatch(/^AUTHENTICATION_REQUIRED: /);
    expect(challengeReadBlockedError('challengeRequired')).toMatch(/^CHALLENGE_REQUIRED: /);
  });
});

describe('navigationBlockedError', () => {
  it('keeps the policy reason and adds the prefix plus a next step', () => {
    const message = navigationBlockedError('The host resolves to a private address.');
    expect(message).toMatch(/^NAVIGATION_BLOCKED: /);
    expect(message).toContain('The host resolves to a private address.');
    expect(message).toContain('Do not retry');
  });
});

describe('unknownTargetError', () => {
  it('points at list_pages, because the tab was almost certainly closed', () => {
    expect(unknownTargetError('gone')).toMatch(/^TARGET_CLOSED: /);
    expect(unknownTargetError('gone')).toContain('list_pages');
  });

  it('stays readable when no id was supplied at all', () => {
    expect(unknownTargetError('')).toContain('(unspecified)');
  });
});
