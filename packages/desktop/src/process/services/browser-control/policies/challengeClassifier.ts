/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export type BrowserResponseBlock =
  | { kind: 'none' }
  | { kind: 'rateLimited'; retryAt: number | null }
  | { kind: 'authenticationRequired' }
  | { kind: 'cloudflareChallenge' }
  | { kind: 'accessDenied' };

type BrowserResponse = {
  status: number;
  headers?: Record<string, string | number>;
  now?: number;
};

const normalizedHeaders = (headers: BrowserResponse['headers']): Map<string, string> =>
  new Map(Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), String(value)]));

const parseRetryAt = (value: string | undefined, now: number): number | null => {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(now, timestamp) : null;
};

/** Classify response metadata without reading or logging the challenge body. */
export const classifyBrowserResponse = (response: BrowserResponse): BrowserResponseBlock => {
  const headers = normalizedHeaders(response.headers);
  if (headers.get('cf-mitigated')?.toLowerCase() === 'challenge') return { kind: 'cloudflareChallenge' };
  if (response.status === 429) {
    return { kind: 'rateLimited', retryAt: parseRetryAt(headers.get('retry-after'), response.now ?? Date.now()) };
  }
  if (response.status === 401) return { kind: 'authenticationRequired' };
  if (response.status === 403) return { kind: 'accessDenied' };
  return { kind: 'none' };
};
