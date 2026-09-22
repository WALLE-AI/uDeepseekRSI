/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 按工具名统计调用与失败，用来回答「哪些工具被调了但总是失败」。
 *
 * 统计放在 MCP 代理这一层，而不是 CDP 桥里，是因为只有这里同时看得见工具名和调用结果。
 * 桥那边只有 CDP 方法名（`Input.dispatchMouseEvent`），一个工具会拆成好几条命令，聚合出来
 * 的东西没法直接回答「该裁掉哪个工具」。
 *
 * 失败按错误码分桶。错误码就是 agentErrors.ts 定下的那套大写前缀，所以「模型看到什么」和
 * 「我们统计到什么」是同一个词汇表 —— 这正是当初把前缀做成稳定契约的第二个用途。
 *
 * Tally calls and failures per tool, to answer "which tools get called but always fail".
 *
 * This lives in the MCP proxy rather than the CDP bridge because only here are the tool name and
 * the call's outcome both visible. The bridge sees CDP method names (`Input.dispatchMouseEvent`),
 * and one tool becomes several commands, so an aggregate there cannot answer "which tool should
 * be dropped".
 *
 * Failures are bucketed by error code — the same upper-case prefixes agentErrors.ts defines — so
 * what the model reads and what telemetry counts share one vocabulary. That is the second purpose
 * of making the prefix a stable contract.
 *
 * 纯内存、纯逻辑，不碰流也不碰进程，因此可以完整单测。
 * Pure in-memory logic with no stream or process access, so it is fully unit-testable.
 */

/** One tool's record. `codes` counts failures by the error prefix that caused them. */
export type BrowserToolUsage = {
  name: string;
  calls: number;
  failures: number;
  codes: Record<string, number>;
};

/** Failures whose text carries no recognisable prefix — upstream errors, mostly. */
export const UNCODED_FAILURE = 'UNCODED';

/**
 * 待匹配请求的上限。
 *
 * 正常情况下每个请求都会收到响应然后被删掉，这个 Map 只会有个位数条目。设上限是为了防
 * 「响应永远不回来」把它撑爆 —— 统计数据再有用也不值得为它泄漏内存。
 *
 * Cap on in-flight requests. Normally each request gets a response and is deleted, so this Map
 * holds a handful of entries; the cap exists so a response that never arrives cannot grow it
 * without bound. No telemetry is worth leaking memory for.
 */
const MAX_PENDING = 256;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * 从工具结果文本里取出错误码前缀。
 *
 * 只认行首的 `CODE:`，且至少三个字符 —— 避免把正文里偶然出现的大写词当成错误码。
 *
 * Extract the error-code prefix from a tool result's text. Only a line-leading `CODE:` of at
 * least three characters counts, so an incidental upper-case word in prose is not mistaken for
 * an error code.
 */
export const errorCodeFromText = (text: string): string => {
  const match = /^([A-Z][A-Z_]{2,}):/.exec(text.trim());
  return match?.[1] ?? UNCODED_FAILURE;
};

export class BrowserToolTally {
  readonly #pending = new Map<string, string>();
  readonly #byTool = new Map<string, { calls: number; failures: number; codes: Map<string, number> }>();

  #record(name: string): { calls: number; failures: number; codes: Map<string, number> } {
    const existing = this.#byTool.get(name);
    if (existing) return existing;
    const created = { calls: 0, failures: 0, codes: new Map<string, number>() };
    this.#byTool.set(name, created);
    return created;
  }

  /** Count a `tools/call` and remember its id so the response can be attributed. */
  observeRequest(frame: unknown): void {
    const record = asRecord(frame);
    if (!record || record.method !== 'tools/call') return;
    const name = asRecord(record.params)?.name;
    if (typeof name !== 'string') return;
    this.#record(name).calls += 1;
    if (record.id === undefined || record.id === null) return;
    if (this.#pending.size >= MAX_PENDING) {
      const oldest = this.#pending.keys().next();
      if (!oldest.done) this.#pending.delete(oldest.value);
    }
    this.#pending.set(String(record.id), name);
  }

  /** Attribute a response to its tool and, when it failed, to an error code. */
  observeResponse(frame: unknown): void {
    const record = asRecord(frame);
    if (!record || record.id === undefined || record.id === null) return;
    const key = String(record.id);
    const name = this.#pending.get(key);
    if (!name) return;
    this.#pending.delete(key);

    const result = asRecord(record.result);
    // 传输层错误（JSON-RPC error）同样算失败，只是拿不到我们的码。
    // A transport-level JSON-RPC error counts as a failure too; it just carries no code of ours.
    const failed = result ? result.isError === true : record.error !== undefined;
    if (!failed) return;

    const entry = this.#record(name);
    entry.failures += 1;
    const content = Array.isArray(result?.content) ? result.content : [];
    const text = content.map((part) => asRecord(part)?.text).find((value) => typeof value === 'string');
    const code = typeof text === 'string' ? errorCodeFromText(text) : UNCODED_FAILURE;
    entry.codes.set(code, (entry.codes.get(code) ?? 0) + 1);
  }

  /** Most-failing first, then most-called — the order the next pruning decision needs. */
  summary(): BrowserToolUsage[] {
    return [...this.#byTool.entries()]
      .map(([name, entry]) => ({
        name,
        calls: entry.calls,
        failures: entry.failures,
        codes: Object.fromEntries([...entry.codes.entries()].toSorted((left, right) => right[1] - left[1])),
      }))
      .toSorted(
        (left, right) =>
          right.failures - left.failures || right.calls - left.calls || left.name.localeCompare(right.name)
      );
  }

  /**
   * 一行摘要，写进 stderr 汇入应用日志。`null` 表示这条会话没调过任何工具，不值得占一行。
   *
   * A one-line summary for stderr, which lands in the application log. `null` means the session
   * called no tools at all and does not deserve a line.
   */
  formatSummary(): string | null {
    const usage = this.summary();
    if (usage.length === 0) return null;
    const parts = usage.map((tool) => {
      const codes = Object.entries(tool.codes)
        .map(([code, count]) => `${code}:${count}`)
        .join(' ');
      return `${tool.name} ${tool.calls - tool.failures}/${tool.calls}${codes ? ` [${codes}]` : ''}`;
    });
    return `tool usage (ok/total): ${parts.join(', ')}`;
  }
}
