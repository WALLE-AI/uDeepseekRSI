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

/**
 * 前缀既是给模型看的分类，也是遥测的 join key，所以只能在这里定义一次。
 * The prefix is both the model's classification and telemetry's join key, so it is defined once here.
 */
export type BrowserControlErrorCode =
  | 'NO_TARGET'
  | 'TARGET_BUSY'
  | 'TARGET_CLOSED'
  | 'TARGET_CREATE_TIMEOUT'
  | 'STALE_ELEMENT'
  | 'USER_TOOK_CONTROL'
  | 'CHALLENGE_REQUIRED'
  | 'CHALLENGE_IN_PROGRESS'
  | 'RATE_LIMITED'
  | 'AUTHENTICATION_REQUIRED'
  | 'ACCESS_DENIED'
  | 'CAPABILITY_BLOCKED'
  | 'SENSITIVE_READ_BLOCKED'
  | 'NAVIGATION_BLOCKED';

export type BrowserControlResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: BrowserControlErrorCode; message: string };
