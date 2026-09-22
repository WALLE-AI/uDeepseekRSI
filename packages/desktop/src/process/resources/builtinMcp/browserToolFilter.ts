/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 把结构性不可能成功的浏览器工具从工具面上摘掉。
 *
 * 上游 chrome-devtools-mcp 不知道自己连的是 AionUi 的 CDP 伪装层，所以照常注册
 * `upload_file` 和 `handle_dialog`。这两个工具底下走的是 `DOM.setFileInputFiles` 和
 * `Page.handleJavaScriptDialog` —— 两条都在 actionPolicy 的能力黑名单里，AionUi 自己有
 * 带用户确认的实现。也就是说模型每次调用都必然失败，而它没法从工具描述里看出这一点。
 * `lighthouse_audit` 同理：它要的 tracing 域这个伪装层根本没实现。
 *
 * 这三个没法用 `--category-*` 摘：upload_file/handle_dialog 属 input 类，lighthouse_audit
 * 和 take_snapshot 同属 debugging 类，按类别关会把真正要用的工具一起关掉。所以只能在
 * MCP 协议层上拦。
 *
 * Drop browser tools that can never succeed. Upstream chrome-devtools-mcp does not know it is
 * talking to AionUi's CDP facade, so it registers `upload_file` and `handle_dialog` as usual.
 * Both run on `DOM.setFileInputFiles` and `Page.handleJavaScriptDialog`, which actionPolicy
 * blocks because AionUi owns a user-confirmed flow for each — so every call fails, and nothing
 * in the tool description tells the model that. `lighthouse_audit` is the same story: the
 * tracing domain it needs is not implemented by the facade.
 *
 * None of the three can be removed with `--category-*`: upload_file and handle_dialog are in
 * the input category, and lighthouse_audit shares the debugging category with take_snapshot.
 * Filtering at the MCP protocol layer is the only option that does not take real tools with it.
 *
 * 纯函数：帧进帧出，不碰进程和流，因此可以完整单测。
 * Pure functions over frames — no process or stream access — so this is fully unit-testable.
 */

/** Tools removed from the advertised surface, each with the reason it can never succeed. */
export const SUPPRESSED_BROWSER_TOOLS: ReadonlyArray<{ name: string; guidance: string }> = [
  {
    name: 'upload_file',
    guidance:
      "File uploads go through AionUi's own confirmed picker, not agent control. Ask the user to attach the file, then continue.",
  },
  {
    name: 'handle_dialog',
    guidance:
      'Browser dialogs are answered by AionUi with the user, not by the agent. Tell the user a dialog is waiting, then continue.',
  },
  {
    name: 'lighthouse_audit',
    guidance:
      'Performance auditing is not available against the in-app browser. Use take_snapshot and list_network_requests instead.',
  },
];

const SUPPRESSED_NAMES = new Set(SUPPRESSED_BROWSER_TOOLS.map((tool) => tool.name));

/** Whether this tool is one the facade can never serve. */
export const isSuppressedBrowserTool = (name: unknown): boolean =>
  typeof name === 'string' && SUPPRESSED_NAMES.has(name);

type JsonFrame = Record<string, unknown>;

const asRecord = (value: unknown): JsonFrame | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonFrame) : null;

/**
 * 从 `tools/list` 的响应里剔除被抑制的工具。
 *
 * 按「result 里有 tools 数组」识别，而不是追踪请求 id：这个形状只有 tools/list 的响应会有，
 * 而追踪 id 意味着要在代理里维护一份会跨重连的状态 —— 多出来的状态比它解决的问题更容易出错。
 *
 * Strip suppressed tools from a `tools/list` response. Recognised by shape — a `tools` array
 * inside `result` — rather than by tracking request ids: only tools/list responses carry that
 * shape, and id tracking would mean holding state across reconnects in the proxy, which is more
 * error-prone than the problem it solves.
 */
export const filterToolListFrame = (frame: unknown): unknown => {
  const record = asRecord(frame);
  const result = record ? asRecord(record.result) : null;
  if (!result || !Array.isArray(result.tools)) return frame;
  const tools = result.tools.filter((tool) => !isSuppressedBrowserTool(asRecord(tool)?.name));
  if (tools.length === result.tools.length) return frame;
  return { ...record, result: { ...result, tools } };
};

/**
 * 被抑制工具的调用请求，以及该回给它的错误响应。
 *
 * 即便工具已经不在列表里，调用仍可能到达：模型可能是照着更早一轮的上下文调的。回一个
 * 带下一步的错误，比让它下穿到上游拿一句 "Unknown tool" 要有用。
 *
 * A call to a suppressed tool, and the error to answer it with. Calls still arrive after the
 * tool is gone from the list, because the model may be working from an earlier turn's context.
 * Answering with an actionable error beats letting it reach upstream and come back as
 * "Unknown tool".
 */
export const suppressedToolCall = (frame: unknown): { id: unknown; response: JsonFrame } | null => {
  const record = asRecord(frame);
  if (!record || record.method !== 'tools/call') return null;
  const params = asRecord(record.params);
  const name = params?.name;
  if (!isSuppressedBrowserTool(name)) return null;
  const guidance = SUPPRESSED_BROWSER_TOOLS.find((tool) => tool.name === name)?.guidance ?? '';
  return {
    id: record.id,
    response: {
      jsonrpc: '2.0',
      id: record.id ?? null,
      result: {
        content: [{ type: 'text', text: `CAPABILITY_BLOCKED: ${String(name)} is not available. ${guidance}` }],
        isError: true,
      },
    },
  };
};

/**
 * 按换行切帧的累积缓冲。
 *
 * MCP stdio 的分帧就是「一行一条 JSON」（见 SDK 的 ReadBuffer），`\r` 要容忍。解析失败的
 * 行原样放行 —— 代理的职责是过滤已知的几个工具，不是替上游做协议校验，看不懂就别动。
 *
 * Newline-framed accumulating buffer. MCP stdio frames one JSON message per line (see the SDK's
 * ReadBuffer) and tolerates a trailing `\r`. Unparseable lines pass through untouched: the
 * proxy's job is to filter three known tools, not to validate the protocol on upstream's behalf,
 * so anything it does not understand is left alone.
 */
export class JsonLineBuffer {
  #pending = '';

  /** Feed a chunk; returns every complete line it produced, without terminators. */
  push(chunk: string): string[] {
    this.#pending += chunk;
    const lines: string[] = [];
    let index = this.#pending.indexOf('\n');
    while (index !== -1) {
      lines.push(this.#pending.slice(0, index).replace(/\r$/, ''));
      this.#pending = this.#pending.slice(index + 1);
      index = this.#pending.indexOf('\n');
    }
    return lines;
  }
}

/** Parse, transform, re-serialize — leaving anything unparseable exactly as it arrived. */
export const transformJsonLine = (line: string, transform: (frame: unknown) => unknown): string => {
  if (!line.trim()) return line;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line;
  }
  const next = transform(parsed);
  return next === parsed ? line : JSON.stringify(next);
};
