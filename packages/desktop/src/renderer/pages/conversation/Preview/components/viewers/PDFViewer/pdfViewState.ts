/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export type PdfViewState = { pageNumber: number; scale: number; fitWidth: boolean };

const MAX_SAVED_STATES = 50;
const states = new Map<string, PdfViewState>();

export const readPdfViewState = (key: string): PdfViewState =>
  states.get(key) ?? { pageNumber: 1, scale: 1, fitWidth: true };

export const savePdfViewState = (key: string, state: PdfViewState): void => {
  states.delete(key);
  states.set(key, state);
  const oldest = states.keys().next().value;
  if (states.size > MAX_SAVED_STATES && typeof oldest === 'string') states.delete(oldest);
};

export const clampPdfPage = (pageNumber: number, pageCount: number): number =>
  Math.max(1, Math.min(Math.max(1, pageCount), Math.trunc(pageNumber) || 1));
