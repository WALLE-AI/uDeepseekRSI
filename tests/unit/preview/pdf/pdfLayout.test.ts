/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildPdfPageOffsets,
  currentPdfPage,
  expandPdfRenderRange,
  PDF_MAX_SCALE,
  PDF_MIN_SCALE,
  PDF_PAGE_GAP,
  pdfOutputScale,
  pdfPageTop,
  pdfScrollTopForPage,
  resolvePdfScale,
  totalPdfHeight,
  visiblePdfPageRange,
} from '@renderer/pages/conversation/Preview/components/viewers/PDFViewer/pdfLayout';
import { describe, expect, it } from 'vitest';

/** 等高页文档的偏移表，便于用「第 n 页顶端 = n * (100 + gap)」直接推算期望值。 */
const uniformOffsets = (pageCount: number, height = 100) =>
  buildPdfPageOffsets(Array.from({ length: pageCount }, () => height));

describe('resolvePdfScale', () => {
  it('clamps a manual scale to the supported range', () => {
    expect(resolvePdfScale({ fitWidth: false, scale: 10, baseWidth: 600, availableWidth: 800 })).toBe(PDF_MAX_SCALE);
    expect(resolvePdfScale({ fitWidth: false, scale: 0.01, baseWidth: 600, availableWidth: 800 })).toBe(PDF_MIN_SCALE);
    expect(resolvePdfScale({ fitWidth: false, scale: 1.25, baseWidth: 600, availableWidth: 800 })).toBe(1.25);
  });

  it('derives the scale from the container when fitting width', () => {
    expect(resolvePdfScale({ fitWidth: true, scale: 1, baseWidth: 400, availableWidth: 800 })).toBe(2);
  });

  it('still clamps fit-width, so a narrow page cannot blow up the canvas', () => {
    // 名片大小的页 + 宽容器：不夹住就会放大到 40x，位图像素按平方增长。
    expect(resolvePdfScale({ fitWidth: true, scale: 1, baseWidth: 20, availableWidth: 800 })).toBe(PDF_MAX_SCALE);
  });

  it('falls back to 1 before the container has been measured', () => {
    expect(resolvePdfScale({ fitWidth: true, scale: 1, baseWidth: 600, availableWidth: 0 })).toBe(1);
    expect(resolvePdfScale({ fitWidth: true, scale: 1, baseWidth: 0, availableWidth: 800 })).toBe(1);
  });
});

describe('pdfOutputScale', () => {
  it('caps the bitmap multiplier at 2 on high-density screens', () => {
    expect(pdfOutputScale(4)).toBe(2);
    expect(pdfOutputScale(1.5)).toBe(1.5);
  });

  it('never drops below 1, including for absent or nonsense ratios', () => {
    expect(pdfOutputScale(0.5)).toBe(1);
    expect(pdfOutputScale(0)).toBe(1);
    expect(pdfOutputScale(Number.NaN)).toBe(1);
  });
});

describe('buildPdfPageOffsets', () => {
  it('returns one entry per page plus the total height', () => {
    const offsets = buildPdfPageOffsets([100, 200, 300]);
    expect(offsets).toHaveLength(4);
    expect(offsets[0]).toBe(0);
    expect(offsets[1]).toBe(100 + PDF_PAGE_GAP);
    expect(offsets[2]).toBe(300 + PDF_PAGE_GAP * 2);
  });

  it('does not append a gap after the last page', () => {
    // 3 页 + 2 个页间距，而不是 3 个——否则文档底部会多出一段空白。
    expect(totalPdfHeight(buildPdfPageOffsets([100, 200, 300]))).toBe(600 + PDF_PAGE_GAP * 2);
  });

  it('handles mixed page heights, which is why a prefix sum is required', () => {
    const offsets = buildPdfPageOffsets([100, 500, 100], 0);
    expect(offsets).toEqual([0, 100, 600, 700]);
  });

  it('treats an empty document as zero height', () => {
    expect(buildPdfPageOffsets([])).toEqual([0]);
    expect(totalPdfHeight(buildPdfPageOffsets([]))).toBe(0);
  });
});

