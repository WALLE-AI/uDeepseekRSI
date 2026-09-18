/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The wiring between Electron's events and the policy layer. The policies are tested on their own
 * elsewhere; what is checked here is that they are actually reached — that a certificate error
 * answers false rather than true, that webContents on another session are left alone, and above
 * all that the permission handlers exist at all, which is the regression this module was written
 * for: they used to be installed inside the CDP bridge, so switching agent browser control off
 * left the partition with no handler and Electron's default, which is to grant.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: unknown[]) => void;

const browserSession = {
  setPermissionCheckHandler: vi.fn(),
  setPermissionRequestHandler: vi.fn(),
};
const otherSession = { setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn() };
const appListeners = new Map<string, Listener[]>();

/** Whether the fake app reports itself as ready; flipped by the deferral test. */
let appReady = true;
const readyWaiters: Array<() => void> = [];

vi.mock('electron', () => ({
  app: {
    on: (event: string, listener: Listener) => {
      const existing = appListeners.get(event) ?? [];
      existing.push(listener);
      appListeners.set(event, existing);
    },
    isReady: () => appReady,
    whenReady: () =>
      new Promise<void>((resolve) => {
        if (appReady) resolve();
        else readyWaiters.push(resolve);
      }),
  },
  session: {
    fromPartition: () => {
      // The real one throws exactly here when called too early, which is the bug this guards.
      if (!appReady) throw new TypeError('Session can only be received when app is ready');
      return browserSession;
    },
  },
}));

const { installBrowserSessionGuards } = await import('@process/services/browser-control/sessionGuards');

/** A stand-in webContents that records the navigation listeners installed on it. */
const fakeContents = (options: { session?: unknown; url?: string } = {}) => {
  const listeners = new Map<string, Listener>();
  return {
    session: options.session ?? browserSession,
    getURL: () => options.url ?? 'https://example.com/',
    on: (event: string, listener: Listener) => listeners.set(event, listener),
    listeners,
  };
};

const fakeEvent = () => {
  const event = { prevented: false, preventDefault: () => (event.prevented = true) };
  return event;
};

const emit = (event: string, ...args: unknown[]): void => {
  for (const listener of appListeners.get(event) ?? []) listener(...args);
};

beforeEach(() => {
  appListeners.clear();
  readyWaiters.length = 0;
  appReady = true;
  browserSession.setPermissionCheckHandler.mockReset();
  browserSession.setPermissionRequestHandler.mockReset();
});

describe('installBrowserSessionGuards: startup ordering', () => {
  it('waits for app ready instead of throwing, since the call site runs at module load', async () => {
    // initApplicationBridge is called while the main process module is still loading, before
    // whenReady. session.fromPartition throws at that point, and the throw propagated all the
    // way out as "App threw an error during load" — the window never appeared.
    appReady = false;
    expect(() => installBrowserSessionGuards()).not.toThrow();
    expect(browserSession.setPermissionCheckHandler).not.toHaveBeenCalled();

    appReady = true;
    for (const resolve of readyWaiters) resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(browserSession.setPermissionCheckHandler).toHaveBeenCalledOnce();
    expect(appListeners.get('web-contents-created')).toHaveLength(1);
  });
});

describe('installBrowserSessionGuards: permissions', () => {
  it('installs both permission handlers on the browser partition', () => {
    installBrowserSessionGuards();
    expect(browserSession.setPermissionCheckHandler).toHaveBeenCalledOnce();
    expect(browserSession.setPermissionRequestHandler).toHaveBeenCalledOnce();
  });

  it('answers the synchronous check by policy', () => {
    installBrowserSessionGuards();
    const check = browserSession.setPermissionCheckHandler.mock.calls[0][0] as (
      contents: unknown,
      permission: string
    ) => boolean;
    expect(check(null, 'fullscreen')).toBe(true);
    expect(check(null, 'geolocation')).toBe(false);
    expect(check(null, 'usb')).toBe(false);
  });

  it('refuses a request there is no UI to ask about, and reports it', () => {
    const onBlocked = vi.fn();
    installBrowserSessionGuards({ onBlocked });
    const request = browserSession.setPermissionRequestHandler.mock.calls[0][0] as (
      contents: unknown,
      permission: string,
      callback: (granted: boolean) => void
    ) => void;

    const granted = vi.fn();
    request(null, 'videoCapture', granted);
    expect(granted).toHaveBeenCalledWith(false);
    expect(onBlocked).toHaveBeenCalledWith(expect.objectContaining({ kind: 'permission' }));
  });

  it('grants a request the policy allows', () => {
    installBrowserSessionGuards();
    const request = browserSession.setPermissionRequestHandler.mock.calls[0][0] as (
      contents: unknown,
      permission: string,
      callback: (granted: boolean) => void
    ) => void;
    const granted = vi.fn();
    request(null, 'fullscreen', granted);
    expect(granted).toHaveBeenCalledWith(true);
  });

  it('does not report a silently denied capability, which is not worth telling the user about', () => {
    const onBlocked = vi.fn();
    installBrowserSessionGuards({ onBlocked });
    const request = browserSession.setPermissionRequestHandler.mock.calls[0][0] as (
      contents: unknown,
      permission: string,
      callback: (granted: boolean) => void
    ) => void;
    request(null, 'usb', vi.fn());
    expect(onBlocked).not.toHaveBeenCalled();
  });
});

