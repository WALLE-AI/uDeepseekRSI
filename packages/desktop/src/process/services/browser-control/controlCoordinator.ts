/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BrowserControlIdentity, BrowserControlResult } from './types';

type Lease = { identity: BrowserControlIdentity; expiresAt: number; userPaused: boolean };

/**
 * 这里曾有一份写命令结果缓存（cachedAction/rememberAction），已删除。
 *
 * 它的 key 由调用方拼成 `${connection.id}:${cdp 请求 id}:${method}`，而 CDP 请求 id 是每条
 * 连接内单调递增、永不复用的，所以这个 60s TTL 的 Map 只写不读 —— 从来没有命中过一次。
 *
 * 也没有改成「真幂等键」（targetId + method + params 哈希）：那样会把合法的重复操作吞掉。
 * 连点两次「下一页」、连按两次同一个键都是真实场景，缓存一命中就变成「点了但没反应」，
 * 而这种现象极难排查。并发安全已经由租约和按 target 的写队列负责，重试去重不归这里管。
 *
 * A write-result cache used to live here and has been removed. Its key was composed by the
 * caller as `${connection.id}:${cdp request id}:${method}`, and CDP request ids are monotonic
 * and never reused within a connection — so the 60s Map was written to and never read from.
 *
 * It was not converted into a real idempotency key (targetId + method + params hash) either:
 * that would swallow legitimate repeats. Clicking "next page" twice or pressing the same key
 * twice are real, and a cache hit turns them into "it clicked but nothing happened", which is
 * very hard to diagnose. Concurrency is already handled by the lease and the per-target write
 * queue; retry de-duplication does not belong here.
 */

const sameSession = (left: BrowserControlIdentity, right: BrowserControlIdentity): boolean =>
  left.controlSessionId === right.controlSessionId && left.turnId === right.turnId;

export class BrowserControlCoordinator {
  readonly #leases = new Map<string, Lease>();
  readonly #pausedTargets = new Set<string>();
  readonly #now: () => number;
  readonly #leaseTtlMs: number;

  constructor(options: { now?: () => number; leaseTtlMs?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#leaseTtlMs = options.leaseTtlMs ?? 15_000;
  }

  acquireWrite(targetId: string, identity: BrowserControlIdentity): BrowserControlResult<{ expiresAt: number }> {
    this.sweep();
    if (this.#pausedTargets.has(targetId)) {
      return {
        ok: false,
        code: 'USER_TOOK_CONTROL',
        message: 'The user paused agent control for this tab. Wait until they hand control back before retrying.',
      };
    }
    const current = this.#leases.get(targetId);
    if (current && !sameSession(current.identity, identity)) {
      return {
        ok: false,
        code: 'TARGET_BUSY',
        message: 'Another agent session controls this tab. Call list_pages and work on a different page.',
      };
    }
    const expiresAt = this.#now() + this.#leaseTtlMs;
    this.#leases.set(targetId, { identity, expiresAt, userPaused: false });
    return { ok: true, data: { expiresAt } };
  }

  userTakeover(targetId: string): void {
    this.#pausedTargets.add(targetId);
    const current = this.#leases.get(targetId);
    if (current) current.userPaused = true;
  }

  resume(targetId: string): void {
    this.#pausedTargets.delete(targetId);
    const current = this.#leases.get(targetId);
    if (current) current.userPaused = false;
  }

  release(targetId: string, controlSessionId?: string): void {
    const current = this.#leases.get(targetId);
    if (!current || (controlSessionId && current.identity.controlSessionId !== controlSessionId)) return;
    this.#leases.delete(targetId);
  }

  releaseAll(controlSessionId: string): void {
    for (const [targetId, lease] of this.#leases) {
      if (lease.identity.controlSessionId === controlSessionId) this.#leases.delete(targetId);
    }
  }

  forgetTarget(targetId: string): void {
    this.#leases.delete(targetId);
    this.#pausedTargets.delete(targetId);
  }

  sweep(): void {
    const now = this.#now();
    for (const [targetId, lease] of this.#leases) {
      if (lease.expiresAt <= now) this.#leases.delete(targetId);
    }
  }
}
