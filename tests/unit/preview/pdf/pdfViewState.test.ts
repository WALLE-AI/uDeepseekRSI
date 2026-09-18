/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  clampPdfPage,
  readPdfViewState,
  savePdfViewState,
} from '@renderer/pages/conversation/Preview/components/viewers/PDFViewer/pdfViewState';
import { describe, expect, it } from 'vitest';

describe('PDF view state', () => {
  it('restores page and zoom state for an existing tab', () => {
    savePdfViewState('tab-a:file-a', { pageNumber: 8, scale: 1.5, fitWidth: false });
    expect(readPdfViewState('tab-a:file-a')).toEqual({ pageNumber: 8, scale: 1.5, fitWidth: false });
  });

  it('clamps a restored page to the loaded document', () => {
    expect(clampPdfPage(200, 12)).toBe(12);
    expect(clampPdfPage(0, 12)).toBe(1);
  });
});