describe('pdfPageTop', () => {
  it('clamps out-of-range indices instead of returning undefined', () => {
    const offsets = uniformOffsets(3);
    expect(pdfPageTop(offsets, -5)).toBe(0);
    expect(pdfPageTop(offsets, 99)).toBe(offsets[2]);
  });
});

describe('visiblePdfPageRange', () => {
  it('reports only the pages intersecting the viewport', () => {
    const offsets = uniformOffsets(10);
    expect(visiblePdfPageRange({ offsets, scrollTop: 0, viewportHeight: 250 })).toEqual({ first: 0, last: 2 });
  });

  it('excludes a page whose bottom edge exactly meets the scroll position', () => {
    // 第 0 页底边正好是 100；从 100 开始滚动时它一个像素都看不到，不该被渲染。
    const offsets = uniformOffsets(10);
    expect(visiblePdfPageRange({ offsets, scrollTop: 100, viewportHeight: 50 })?.first).toBe(1);
  });

  it('falls back to the nearest page when the viewport lands inside a gap', () => {
    const offsets = uniformOffsets(10);
    const range = visiblePdfPageRange({ offsets, scrollTop: 104, viewportHeight: 4 });
    expect(range).not.toBeNull();
    expect(range?.first).toBe(range?.last);
  });

  it('returns null only for an empty document or an unmeasured viewport', () => {
    expect(visiblePdfPageRange({ offsets: [0], scrollTop: 0, viewportHeight: 500 })).toBeNull();
    expect(visiblePdfPageRange({ offsets: uniformOffsets(3), scrollTop: 0, viewportHeight: 0 })).toBeNull();
  });
});

describe('expandPdfRenderRange', () => {
  it('keeps the resident page count bounded for a large document', () => {
    // 100 页文档、视口里 3 页：渲染集合必须是「可见 + 2」，而不是整份文档。
    const offsets = uniformOffsets(100);
    const visible = visiblePdfPageRange({ offsets, scrollTop: 5000, viewportHeight: 250 });
    const rendered = expandPdfRenderRange(visible!, 100);
    expect(rendered.last - rendered.first + 1).toBeLessThanOrEqual(5);
  });

  it('clamps overscan at both ends of the document', () => {
    expect(expandPdfRenderRange({ first: 0, last: 0 }, 3)).toEqual({ first: 0, last: 1 });
    expect(expandPdfRenderRange({ first: 2, last: 2 }, 3)).toEqual({ first: 1, last: 2 });
  });
});

describe('currentPdfPage', () => {
  it('is 1-based', () => {
    expect(currentPdfPage({ offsets: uniformOffsets(5), scrollTop: 0, viewportHeight: 100 })).toBe(1);
  });

  it('names the page occupying most of the viewport, not the topmost one', () => {
    const offsets = uniformOffsets(5);
    // 视口 [90, 190)：第 0 页只剩 10px，第 1 页占 74px（页顶在 116）。
    expect(currentPdfPage({ offsets, scrollTop: 90, viewportHeight: 100 })).toBe(2);
  });

  it('degrades to page 1 for an empty document', () => {
    expect(currentPdfPage({ offsets: [0], scrollTop: 0, viewportHeight: 100 })).toBe(1);
  });
});

describe('pdfScrollTopForPage', () => {
  it('round-trips with currentPdfPage', () => {
    const offsets = uniformOffsets(20);
    for (const pageNumber of [1, 2, 7, 20]) {
      const scrollTop = pdfScrollTopForPage(offsets, pageNumber);
      expect(currentPdfPage({ offsets, scrollTop, viewportHeight: 100 })).toBe(pageNumber);
    }
  });

  it('never scrolls above the top of the document', () => {
    expect(pdfScrollTopForPage(uniformOffsets(5), 1)).toBe(0);
    expect(pdfScrollTopForPage(uniformOffsets(5), -3)).toBe(0);
  });

  it('clamps a page number past the end of the document', () => {
    const offsets = uniformOffsets(5);
    expect(pdfScrollTopForPage(offsets, 999)).toBe(pdfScrollTopForPage(offsets, 5));
  });
});