describe('installBrowserSessionGuards: certificates', () => {
  it('always answers false, never trusting a bad certificate automatically', () => {
    installBrowserSessionGuards();
    const event = fakeEvent();
    const callback = vi.fn();
    emit(
      'certificate-error',
      event,
      { session: browserSession },
      'https://bad.example.com/',
      'net::ERR_CERT_DATE_INVALID',
      {},
      callback
    );
    expect(event.prevented).toBe(true);
    expect(callback).toHaveBeenCalledWith(false);
  });

  it('leaves certificate errors on other sessions to their own handling', () => {
    installBrowserSessionGuards();
    const event = fakeEvent();
    const callback = vi.fn();
    emit(
      'certificate-error',
      event,
      { session: otherSession },
      'https://bad.example.com/',
      'net::ERR_CERT_DATE_INVALID',
      {},
      callback
    );
    expect(event.prevented).toBe(false);
    expect(callback).not.toHaveBeenCalled();
  });
});

describe('installBrowserSessionGuards: navigation', () => {
  const guardedContents = (options: { url?: string } = {}) => {
    const contents = fakeContents(options);
    emit('web-contents-created', {}, contents);
    return contents;
  };

  it('ignores webContents belonging to another session', () => {
    installBrowserSessionGuards();
    const contents = fakeContents({ session: otherSession });
    emit('web-contents-created', {}, contents);
    expect(contents.listeners.size).toBe(0);
  });

  it('blocks a navigation to the cloud metadata endpoint', () => {
    const onBlocked = vi.fn();
    installBrowserSessionGuards({ onBlocked });
    const contents = guardedContents();
    const event = fakeEvent();
    contents.listeners.get('will-navigate')?.(event, 'http://169.254.169.254/latest/meta-data/');
    expect(event.prevented).toBe(true);
    expect(onBlocked).toHaveBeenCalledWith(expect.objectContaining({ kind: 'navigation' }));
  });

  it('blocks a navigation to a link-local address', () => {
    installBrowserSessionGuards();
    const contents = guardedContents();
    const event = fakeEvent();
    contents.listeners.get('will-navigate')?.(event, 'http://169.254.10.1/');
    expect(event.prevented).toBe(true);
  });

  it('leaves the user free to open a local dev server', () => {
    // Agent-driven navigation is gated separately; applying that rule here would break the
    // in-app browser's ordinary use.
    installBrowserSessionGuards();
    const contents = guardedContents();
    const event = fakeEvent();
    contents.listeners.get('will-navigate')?.(event, 'http://localhost:5173/');
    expect(event.prevented).toBe(false);
  });

  it('leaves an ordinary public navigation alone', () => {
    installBrowserSessionGuards();
    const contents = guardedContents();
    const event = fakeEvent();
    contents.listeners.get('will-navigate')?.(event, 'https://example.com/page');
    expect(event.prevented).toBe(false);
  });

  it('blocks a public page redirecting into loopback', () => {
    const onBlocked = vi.fn();
    installBrowserSessionGuards({ onBlocked });
    const contents = guardedContents({ url: 'https://evil.example.com/' });
    const event = fakeEvent();
    contents.listeners.get('will-redirect')?.(event, 'http://127.0.0.1:8080/admin');
    expect(event.prevented).toBe(true);
    expect(onBlocked).toHaveBeenCalledWith(expect.objectContaining({ kind: 'redirect' }));
  });

  it('blocks that redirect even when the destination is allowlisted for preview', () => {
    installBrowserSessionGuards({ allowedPrivateOrigins: () => new Set(['http://127.0.0.1:8080']) });
    const contents = guardedContents({ url: 'https://evil.example.com/' });
    const event = fakeEvent();
    contents.listeners.get('will-redirect')?.(event, 'http://127.0.0.1:8080/admin');
    expect(event.prevented).toBe(true);
  });

  it('allows an allowlisted local service to redirect within itself', () => {
    installBrowserSessionGuards({ allowedPrivateOrigins: () => new Set(['http://127.0.0.1:8080']) });
    const contents = guardedContents({ url: 'http://127.0.0.1:8080/a' });
    const event = fakeEvent();
    contents.listeners.get('will-redirect')?.(event, 'http://127.0.0.1:8080/b');
    expect(event.prevented).toBe(false);
  });

  it('reads the allowlist at each hop, so a grant made after startup takes effect', () => {
    const allowed = new Set<string>();
    installBrowserSessionGuards({ allowedPrivateOrigins: () => allowed });
    const contents = guardedContents({ url: 'http://127.0.0.1:8080/a' });

    const before = fakeEvent();
    contents.listeners.get('will-redirect')?.(before, 'http://127.0.0.1:8080/b');
    expect(before.prevented).toBe(true);

    allowed.add('http://127.0.0.1:8080');
    const after = fakeEvent();
    contents.listeners.get('will-redirect')?.(after, 'http://127.0.0.1:8080/b');
    expect(after.prevented).toBe(false);
  });
});
