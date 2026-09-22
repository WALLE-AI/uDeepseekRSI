/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BrowserControlCoordinator,
  BrowserTargetRegistry,
  blockedCdpCapability,
  classifyBrowserResponse,
  mayInjectManagedCredential,
  OriginRateLimiter,
  validateBrowserNavigation,
} from '@process/services/browser-control';
import { describe, expect, it } from 'vitest';

describe('BrowserTargetRegistry', () => {
  it('keeps a stable target id when the same tab navigates or recreates its web contents', () => {
    let sequence = 0;
    const registry = new BrowserTargetRegistry(() => `target-${++sequence}`);
    const first = registry.register({
      tabId: 'tab-a',
      webContentsId: 1,
      scopeId: 'scope',
      title: 'A',
      url: 'https://example.com',
      active: true,
    });
    const second = registry.register({ ...first, webContentsId: 2, title: 'B' });

    expect(second.targetId).toBe(first.targetId);
    expect(registry.getByTab('tab-a')?.webContentsId).toBe(2);
    expect(registry.getByWebContents(1)).toBeNull();
    expect(registry.getByWebContents(2)?.title).toBe('B');
  });

  it('invalidates a target and increments document revisions explicitly', () => {
    const registry = new BrowserTargetRegistry(() => 'target-a');
    const target = registry.register({
      tabId: 'tab-a',
      webContentsId: 1,
      scopeId: 'scope',
      title: 'A',
      url: 'https://example.com',
      active: true,
    });

    expect(registry.updateDocument(target.targetId, { url: 'https://example.com/next' })?.documentRevision).toBe(1);
    expect(registry.unregisterByWebContents(1)?.targetId).toBe(target.targetId);
    expect(registry.get(target.targetId)).toBeNull();
  });
});

describe('BrowserControlCoordinator', () => {
  const agent = (session: string, turn = 'turn-1') => ({
    conversationId: 'conversation',
    turnId: turn,
    controlSessionId: session,
  });

  it('allows one writer per target while different targets remain independent', () => {
    const coordinator = new BrowserControlCoordinator();
    expect(coordinator.acquireWrite('target-a', agent('a')).ok).toBe(true);
    expect(coordinator.acquireWrite('target-a', agent('b'))).toMatchObject({ ok: false, code: 'TARGET_BUSY' });
    expect(coordinator.acquireWrite('target-b', agent('b')).ok).toBe(true);
  });

  it('blocks writes after user takeover until resumed', () => {
    const coordinator = new BrowserControlCoordinator();
    coordinator.acquireWrite('target-a', agent('a'));
    coordinator.userTakeover('target-a');
    expect(coordinator.acquireWrite('target-a', agent('a'))).toMatchObject({
      ok: false,
      code: 'USER_TOOK_CONTROL',
    });
    coordinator.resume('target-a');
    expect(coordinator.acquireWrite('target-a', agent('a')).ok).toBe(true);
  });

  it('blocks a future first lease after takeover and releases all leases on disconnect', () => {
    const coordinator = new BrowserControlCoordinator();
    coordinator.userTakeover('target-a');
    expect(coordinator.acquireWrite('target-a', agent('a'))).toMatchObject({
      ok: false,
      code: 'USER_TOOK_CONTROL',
    });
    coordinator.resume('target-a');
    coordinator.acquireWrite('target-a', agent('a'));
    coordinator.acquireWrite('target-b', agent('a'));
    coordinator.releaseAll('a');
    expect(coordinator.acquireWrite('target-a', agent('b')).ok).toBe(true);
    expect(coordinator.acquireWrite('target-b', agent('b')).ok).toBe(true);
  });

  it('expires a lease with a fake clock so a crashed session cannot hold a tab forever', () => {
    let now = 100;
    const coordinator = new BrowserControlCoordinator({ now: () => now, leaseTtlMs: 10 });
    coordinator.acquireWrite('target-a', agent('a'));

    // 租约未过期时，另一个会话拿不到。
    // While the lease holds, another session cannot take the tab.
    expect(coordinator.acquireWrite('target-a', agent('b'))).toMatchObject({ ok: false, code: 'TARGET_BUSY' });

    now = 111;
    expect(coordinator.acquireWrite('target-a', agent('b')).ok).toBe(true);
  });
});

