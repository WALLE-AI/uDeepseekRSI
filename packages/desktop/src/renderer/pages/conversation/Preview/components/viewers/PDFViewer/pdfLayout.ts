/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 连续滚动 PDF 的布局算法。
 *
 * 为什么是手写布局而不是 react-virtuoso：Virtuoso 按「先挂载、再测量」工作，而 PDF 页
 * 挂载时只有占位高度，canvas 渲染完成后高度才变准。两者叠加会让 Virtuoso 在渲染回调里
 * 重新测量并纠正滚动位置，表现为翻页时画面跳动。PDF 的页高可以在渲染之前就从 viewport
 * 算出来，所以这里改成「先算高度、绝对定位、按可视区间渲染」——完全确定，且整段逻辑是
 * 纯函数，可以脱离 canvas 单测（jsdom 里 canvas 根本画不出来）。
 *
 * Layout maths for the continuous-scroll PDF view. Deliberately hand-rolled rather than
 * react-virtuoso: Virtuoso measures after mount, but a PDF page only knows its true height
 * once the canvas has rendered, so the two fight each other and the correction shows up as
 * the view jumping while you scroll. A PDF page's height is derivable from its viewport
 * *before* rendering, so this computes heights first, positions pages absolutely, and renders
 * only the visible band. Everything here is a pure function, which is what makes it testable
 * without a canvas (jsdom cannot paint one).
 */

export const PDF_MIN_SCALE = 0.5;
export const PDF_MAX_SCALE = 3;
export const PDF_SCALE_STEP = 0.25;

/** 页与页之间的垂直间距 / Vertical gap between consecutive pages. */
export const PDF_PAGE_GAP = 16;

/** 滚动容器的左右内边距，用于算「适合宽度」/ Horizontal padding of the scroller, used by fit-width. */
export const PDF_VIEWPORT_PADDING = 32;

/**
 * 可视区上下各多渲染几页。
 *
 * 1 页足够覆盖一次普通滚轮滚动，同时把常驻 canvas 数量压在「可视页数 + 2」——这正是
 * 「100 页文档不会同时保留 100 个高分辨率 canvas」这条验收标准的实现方式。调大它等于
 * 线性放大内存占用。
 *
 * Extra pages rendered above and below the viewport. One page covers an ordinary wheel
 * scroll while keeping resident canvases at "visible + 2", which is precisely how the
 * "a 100-page document must not hold 100 high-resolution canvases" acceptance criterion is
 * met. Raising it scales memory linearly.
 */
export const PDF_OVERSCAN_PAGES = 1;

export type PdfPageSize = { width: number; height: number };

/** 0 基、闭区间的页索引区间 / A zero-based, inclusive range of page indices. */
export type PdfPageRange = { first: number; last: number };

/**
 * 决定实际渲染用的缩放比。
 *
 * fitWidth 时按容器宽度算，但仍受 MAX_SCALE 约束：否则一个很窄的页（比如名片大小的 PDF）
 * 会被放大到几十倍，canvas 像素数按平方增长，直接吃光显存。
 *
 * Resolve the scale actually used for rendering. Fit-width derives it from the container
 * but stays clamped to MAX_SCALE: without the clamp a narrow page (a business-card-sized
 * PDF, say) would blow up many times over, and canvas pixel count grows quadratically.
 */
export const resolvePdfScale = ({
  fitWidth,
  scale,
  baseWidth,
  availableWidth,
}: {
  fitWidth: boolean;
  scale: number;
  baseWidth: number;
  availableWidth: number;
}): number => {
  if (!fitWidth) return Math.min(PDF_MAX_SCALE, Math.max(PDF_MIN_SCALE, scale));
  if (baseWidth <= 0 || availableWidth <= 0) return 1;
  return Math.min(PDF_MAX_SCALE, Math.max(PDF_MIN_SCALE, availableWidth / baseWidth));
};

/**
 * canvas 的位图倍率。
 *
 * 封顶 2 是刻意的：3x/4x 屏上按真实 devicePixelRatio 渲染，一页 A4 的位图会到几十 MB，
 * 而肉眼几乎分辨不出 2x 之后的差别。
 *
 * Bitmap multiplier for the canvas, deliberately capped at 2: honouring a 3x or 4x
 * devicePixelRatio would put a single A4 page into the tens of megabytes for a difference
 * that is essentially invisible.
 */
export const pdfOutputScale = (devicePixelRatio: number): number =>
  Math.min(2, Math.max(1, Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1));

/**
 * 每页顶端的 y 坐标，外加末尾的文档总高度（长度 = 页数 + 1）。
 *
 * 前缀和而不是「页高 × 序号」：页高各不相同（横页、旋转页、混合纸张的扫描件），
 * 只有前缀和能给出正确的偏移。
 *
 * Top offset of every page plus the document's total height as a final element (length =
 * page count + 1). A prefix sum rather than `height × index` because page heights differ —
 * landscape pages, rotated pages, scans with mixed paper sizes — and only a prefix sum
 * yields correct offsets.
 */
