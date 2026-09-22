/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { capabilityBlockedError } from '../agentErrors';
import type { BrowserControlResult } from '../types';
import { evaluateNetworkTarget } from './networkPolicy';

/**
 * 一次导航是否放行。
 *
 * 分层判定本身在 networkPolicy.ts —— 这里只是把它翻译成 BrowserControlResult，
 * 让既有调用方不用改。之前这里有一份自己的私网判定，比 networkPolicy 少了几类地址
 * （云元数据、CGNAT、IPv4-mapped IPv6），共用一份之后这些缺口自动补上了。
 *
 * Whether a navigation is allowed. The layered decision lives in networkPolicy.ts; this only
 * translates it into a BrowserControlResult so existing callers need no change. There used to be
 * a second private-address check here that recognised fewer cases than networkPolicy does — cloud
 * metadata, CGNAT, IPv4-mapped IPv6 — and sharing one implementation closes those gaps.
 */
export const validateBrowserNavigation = (
  rawUrl: string,
  allowedPrivateOrigins: ReadonlySet<string> = new Set()
): BrowserControlResult<URL> => {
  const verdict = evaluateNetworkTarget(rawUrl, { allowedPrivateOrigins });
  if (verdict.allowed === false) return { ok: false, code: 'NAVIGATION_BLOCKED', message: verdict.reason };
  return { ok: true, data: new URL(rawUrl) };
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
  BLOCKED_CDP_METHODS.has(method) ? capabilityBlockedError(method) : null;