describe('browser action policy', () => {
  it('blocks unsafe schemes and private destinations by default', () => {
    expect(validateBrowserNavigation('javascript:alert(1)')).toMatchObject({ ok: false, code: 'NAVIGATION_BLOCKED' });
    expect(validateBrowserNavigation('http://127.0.0.1:3000')).toMatchObject({
      ok: false,
      code: 'NAVIGATION_BLOCKED',
    });
  });

  it('allows public HTTPS and explicitly registered preview origins', () => {
    expect(validateBrowserNavigation('https://example.com').ok).toBe(true);
    expect(validateBrowserNavigation('http://127.0.0.1:3000/a', new Set(['http://127.0.0.1:3000'])).ok).toBe(true);
  });

  it('never injects a managed credential across origins or into HTTP', () => {
    expect(mayInjectManagedCredential('https://app.example.com/a', 'https://app.example.com')).toBe(true);
    expect(mayInjectManagedCredential('https://evil.example.com/a', 'https://app.example.com')).toBe(false);
    expect(mayInjectManagedCredential('http://app.example.com/a', 'https://app.example.com')).toBe(false);
  });

  it('blocks raw CDP methods that require an AionUi-owned confirmation flow', () => {
    // 断言前缀而不是散文：前缀是给模型做模式匹配、给遥测做 join key 的稳定契约，
    // 措辞则会随可读性调整而变。
    //
    // Assert the prefix rather than the prose: the prefix is the stable contract the model
    // pattern-matches on and telemetry joins by, while the wording changes with readability.
    for (const method of [
      'DOM.setFileInputFiles',
      'Page.handleJavaScriptDialog',
      'Browser.setDownloadBehavior',
      'Browser.grantPermissions',
      'Network.setCookie',
    ]) {
      const message = blockedCdpCapability(method);
      expect(message).toMatch(/^CAPABILITY_BLOCKED: /);
      expect(message).toContain(method);
    }
    expect(blockedCdpCapability('Page.navigate')).toBeNull();
  });
});

describe('classifyBrowserResponse', () => {
  it('uses the Cloudflare mitigation header instead of treating every 403 as a challenge', () => {
    expect(classifyBrowserResponse({ status: 403, headers: { 'CF-Mitigated': 'challenge' } })).toEqual({
      kind: 'cloudflareChallenge',
    });
    expect(classifyBrowserResponse({ status: 403 })).toEqual({ kind: 'accessDenied' });
  });

  it('honors both delta-seconds and HTTP-date Retry-After values', () => {
    expect(classifyBrowserResponse({ status: 429, headers: { 'retry-after': '5' }, now: 1_000 })).toEqual({
      kind: 'rateLimited',
      retryAt: 6_000,
    });
    expect(
      classifyBrowserResponse({ status: 429, headers: { 'retry-after': 'Thu, 01 Jan 1970 00:00:10 GMT' }, now: 1_000 })
    ).toEqual({ kind: 'rateLimited', retryAt: 10_000 });
  });
});

describe('OriginRateLimiter', () => {
  it('honors Retry-After and isolates budgets by exact origin', () => {
    let now = 1_000;
    const limiter = new OriginRateLimiter({ now: () => now, random: () => 0 });
    expect(limiter.recordRateLimit('https://a.example/path', 6_000)).toBe(6_000);
    expect(limiter.blockedUntil('https://a.example/other')).toBe(6_000);
    expect(limiter.blockedUntil('https://b.example')).toBeNull();
    now = 6_001;
    expect(limiter.blockedUntil('https://a.example')).toBeNull();
  });

  it('uses bounded exponential backoff and opens a circuit after repeated limits', () => {
    const limiter = new OriginRateLimiter({ now: () => 10_000, random: () => 0 });
    expect(limiter.recordRateLimit('https://a.example', null)).toBe(11_000);
    limiter.recordRateLimit('https://a.example', null);
    limiter.recordRateLimit('https://a.example', null);
    limiter.recordRateLimit('https://a.example', null);
    expect(limiter.recordRateLimit('https://a.example', null)).toBe(310_000);
  });
});