export const buildPdfPageOffsets = (heights: readonly number[], gap: number = PDF_PAGE_GAP): number[] => {
  const offsets: number[] = [];
  let cursor = 0;
  for (const height of heights) {
    offsets.push(cursor);
    cursor += Math.max(0, height) + gap;
  }
  // 最后一页后面不留 gap，否则文档底部会多出一段空白。
  // No gap after the final page, which would otherwise leave dead space at the bottom.
  offsets.push(Math.max(0, cursor - (heights.length > 0 ? gap : 0)));
  return offsets;
};

export const totalPdfHeight = (offsets: readonly number[]): number =>
  offsets.length > 0 ? offsets[offsets.length - 1] : 0;

/** 第 index 页（0 基）的顶端 y 坐标 / Top offset of the zero-based page `index`. */
export const pdfPageTop = (offsets: readonly number[], index: number): number =>
  offsets[Math.max(0, Math.min(offsets.length - 2, index))] ?? 0;

/**
 * 与可视区相交的页区间。
 *
 * 用严格不等号做相交判断：紧贴边界（上一页的底边正好等于 scrollTop）的页不算可见，
 * 否则每次滚动都会多渲染一页，而它一个像素都不会被看到。
 *
 * The range of pages intersecting the viewport. Strict inequalities, so a page whose bottom
 * edge exactly meets `scrollTop` does not count as visible — otherwise every scroll would
 * render one extra page that is never shown by even a single pixel.
 */
export const visiblePdfPageRange = ({
  offsets,
  scrollTop,
  viewportHeight,
}: {
  offsets: readonly number[];
  scrollTop: number;
  viewportHeight: number;
}): PdfPageRange | null => {
  const pageCount = Math.max(0, offsets.length - 1);
  if (pageCount === 0 || viewportHeight <= 0) return null;

  const top = Math.max(0, scrollTop);
  const bottom = top + viewportHeight;

  let first = -1;
  let last = -1;
  for (let index = 0; index < pageCount; index++) {
    const pageTop = offsets[index];
    // offsets[index + 1] 含了页间距，减回去才是这一页真正的底边。
    // offsets[index + 1] includes the gap; subtract it back for the page's real bottom edge.
    const pageBottom = index + 1 < pageCount ? offsets[index + 1] - PDF_PAGE_GAP : offsets[index + 1];
    if (pageBottom <= top || pageTop >= bottom) continue;
    if (first === -1) first = index;
    last = index;
  }

  if (first === -1) {
    // 滚到了页间距里，或者越过了文档末尾：回落到最接近的一页，绝不返回空。
    // Landed in a gap, or past the end of the document: fall back to the nearest page rather
    // than reporting nothing visible.
    const clamped = Math.max(
      0,
      Math.min(pageCount - 1, Math.floor((top / Math.max(1, totalPdfHeight(offsets))) * pageCount))
    );
    return { first: clamped, last: clamped };
  }
  return { first, last };
};

/** 把可视区间向外扩出 overscan 页，并夹在文档范围内 / Widen a range by `overscan`, clamped to the document. */
export const expandPdfRenderRange = (
  range: PdfPageRange,
  pageCount: number,
  overscan: number = PDF_OVERSCAN_PAGES
): PdfPageRange => ({
  first: Math.max(0, range.first - overscan),
  last: Math.min(Math.max(0, pageCount - 1), range.last + overscan),
});

/**
 * 工具栏上显示的「当前页」。
 *
 * 取与可视区重叠面积最大的那一页，而不是最上面那一页：两页各露一半时，显示滚动方向上
 * 占得更多的那页才符合直觉。
 *
 * The page number shown in the toolbar: the page with the largest overlap with the viewport
 * rather than simply the topmost one. With two pages half-showing, naming the one that
 * occupies more of the screen is what a reader expects.
 */
export const currentPdfPage = ({
  offsets,
  scrollTop,
  viewportHeight,
}: {
  offsets: readonly number[];
  scrollTop: number;
  viewportHeight: number;
}): number => {
  const range = visiblePdfPageRange({ offsets, scrollTop, viewportHeight });
  if (!range) return 1;

  const top = Math.max(0, scrollTop);
  const bottom = top + viewportHeight;
  let best = range.first;
  let bestOverlap = -1;
  for (let index = range.first; index <= range.last; index++) {
    const pageCount = Math.max(0, offsets.length - 1);
    const pageTop = offsets[index];
    const pageBottom = index + 1 < pageCount ? offsets[index + 1] - PDF_PAGE_GAP : offsets[index + 1];
    const overlap = Math.min(bottom, pageBottom) - Math.max(top, pageTop);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = index;
    }
  }
  return best + 1;
};

/**
 * 跳到某一页时该滚到的位置。
 *
 * 顶端往上留半个页间距，让这一页看起来不是贴着容器上沿的。
 * Scroll position for jumping to a page, offset by half a gap so the page does not sit flush
 * against the top edge of the scroller.
 */
export const pdfScrollTopForPage = (offsets: readonly number[], pageNumber: number): number => {
  const index = Math.max(0, Math.min(Math.max(0, offsets.length - 2), pageNumber - 1));
  return Math.max(0, (offsets[index] ?? 0) - PDF_PAGE_GAP / 2);
};
