/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PDF interception classification. `isMainFramePdfResponse` must only match a top-level
 * document response, never a PDF embedded as a sub-resource (iframe/embed) — those should
 * render however Chromium normally would.
 */

import { describe, expect, it } from 'vitest';

import {
  isMainFramePdfResponse,
  pdfFileNameFromUrl,
} from '@process/services/browser-control/policies/pdfResponseClassifier';

describe('isMainFramePdfResponse', () => {
  it('matches a top-level document response with an application/pdf mime type', () => {
    expect(
      isMainFramePdfResponse({
        type: 'Document',
        frameId: 'frame-1',
        mainFrameId: 'frame-1',
        mimeType: 'application/pdf',
      })
    ).toBe(true);
  });

  it('is case-insensitive on the mime type', () => {
    expect(
      isMainFramePdfResponse({
        type: 'Document',
        frameId: 'frame-1',
        mainFrameId: 'frame-1',
        mimeType: 'Application/PDF',
      })
    ).toBe(true);
  });

  it('ignores mime type parameters', () => {
    expect(
      isMainFramePdfResponse({
        type: 'Document',
        frameId: 'frame-1',
        mainFrameId: 'frame-1',
        mimeType: 'application/pdf; charset=binary',
      })
    ).toBe(true);
  });

  it('does not match a sub-frame document (an embedded PDF iframe)', () => {
    expect(
      isMainFramePdfResponse({
        type: 'Document',
        frameId: 'frame-2',
        mainFrameId: 'frame-1',
        mimeType: 'application/pdf',
      })
    ).toBe(false);
  });

  it('does not match a non-document resource, e.g. an XHR that happens to return application/pdf', () => {
    expect(
      isMainFramePdfResponse({ type: 'XHR', frameId: 'frame-1', mainFrameId: 'frame-1', mimeType: 'application/pdf' })
    ).toBe(false);
  });

  it('does not match a non-PDF document', () => {
    expect(
      isMainFramePdfResponse({ type: 'Document', frameId: 'frame-1', mainFrameId: 'frame-1', mimeType: 'text/html' })
    ).toBe(false);
  });

  it('does not match when no main frame is known yet', () => {
    expect(
      isMainFramePdfResponse({ type: 'Document', frameId: 'frame-1', mainFrameId: null, mimeType: 'application/pdf' })
    ).toBe(false);
  });
});

describe('pdfFileNameFromUrl', () => {
  it('takes the last path segment as the file name', () => {
    expect(pdfFileNameFromUrl('https://example.com/reports/annual.pdf')).toBe('annual.pdf');
  });

  it('appends .pdf when the URL has no extension', () => {
    expect(pdfFileNameFromUrl('https://example.com/view?doc=42')).toBe('view.pdf');
  });

  it('ignores the query string', () => {
    expect(pdfFileNameFromUrl('https://example.com/reports/annual.pdf?token=abc')).toBe('annual.pdf');
  });

  it('ignores a trailing slash', () => {
    expect(pdfFileNameFromUrl('https://example.com/reports/annual.pdf/')).toBe('annual.pdf');
  });

  it('falls back to a generic name for a malformed URL', () => {
    expect(pdfFileNameFromUrl('not a url')).toBe('document.pdf');
  });

  it('falls back to a generic name for a bare origin with no path', () => {
    expect(pdfFileNameFromUrl('https://example.com')).toBe('document.pdf');
  });
});
