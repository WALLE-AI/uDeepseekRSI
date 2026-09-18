/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Dialogs, unload prompts, and certificate errors. The distinction each case turns on is who is
 * driving: a prompt the user summoned is shown to them, while one the agent walked into is
 * answered by policy, because a native modal would wedge the webContents and leave the agent
 * waiting on a command that never returns.
 */

import { describe, expect, it } from 'vitest';

import {
  createBrowserDialogId,
  describeBrowserDialog,
  evaluateCertificateError,
  evaluateUnloadPrompt,
} from '@process/services/browser-control/policies/dialogPolicy';

describe('describeBrowserDialog', () => {
  it('shows a dialog the user walked into themselves', () => {
    const state = describeBrowserDialog({
      kind: 'confirm',
      origin: 'https://example.com',
      message: 'Delete?',
      agentInitiated: false,
    });
    expect(state.disposition).toBe('show');
  });

  it('auto-answers a dialog the agent walked into', () => {
    const state = describeBrowserDialog({
      kind: 'confirm',
      origin: 'https://example.com',
      message: 'Delete?',
      agentInitiated: true,
    });
    expect(state.disposition).toBe('autoAnswer');
  });

  it('auto-answers in the negative, which is indistinguishable from the user pressing Cancel', () => {
    const state = describeBrowserDialog({ kind: 'prompt', origin: 'https://example.com', agentInitiated: true });
    expect(state.defaultAnswer).toBe(false);
  });

  it('carries the origin and kind through', () => {
    const state = describeBrowserDialog({
      kind: 'alert',
      origin: 'https://example.com',
      message: 'Hi',
      agentInitiated: false,
    });
    expect(state).toMatchObject({ kind: 'alert', origin: 'https://example.com', message: 'Hi' });
  });

  it('truncates a message long enough to be a denial-of-service on the dialog itself', () => {
    const state = describeBrowserDialog({
      kind: 'alert',
      origin: 'https://example.com',
      message: 'x'.repeat(50_000),
      agentInitiated: false,
    });
    expect(state.message).toHaveLength(2000);
  });

  it('turns a missing message into an empty string rather than undefined', () => {
    expect(describeBrowserDialog({ kind: 'alert', origin: 'https://example.com', agentInitiated: false }).message).toBe(
      ''
    );
  });

  it('accepts a caller-supplied id so the answer can be routed back', () => {
    expect(
      describeBrowserDialog({ kind: 'alert', origin: 'https://example.com', agentInitiated: false }, 'dlg-fixed').id
    ).toBe('dlg-fixed');
  });

  it('generates a distinct prefixed id otherwise', () => {
    const first = createBrowserDialogId();
    expect(first).toMatch(/^dlg-/);
    expect(first).not.toBe(createBrowserDialogId());
  });
});

describe('evaluateUnloadPrompt', () => {
  it('proceeds when the page registered no beforeunload handler', () => {
    expect(evaluateUnloadPrompt({ userInitiated: true, hasUnloadHandler: false })).toEqual({ action: 'proceed' });
  });

  it('proceeds for an agent-driven close when there is nothing unsaved', () => {
    expect(evaluateUnloadPrompt({ userInitiated: false, hasUnloadHandler: false })).toEqual({ action: 'proceed' });
  });

  it('asks the user before closing their own tab with unsaved changes', () => {
    const verdict = evaluateUnloadPrompt({ userInitiated: true, hasUnloadHandler: true });
    expect(verdict.action).toBe('confirm');
  });

  it('refuses to let the agent close a tab with unsaved changes', () => {
    // The agent has no standing to discard a form the user filled in, and no way to judge what
    // that unsaved content is worth. A refusal gives it an explicit failure instead.
    const verdict = evaluateUnloadPrompt({ userInitiated: false, hasUnloadHandler: true });
    expect(verdict.action).toBe('refuse');
    expect(verdict.action === 'refuse' && verdict.message).toMatch(/unsaved/i);
  });
});

describe('evaluateCertificateError', () => {
  it('refuses an agent-driven navigation on any certificate error, without asking', () => {
    const verdict = evaluateCertificateError({
      error: 'net::ERR_CERT_DATE_INVALID',
      hostname: 'example.com',
      agentInitiated: true,
    });
    expect(verdict.action).toBe('refuse');
  });

  it('lets the user decide on a recoverable error they navigated into themselves', () => {
    const verdict = evaluateCertificateError({
      error: 'net::ERR_CERT_DATE_INVALID',
      hostname: 'example.com',
      agentInitiated: false,
    });
    expect(verdict.action).toBe('confirm');
  });

  it.each([
    'net::ERR_CERT_REVOKED',
    'net::ERR_CERT_KNOWN_INTERCEPTION_BLOCKED',
    'net::ERR_SSL_PINNED_KEY_NOT_IN_CERT_CHAIN',
    'net::ERR_CERT_INVALID',
  ])('offers no way through %s even for a user-driven navigation', (error) => {
    expect(evaluateCertificateError({ error, hostname: 'example.com', agentInitiated: false }).action).toBe('refuse');
  });

  it('names the host and the error, so the message says something the user can act on', () => {
    const verdict = evaluateCertificateError({
      error: 'net::ERR_CERT_AUTHORITY_INVALID',
      hostname: 'intranet.example.com',
      agentInitiated: false,
    });
    expect(verdict.message).toContain('intranet.example.com');
    expect(verdict.message).toContain('net::ERR_CERT_AUTHORITY_INVALID');
  });
});
