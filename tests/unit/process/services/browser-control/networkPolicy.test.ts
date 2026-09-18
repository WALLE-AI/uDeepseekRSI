/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The layered network policy, tested through the three entry points that each close a different
 * hole: the URL check (what was asked for), the redirect check (where the remote end sent us),
 * and the resolved-address check (what DNS actually answered). The notations that exist to look
 * like one zone while belonging to another — `::ffff:127.0.0.1`, `0.0.0.0`, `127.0.0.1.` with a
 * trailing dot — get their own cases, since those are the ones a hand-written check misses.
 */

import { describe, expect, it } from 'vitest';

import {
  classifyHostname,
  evaluateNetworkTarget,
  evaluateRedirect,
  evaluateResolvedAddress,
} from '@process/services/browser-control/policies/networkPolicy';

describe('classifyHostname', () => {
  it.each([
    ['example.com', 'public'],
    ['93.184.216.34', 'public'],
    ['localhost', 'loopback'],
    ['app.localhost', 'loopback'],
    ['127.0.0.1', 'loopback'],
    ['127.9.9.9', 'loopback'],
    ['0.0.0.0', 'loopback'],
    ['::1', 'loopback'],
    ['10.0.0.5', 'private'],
    ['192.168.1.1', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['100.64.0.1', 'private'],
    ['fd00::1', 'private'],
    ['printer.local', 'private'],
    ['wiki.internal', 'private'],
    ['169.254.10.1', 'linkLocal'],
    ['fe80::1', 'linkLocal'],
    ['169.254.169.254', 'metadata'],
    ['metadata.google.internal', 'metadata'],
    ['999.1.1.1', 'invalid'],
    ['', 'invalid'],
  ])('classifies %s as %s', (hostname, zone) => {
    expect(classifyHostname(hostname)).toBe(zone);
  });

  it('is not fooled by a trailing dot, which resolves identically', () => {
    expect(classifyHostname('127.0.0.1.')).toBe('loopback');
  });

  it('is not fooled by an IPv4-mapped IPv6 address', () => {
    expect(classifyHostname('::ffff:127.0.0.1')).toBe('loopback');
    expect(classifyHostname('::ffff:169.254.169.254')).toBe('metadata');
  });

  it('is not fooled by uppercase or bracketed IPv6 notation', () => {
    expect(classifyHostname('[FE80::1]')).toBe('linkLocal');
  });

  it('is not fooled by 172.32, which is outside the private range despite looking like it', () => {
    expect(classifyHostname('172.32.0.1')).toBe('public');
  });
});

describe('evaluateNetworkTarget', () => {
  it('allows a public https address', () => {
    expect(evaluateNetworkTarget('https://example.com/a').allowed).toBe(true);
  });

  it('allows about:blank, the initial address of a new tab', () => {
    expect(evaluateNetworkTarget('about:blank').allowed).toBe(true);
  });

  it('refuses file: so a navigation cannot become a local file read', () => {
    const verdict = evaluateNetworkTarget('file:///etc/passwd');
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.zone).toBe('invalid');
  });

  it('refuses javascript: so a navigation cannot become script execution', () => {
    expect(evaluateNetworkTarget('javascript:alert(1)').allowed).toBe(false);
  });

  it('refuses a malformed URL', () => {
    expect(evaluateNetworkTarget('not a url').allowed).toBe(false);
  });

  it('refuses loopback with no allowlist', () => {
    expect(evaluateNetworkTarget('http://127.0.0.1:8080/').allowed).toBe(false);
  });

  it('allows loopback for an origin the user allowed for preview', () => {
    const allowedPrivateOrigins = new Set(['http://127.0.0.1:8080']);
    expect(evaluateNetworkTarget('http://127.0.0.1:8080/index.html', { allowedPrivateOrigins }).allowed).toBe(true);
  });

  it('matches the allowlist by full origin, so another port on the same host stays refused', () => {
    const allowedPrivateOrigins = new Set(['http://127.0.0.1:8080']);
    expect(evaluateNetworkTarget('http://127.0.0.1:9000/', { allowedPrivateOrigins }).allowed).toBe(false);
  });

  it('refuses cloud metadata even when its origin is allowlisted', () => {
    const allowedPrivateOrigins = new Set(['http://169.254.169.254']);
    expect(evaluateNetworkTarget('http://169.254.169.254/latest/meta-data/', { allowedPrivateOrigins }).allowed).toBe(
      false
    );
  });

  it('refuses link-local even when its origin is allowlisted', () => {
    const allowedPrivateOrigins = new Set(['http://169.254.10.1']);
    expect(evaluateNetworkTarget('http://169.254.10.1/', { allowedPrivateOrigins }).allowed).toBe(false);
  });
});

