/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BrowserControlResult } from './types';

const IPV4_PRIVATE = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];

const isPrivateHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized.startsWith('fe80:') ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    IPV4_PRIVATE.some((pattern) => pattern.test(normalized))
  );
};

export const validateBrowserNavigation = (
  rawUrl: string,
  allowedPrivateOrigins: ReadonlySet<string> = new Set()
): BrowserControlResult<URL> => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, code: 'NAVIGATION_BLOCKED', message: 'The URL is invalid.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.href !== 'about:blank') {
    return { ok: false, code: 'NAVIGATION_BLOCKED', message: `Navigation scheme ${url.protocol} is not allowed.` };
  }
  if (url.href !== 'about:blank' && isPrivateHostname(url.hostname) && !allowedPrivateOrigins.has(url.origin)) {
    return { ok: false, code: 'NAVIGATION_BLOCKED', message: 'Private network navigation is not allowed.' };
  }
  return { ok: true, data: url };
};

export const mayInjectManagedCredential = (requestUrl: string, configuredOrigin: string): boolean => {
  try {
    const request = new URL(requestUrl);
    const configured = new URL(configuredOrigin);
    return request.protocol === 'https:' && configured.protocol === 'https:' && request.origin === configured.origin;
  } catch {
    return false;
  }
};

const BLOCKED_CDP_METHODS = new Set([
  'Browser.grantPermissions',
  'Browser.resetPermissions',
  'Browser.setDownloadBehavior',
  'DOM.setFileInputFiles',
  'Network.deleteCookies',
  'Network.setCookie',
  'Network.setCookies',
  'Page.handleJavaScriptDialog',
  'Page.setDownloadBehavior',
  'Page.setInterceptFileChooserDialog',
  'Storage.clearDataForOrigin',
  'Storage.setCookies',
]);

/**
 * Capabilities that require an AionUi-owned confirmation and path-validation
 * flow are unavailable through the raw target bridge.
 */
export const blockedCdpCapability = (method: string): string | null =>
  BLOCKED_CDP_METHODS.has(method)
    ? `${method} requires an explicit user-confirmed AionUi workflow and is not available to Agent control.`
    : null;
