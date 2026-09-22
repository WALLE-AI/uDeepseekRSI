/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { BrowserToolTally, errorCodeFromText, UNCODED_FAILURE } from '@/process/resources/builtinMcp/browserToolTally';

const call = (id: number | string, name: string) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name } });
const ok = (id: number | string) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'done' }] } });
const failed = (id: number | string, text: string) => ({
  jsonrpc: '2.0',
  id,
  result: { content: [{ type: 'text', text }], isError: true },
});

describe('errorCodeFromText', () => {
  it('reads the stable prefix the bridge emits', () => {
    expect(errorCodeFromText('RATE_LIMITED: back off until 2026-01-01.')).toBe('RATE_LIMITED');
    expect(errorCodeFromText('  USER_TOOK_CONTROL: wait.')).toBe('USER_TOOK_CONTROL');
  });

  it('does not mistake an upper-case word in prose for a code', () => {
    // 只认行首的 `CODE:`，否则上游的英文报错会被拆成一堆假错误码，统计就没法看了。
    // Only a line-leading `CODE:` counts; otherwise upstream English errors would shatter into
    // fake codes and the tally would be unreadable.
    expect(errorCodeFromText('Navigation to HTTP failed')).toBe(UNCODED_FAILURE);
    expect(errorCodeFromText('AB: too short to be a code')).toBe(UNCODED_FAILURE);
    expect(errorCodeFromText('')).toBe(UNCODED_FAILURE);
  });
});

describe('BrowserToolTally', () => {
  it('counts calls per tool and leaves successes out of the failure column', () => {
    const tally = new BrowserToolTally();
    tally.observeRequest(call(1, 'take_snapshot'));
    tally.observeResponse(ok(1));
    tally.observeRequest(call(2, 'take_snapshot'));
    tally.observeResponse(ok(2));

    expect(tally.summary()).toEqual([{ name: 'take_snapshot', calls: 2, failures: 0, codes: {} }]);
  });

  it('buckets failures by the error code that caused them', () => {
    const tally = new BrowserToolTally();
    tally.observeRequest(call(1, 'navigate_page'));
    tally.observeResponse(failed(1, 'RATE_LIMITED: back off.'));
    tally.observeRequest(call(2, 'navigate_page'));
    tally.observeResponse(failed(2, 'RATE_LIMITED: back off.'));
    tally.observeRequest(call(3, 'navigate_page'));
    tally.observeResponse(failed(3, 'NAVIGATION_BLOCKED: private address.'));

    expect(tally.summary()).toEqual([
      { name: 'navigate_page', calls: 3, failures: 3, codes: { RATE_LIMITED: 2, NAVIGATION_BLOCKED: 1 } },
    ]);
  });

  it('counts a transport-level JSON-RPC error as a failure', () => {
    const tally = new BrowserToolTally();
    tally.observeRequest(call(1, 'click'));
    tally.observeResponse({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } });

    expect(tally.summary()).toEqual([{ name: 'click', calls: 1, failures: 1, codes: { [UNCODED_FAILURE]: 1 } }]);
  });

  it('orders most-failing first, which is the order the next pruning decision needs', () => {
    const tally = new BrowserToolTally();
    for (const [id, name] of [
      [1, 'take_snapshot'],
      [2, 'take_snapshot'],
      [3, 'take_snapshot'],
    ] as const) {
      tally.observeRequest(call(id, name));
      tally.observeResponse(ok(id));
    }
    tally.observeRequest(call(9, 'upload_file'));
    tally.observeResponse(failed(9, 'CAPABILITY_BLOCKED: not available.'));

    expect(tally.summary().map((tool) => tool.name)).toEqual(['upload_file', 'take_snapshot']);
  });

  it('ignores responses it never saw a request for', () => {
    // 代理可能在会话中途才起来，或者上游自己发通知。认不出来的响应不能凭空造出一个工具。
    // The proxy may start mid-session, and upstream emits notifications of its own. An
    // unrecognised response must not conjure a tool out of nothing.
    const tally = new BrowserToolTally();
    tally.observeResponse(ok(99));
    tally.observeResponse(failed(98, 'RATE_LIMITED: x'));

    expect(tally.summary()).toEqual([]);
  });

  it('ignores frames that are not tool calls', () => {
    const tally = new BrowserToolTally();
    tally.observeRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    tally.observeRequest({ jsonrpc: '2.0', method: 'notifications/initialized' });
    tally.observeRequest(null);

    expect(tally.summary()).toEqual([]);
  });

  it('counts a notification-shaped call without leaking a pending entry', () => {
    const tally = new BrowserToolTally();
    tally.observeRequest({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'click' } });

    expect(tally.summary()).toEqual([{ name: 'click', calls: 1, failures: 0, codes: {} }]);
  });

  it('bounds pending requests so a response that never arrives cannot grow memory', () => {
    // 上限 256：超出后丢最旧的。统计精度可以牺牲，内存不行。
    // Cap of 256, dropping the oldest beyond it. Accuracy is negotiable; memory is not.
    const tally = new BrowserToolTally();
    for (let id = 0; id < 300; id += 1) tally.observeRequest(call(id, 'click'));
    // 最早的请求已被挤掉，它的响应不再被归因；最新的仍然归因得上。
    // The earliest request was evicted and its response no longer attributes; the newest still does.
    tally.observeResponse(failed(0, 'RATE_LIMITED: x'));
    tally.observeResponse(failed(299, 'RATE_LIMITED: x'));

    expect(tally.summary()).toEqual([{ name: 'click', calls: 300, failures: 1, codes: { RATE_LIMITED: 1 } }]);
  });
});

describe('BrowserToolTally.formatSummary', () => {
  it('returns null when nothing was called, so an idle session logs no line', () => {
    expect(new BrowserToolTally().formatSummary()).toBeNull();
  });

  it('reports ok/total per tool with the failure codes attached', () => {
    const tally = new BrowserToolTally();
    tally.observeRequest(call(1, 'click'));
    tally.observeResponse(ok(1));
    tally.observeRequest(call(2, 'click'));
    tally.observeResponse(failed(2, 'TARGET_BUSY: another session.'));

    expect(tally.formatSummary()).toBe('tool usage (ok/total): click 1/2 [TARGET_BUSY:1]');
  });

  it('omits the bracket for a tool that never failed', () => {
    const tally = new BrowserToolTally();
    tally.observeRequest(call(1, 'take_snapshot'));
    tally.observeResponse(ok(1));

    expect(tally.formatSummary()).toBe('tool usage (ok/total): take_snapshot 1/1');
  });
});
