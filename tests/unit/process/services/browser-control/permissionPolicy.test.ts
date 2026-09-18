/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Permission and external-protocol verdicts. The property worth pinning down is that nothing is
 * granted by omission: a permission name the table has never heard of has to come back denied,
 * because Electron keeps adding them and this table will always be behind.
 */

import { describe, expect, it } from 'vitest';

import {
  BrowserPermissionLedger,
  classifyBrowserPermission,
  classifyExternalProtocol,
  resolveSyncPermission,
} from '@process/services/browser-control/policies/permissionPolicy';

describe('classifyBrowserPermission', () => {
  it.each(['media', 'audioCapture', 'videoCapture', 'display-capture', 'geolocation', 'notifications', 'openExternal'])(
    'leaves %s for the user to decide',
    (permission) => {
      expect(classifyBrowserPermission(permission).decision).toBe('ask');
    }
  );

  it('carries a prompt line for every permission it would ask about', () => {
    expect(classifyBrowserPermission('videoCapture').prompt).toBe('use your camera');
  });

  it('allows fullscreen, which touches no device and no data', () => {
    expect(classifyBrowserPermission('fullscreen').decision).toBe('allow');
  });

  it.each(['serial', 'usb', 'hid', 'midi', 'midiSysex', 'idle-detection'])('silently denies %s', (permission) => {
    expect(classifyBrowserPermission(permission).decision).toBe('deny');
  });

  it('denies a permission name it has never seen, rather than falling through to allow', () => {
    expect(classifyBrowserPermission('some-future-electron-permission').decision).toBe('deny');
  });

  it('is case-sensitive rather than guessing, so a near-miss name is denied', () => {
    expect(classifyBrowserPermission('GEOLOCATION').decision).toBe('deny');
  });
});

describe('resolveSyncPermission', () => {
  it('reports fullscreen as granted', () => {
    expect(resolveSyncPermission('fullscreen')).toBe(true);
  });

  it('reports an ask-the-user permission as not granted, since nobody has been asked', () => {
    expect(resolveSyncPermission('geolocation')).toBe(false);
  });

  it('reports a denied permission as not granted', () => {
    expect(resolveSyncPermission('usb')).toBe(false);
  });
});

describe('classifyExternalProtocol', () => {
  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'ms-msdt:/id',
    'search-ms:query=x',
    'smb://host/share',
  ])('never opens %s', (rawUrl) => {
    expect(classifyExternalProtocol(rawUrl).decision).toBe('deny');
  });

  it('asks before handing a mailto: link to another app', () => {
    const verdict = classifyExternalProtocol('mailto:someone@example.com');
    expect(verdict.decision).toBe('ask');
    expect(verdict.decision === 'ask' && verdict.prompt).toMatch(/mailto/);
  });

  it('asks about a custom scheme rather than opening it silently', () => {
    expect(classifyExternalProtocol('zoommtg://zoom.us/join?confno=1').decision).toBe('ask');
  });

  it('denies something that is not a URL at all', () => {
    expect(classifyExternalProtocol('not a url').decision).toBe('deny');
  });

  it('is not bypassed by uppercasing the scheme', () => {
    expect(classifyExternalProtocol('FILE:///etc/passwd').decision).toBe('deny');
  });
});

describe('BrowserPermissionLedger', () => {
  it('returns undefined for a question never asked', () => {
    expect(new BrowserPermissionLedger().recall('https://example.com', 'geolocation')).toBeUndefined();
  });

  it('remembers a refusal, which is what makes a refusal stick', () => {
    // Without this a page can request in a loop until the user presses Allow.
    const ledger = new BrowserPermissionLedger();
    ledger.remember('https://example.com', 'geolocation', false);
    expect(ledger.recall('https://example.com', 'geolocation')).toBe(false);
  });

  it('remembers a grant', () => {
    const ledger = new BrowserPermissionLedger();
    ledger.remember('https://example.com', 'notifications', true);
    expect(ledger.recall('https://example.com', 'notifications')).toBe(true);
  });

  it('keeps decisions separate per origin', () => {
    const ledger = new BrowserPermissionLedger();
    ledger.remember('https://a.example.com', 'geolocation', true);
    expect(ledger.recall('https://b.example.com', 'geolocation')).toBeUndefined();
  });

  it('keeps decisions separate per permission', () => {
    const ledger = new BrowserPermissionLedger();
    ledger.remember('https://example.com', 'geolocation', true);
    expect(ledger.recall('https://example.com', 'videoCapture')).toBeUndefined();
  });

  it('lets a later decision replace an earlier one', () => {
    const ledger = new BrowserPermissionLedger();
    ledger.remember('https://example.com', 'geolocation', true);
    ledger.remember('https://example.com', 'geolocation', false);
    expect(ledger.recall('https://example.com', 'geolocation')).toBe(false);
    expect(ledger.size).toBe(1);
  });

  it('forgets everything on clear, for the clear-browsing-data entry point', () => {
    const ledger = new BrowserPermissionLedger();
    ledger.remember('https://example.com', 'geolocation', true);
    ledger.clear();
    expect(ledger.size).toBe(0);
    expect(ledger.recall('https://example.com', 'geolocation')).toBeUndefined();
  });
});
