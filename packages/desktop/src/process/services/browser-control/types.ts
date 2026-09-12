/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export type BrowserControlIdentity = {
  conversationId: string;
  turnId: string;
  controlSessionId: string;
};

export type BrowserTargetRecord = {
  targetId: string;
  tabId: string;
  webContentsId: number;
  scopeId: string;
  title: string;
  url: string;
  active: boolean;
  documentRevision: number;
};

export type BrowserControlErrorCode =
  | 'NO_TARGET'
  | 'TARGET_BUSY'
  | 'TARGET_CLOSED'
  | 'STALE_ELEMENT'
  | 'USER_TOOK_CONTROL'
  | 'CHALLENGE_REQUIRED'
  | 'CHALLENGE_IN_PROGRESS'
  | 'RATE_LIMITED'
  | 'AUTHENTICATION_REQUIRED'
  | 'NAVIGATION_BLOCKED';

export type BrowserControlResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: BrowserControlErrorCode; message: string };
