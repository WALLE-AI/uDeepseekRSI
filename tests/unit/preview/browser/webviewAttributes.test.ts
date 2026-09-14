/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Guards for the `<webview>` attribute map.
 *
 * Two things are worth locking down here. First, Chromium's built-in PDF viewer is gated
 * behind the `plugins` flag; with it off a PDF navigation is silently reclassified as a
 * download and the Browser tab just goes blank. Second, Electron's webview boolean
 * attributes are presence-based, so writing `plugins="false"` would *enable* the very
 * thing it looks like it disables — the key has to be absent instead.
 *
 * WebviewHost cannot be rendered under jsdom (<webview> is an Electron-only tag that never
 * mounts), so the decision is extracted as a plain unit and tested directly.
 */

import { describe, expect, it } from 'vitest';
import { buildWebviewAttributes } from '@/renderer/components/media/webviewAttributes';

describe('buildWebviewAttributes', () => {
  it('omits the plugins key entirely by default', () => {
    // Presence-based attribute: 'false' would switch the PDF viewer ON, so assert absence.
    expect(buildWebviewAttributes({})).not.toHaveProperty('plugins');
  });

  it('enables the built-in PDF viewer when a consumer opts in', () => {
    expect(buildWebviewAttributes({ allowPdfViewer: true }).plugins).toBe('true');
  });

  it('still omits plugins when the opt-in is explicitly false', () => {
    expect(buildWebviewAttributes({ allowPdfViewer: false })).not.toHaveProperty('plugins');
  });

  it('sets partition only when one is supplied', () => {
    expect(buildWebviewAttributes({ partition: 'persist:aionui-browser' }).partition).toBe('persist:aionui-browser');
    expect(buildWebviewAttributes({})).not.toHaveProperty('partition');
  });

  /**
   * Regression guard: these are the hostile-page defaults for a webview that loads
   * arbitrary external sites. Enabling the PDF viewer must not have relaxed any of them,
   * and neither should a future edit to this helper.
   */
  it('keeps the untrusted-page web preferences unchanged, PDF viewer or not', () => {
    const expected = 'contextIsolation=yes, nodeIntegration=no, nativeWindowOpen=no';
    expect(buildWebviewAttributes({}).webpreferences).toBe(expected);
    expect(buildWebviewAttributes({ allowPdfViewer: true }).webpreferences).toBe(expected);
  });

  it('returns a fresh object per call so callers cannot mutate a shared default', () => {
    const first = buildWebviewAttributes({});
    first.webpreferences = 'tampered';
    expect(buildWebviewAttributes({}).webpreferences).toBe(
      'contextIsolation=yes, nodeIntegration=no, nativeWindowOpen=no'
    );
  });
});