describe('evaluateRedirect', () => {
  it('allows a public page redirecting to another public page', () => {
    expect(evaluateRedirect('https://a.example.com/', 'https://b.example.com/').allowed).toBe(true);
  });

  it('refuses a public page redirecting to loopback', () => {
    const verdict = evaluateRedirect('https://evil.example.com/', 'http://127.0.0.1:8080/admin');
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.zone).toBe('loopback');
  });

  it('refuses a public page redirecting to a private address', () => {
    expect(evaluateRedirect('https://evil.example.com/', 'http://192.168.1.1/').allowed).toBe(false);
  });

  it('refuses the public -> loopback hop even when the destination is allowlisted', () => {
    // The allowlist means "the user wants to preview this local service", not "any public page
    // may steer the browser into it". This is the case the URL-level check alone would let past.
    const allowedPrivateOrigins = new Set(['http://127.0.0.1:8080']);
    const verdict = evaluateRedirect('https://evil.example.com/', 'http://127.0.0.1:8080/admin', {
      allowedPrivateOrigins,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toMatch(/public page/i);
  });

  it('allows an allowlisted local service redirecting within itself', () => {
    const allowedPrivateOrigins = new Set(['http://127.0.0.1:8080']);
    expect(
      evaluateRedirect('http://127.0.0.1:8080/a', 'http://127.0.0.1:8080/b', { allowedPrivateOrigins }).allowed
    ).toBe(true);
  });

  it('treats an unparseable source as public, which is the conservative side', () => {
    const allowedPrivateOrigins = new Set(['http://127.0.0.1:8080']);
    expect(evaluateRedirect('', 'http://127.0.0.1:8080/', { allowedPrivateOrigins }).allowed).toBe(false);
  });

  it('refuses a redirect to metadata regardless of where it came from', () => {
    expect(evaluateRedirect('http://10.0.0.1/', 'http://169.254.169.254/latest/').allowed).toBe(false);
  });
});

describe('evaluateResolvedAddress', () => {
  it('allows a public hostname resolving to a public address', () => {
    expect(evaluateResolvedAddress('https://example.com/', '93.184.216.34').allowed).toBe(true);
  });

  it('refuses a public hostname that resolves to loopback — the rebinding case', () => {
    const verdict = evaluateResolvedAddress('https://rebind.example.com/', '127.0.0.1');
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.zone).toBe('loopback');
  });

  it('refuses a public hostname that resolves to a private address', () => {
    expect(evaluateResolvedAddress('https://rebind.example.com/', '10.1.2.3').allowed).toBe(false);
  });

  it('refuses a public hostname that resolves to cloud metadata', () => {
    expect(evaluateResolvedAddress('https://rebind.example.com/', '169.254.169.254').allowed).toBe(false);
  });

  it('is not bypassed by answering with an IPv4-mapped IPv6 address', () => {
    expect(evaluateResolvedAddress('https://rebind.example.com/', '::ffff:127.0.0.1').allowed).toBe(false);
  });

  it('does not trip up an allowlisted local origin resolving to a local address', () => {
    const allowedPrivateOrigins = new Set(['http://localhost:5173']);
    expect(evaluateResolvedAddress('http://localhost:5173/', '127.0.0.1', { allowedPrivateOrigins }).allowed).toBe(
      true
    );
  });

  it('still refuses a URL the target check already rejected', () => {
    expect(evaluateResolvedAddress('http://127.0.0.1:8080/', '127.0.0.1').allowed).toBe(false);
  });
});
