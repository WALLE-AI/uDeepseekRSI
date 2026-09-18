/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 判定 CDP Network.responseReceived 事件是否为「顶层文档、PDF」。
 *
 * 只在主 frame（frameId === mainFrameId）且 type 为 Document 时才算 —— 页面内嵌的
 * PDF（iframe/embed）不受影响，照常按 Chromium 自己的方式渲染。
 *
 * Whether a CDP Network.responseReceived event is a top-level document that is a PDF.
 * Only matches the main frame (frameId === mainFrameId) with type Document — a PDF
 * embedded as a sub-resource (iframe/embed) is left untouched, rendered however
 * Chromium normally would.
 */

export type PdfResponseCandidate = {
  type?: string;
  frameId?: string;
  mainFrameId: string | null;
  mimeType?: string;
};

export const isMainFramePdfResponse = (candidate: PdfResponseCandidate): boolean =>
  candidate.type === 'Document' &&
  candidate.frameId != null &&
  candidate.frameId === candidate.mainFrameId &&
  (candidate.mimeType ?? '').split(';')[0].trim().toLowerCase() === 'application/pdf';

/**
 * 从响应 URL 推导一个候选文件名。落盘前的安全化（非法字符、保留名等）不在这里，
 * 由调用方交给 safeDownloadFileName 处理。
 *
 * Derive a candidate file name from the response URL. Sanitizing it for disk (illegal
 * characters, reserved names, etc.) is not this function's job — the caller hands the
 * result to safeDownloadFileName for that.
 */
export const pdfFileNameFromUrl = (url: string): string => {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    const name = last || 'document';
    return name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`;
  } catch {
    return 'document.pdf';
  }
};
