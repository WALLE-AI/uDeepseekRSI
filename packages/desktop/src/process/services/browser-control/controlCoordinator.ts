/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BrowserControlIdentity, BrowserControlResult } from './types';

type Lease = { identity: BrowserControlIdentity; expiresAt: number; userPaused: boolean };
type CachedAction = { value: unknown; expiresAt: number };

const sameSession = (left: BrowserControlIdentity, right: BrowserControlIdentity): boolean =>
  left.controlSessionId === right.controlSessionId && left.turnId === right.turnId;

export class BrowserControlCoordinator {
  readonly #leases = new Map<string, Lease>();
  readonly #actions = new Map<string, CachedAction>();
  readonly #pausedTargets = new Set<string>();
  readonly #now: () => number;
  readonly #leaseTtlMs: number;
  readonly #actionTtlMs: number;

  constructor(options: { now?: () => number; leaseTtlMs?: number; actionTtlMs?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#leaseTtlMs = options.leaseTtlMs ?? 15_000;
    this.#actionTtlMs = options.actionTtlMs ?? 60_000;
  }

  acquireWrite(targetId: string, identity: BrowserControlIdentity): BrowserControlResult<{ expiresAt: number }> {
    this.sweep();
    if (this.#pausedTargets.has(targetId)) {
      return { ok: false, code: 'USER_TOOK_CONTROL', message: 'The user paused agent control for this tab.' };
    }
    const current = this.#leases.get(targetId);
    if (current && !sameSession(current.identity, identity)) {
      return { ok: false, code: 'TARGET_BUSY', message: 'Another agent session controls this tab.' };
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

  cachedAction<T>(actionId: string): T | undefined {
    this.sweep();
    return this.#actions.get(actionId)?.value as T | undefined;
  }

  rememberAction<T>(actionId: string, value: T): T {
    this.#actions.set(actionId, { value, expiresAt: this.#now() + this.#actionTtlMs });
    return value;
  }

  sweep(): void {
    const now = this.#now();
    for (const [targetId, lease] of this.#leases) {
      if (lease.expiresAt <= now) this.#leases.delete(targetId);
    }
    for (const [actionId, action] of this.#actions) {
      if (action.expiresAt <= now) this.#actions.delete(actionId);
    }
  }
}
