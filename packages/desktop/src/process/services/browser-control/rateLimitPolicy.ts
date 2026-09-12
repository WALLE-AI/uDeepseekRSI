/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

type OriginBudget = { failures: number; retryAt: number };

export class OriginRateLimiter {
  readonly #budgets = new Map<string, OriginBudget>();
  readonly #now: () => number;
  readonly #random: () => number;

  constructor(options: { now?: () => number; random?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
  }

  recordRateLimit(url: string, serverRetryAt: number | null): number | null {
    const origin = this.#origin(url);
    if (!origin) return null;
    const previous = this.#budgets.get(origin);
    const failures = (previous?.failures ?? 0) + 1;
    const exponentialMs = Math.min(60_000, 1_000 * 2 ** Math.min(failures - 1, 6));
    const retryAt =
      serverRetryAt ??
      this.#now() + exponentialMs + Math.floor(exponentialMs * 0.25 * Math.max(0, Math.min(1, this.#random())));
    const circuitRetryAt = failures >= 5 ? Math.max(retryAt, this.#now() + 5 * 60_000) : retryAt;
    this.#budgets.set(origin, { failures, retryAt: circuitRetryAt });
    return circuitRetryAt;
  }

  blockedUntil(url: string): number | null {
    const origin = this.#origin(url);
    if (!origin) return null;
    const budget = this.#budgets.get(origin);
    if (!budget) return null;
    if (budget.retryAt <= this.#now()) return null;
    return budget.retryAt;
  }

  recordSuccess(url: string): void {
    const origin = this.#origin(url);
    if (origin) this.#budgets.delete(origin);
  }

  #origin(url: string): string | null {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  }
}
