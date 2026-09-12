/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { getBackendAuthHeaders } from '@/common/adapter/httpBridge';
import type { ChatFileRef } from '@/common/types/chatFile';
import { buildPdfSrc } from '../../../previewUrls';

export type PdfDocumentSource =
  | string
  | {
      url: string;
      httpHeaders: Record<string, string>;
      withCredentials: boolean;
    };

/** Build a PDF.js source while keeping the backend token out of the URL. */
export const buildPdfDocumentSource = (fileRef?: ChatFileRef, content?: string): PdfDocumentSource | null => {
  if (fileRef) {
    return {
      url: buildPdfSrc(fileRef),
      httpHeaders: getBackendAuthHeaders(),
      withCredentials: true,
    };
  }
  return content || null;
};

export const describePdfError = (error: unknown): 'password' | 'invalid' | 'missing' | 'unknown' => {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (name === 'PasswordException' || message.includes('password')) return 'password';
  if (name === 'InvalidPDFException' || message.includes('invalid pdf')) return 'invalid';
  if (name === 'MissingPDFException' || message.includes('missing pdf') || message.includes('404')) return 'missing';
  return 'unknown';
};
