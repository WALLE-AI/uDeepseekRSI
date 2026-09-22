/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  filterToolListFrame,
  isSuppressedBrowserTool,
  JsonLineBuffer,
  SUPPRESSED_BROWSER_TOOLS,
  suppressedToolCall,
  transformJsonLine,
} from '@/process/resources/builtinMcp/browserToolFilter';

const toolListResponse = (names: string[]) => ({
  jsonrpc: '2.0',
  id: 7,
  result: { tools: names.map((name) => ({ name, description: `${name} does something` })) },
});

describe('SUPPRESSED_BROWSER_TOOLS', () => {
  it('covers the tools the CDP facade can never serve', () => {
    // upload_file -> DOM.setFileInputFiles, handle_dialog -> Page.handleJavaScriptDialog:
    // 两条都在 actionPolicy 的黑名单里。lighthouse_audit 要 tracing 域，伪装层没实现。
    //
    // Both of the first two run on methods actionPolicy blocks; lighthouse_audit needs the
    // tracing domain the facade does not implement.
    expect(SUPPRESSED_BROWSER_TOOLS.map((tool) => tool.name)).toEqual([
      'upload_file',
      'handle_dialog',
      'lighthouse_audit',
    ]);
  });

  it('gives every suppressed tool an actionable alternative', () => {
    for (const tool of SUPPRESSED_BROWSER_TOOLS) {
      expect(tool.guidance).toMatch(/\b(Ask|Tell|Use)\b/);
    }
  });
});

describe('isSuppressedBrowserTool', () => {
  it('matches only the listed names', () => {
    expect(isSuppressedBrowserTool('upload_file')).toBe(true);
    expect(isSuppressedBrowserTool('take_snapshot')).toBe(false);
    expect(isSuppressedBrowserTool(undefined)).toBe(false);
    expect(isSuppressedBrowserTool(42)).toBe(false);
  });
});

describe('filterToolListFrame', () => {
  it('removes suppressed tools from a tools/list result', () => {
    const filtered = filterToolListFrame(toolListResponse(['take_snapshot', 'upload_file', 'click'])) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(filtered.result.tools.map((tool) => tool.name)).toEqual(['take_snapshot', 'click']);
  });

  it('preserves everything else in the frame', () => {
    const filtered = filterToolListFrame(toolListResponse(['click', 'handle_dialog'])) as {
      jsonrpc: string;
      id: number;
      result: { tools: Array<{ name: string; description: string }> };
    };
    expect(filtered.jsonrpc).toBe('2.0');
    expect(filtered.id).toBe(7);
    expect(filtered.result.tools[0]?.description).toBe('click does something');
  });

  it('returns the original object when nothing was removed, so the line is forwarded verbatim', () => {
    // 同一性是「原样转发」的判定依据：没改动就不重新序列化，避免无谓地改写字节。
    // Identity is how the caller decides to forward verbatim: unchanged frames are never
    // re-serialized, so bytes are not rewritten for nothing.
    const frame = toolListResponse(['click', 'take_snapshot']);
    expect(filterToolListFrame(frame)).toBe(frame);
  });

  it('leaves frames that are not tool lists alone', () => {
    for (const frame of [
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', method: 'notifications/message', params: { name: 'upload_file' } },
      { jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'nope' } },
      null,
      'not an object',
      [1, 2, 3],
    ]) {
      expect(filterToolListFrame(frame)).toBe(frame);
    }
  });
});

describe('suppressedToolCall', () => {
  it('answers a suppressed call in place, with the id the caller used', () => {
    const intercepted = suppressedToolCall({
      jsonrpc: '2.0',
      id: 'abc',
      method: 'tools/call',
      params: { name: 'upload_file', arguments: { uid: '1' } },
    });
    expect(intercepted?.id).toBe('abc');
    expect(intercepted?.response.id).toBe('abc');
    const result = intercepted?.response.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    // 前缀要和 bridge 的错误码体系一致，否则 persona 里教的那套对不上。
    // The prefix must match the bridge's error vocabulary, or the persona's rules do not apply.
    expect(result.content[0]?.text).toMatch(/^CAPABILITY_BLOCKED: upload_file /);
    expect(result.content[0]?.text).toContain('Ask the user to attach the file');
  });

  it('lets every other tool call through', () => {
    expect(suppressedToolCall({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'click' } })).toBeNull();
    expect(suppressedToolCall({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toBeNull();
    expect(suppressedToolCall({ jsonrpc: '2.0', id: 1, method: 'tools/call' })).toBeNull();
    expect(suppressedToolCall(null)).toBeNull();
  });

  it('still answers a notification-shaped call rather than dropping it', () => {
    const intercepted = suppressedToolCall({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'handle_dialog' } });
    expect(intercepted?.response.id).toBeNull();
  });
});

describe('JsonLineBuffer', () => {
  it('emits only complete lines and keeps the remainder', () => {
    const buffer = new JsonLineBuffer();
    expect(buffer.push('{"a":')).toEqual([]);
    expect(buffer.push('1}\n{"b":2}\n{"c"')).toEqual(['{"a":1}', '{"b":2}']);
    expect(buffer.push(':3}\n')).toEqual(['{"c":3}']);
  });

  it('tolerates CRLF, which the MCP stdio framing also strips', () => {
    expect(new JsonLineBuffer().push('{"a":1}\r\n')).toEqual(['{"a":1}']);
  });

  it('splits a chunk carrying several frames at once', () => {
    expect(new JsonLineBuffer().push('1\n2\n3\n')).toEqual(['1', '2', '3']);
  });
});

describe('transformJsonLine', () => {
  it('rewrites a line whose frame changed', () => {
    const line = JSON.stringify(toolListResponse(['click', 'upload_file']));
    expect(JSON.parse(transformJsonLine(line, filterToolListFrame))).toEqual(toolListResponse(['click']));
  });

  it('returns the exact original string when the frame is untouched', () => {
    const line = JSON.stringify(toolListResponse(['click']));
    expect(transformJsonLine(line, filterToolListFrame)).toBe(line);
  });

  it('passes through unparseable and blank lines rather than corrupting the stream', () => {
    // 代理的职责是过滤三个已知工具，不是替上游做协议校验。看不懂的就别动。
    // The proxy filters three known tools; it does not validate the protocol for upstream.
    expect(transformJsonLine('not json', filterToolListFrame)).toBe('not json');
    expect(transformJsonLine('', filterToolListFrame)).toBe('');
    expect(transformJsonLine('   ', filterToolListFrame)).toBe('   ');
  });
});
