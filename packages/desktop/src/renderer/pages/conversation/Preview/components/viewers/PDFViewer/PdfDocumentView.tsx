/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 连续滚动的 PDF 文档视图。
 *
 * 这一层负责三件事：量容器、按可视区决定哪些页该渲染、以及全文搜索的取字与匹配。
 * 布局和匹配的算法都放在 pdfLayout.ts / pdfSearch.ts 里（纯函数、有单测），这里只剩
 * 与 DOM 和 PDF.js 打交道的部分——jsdom 测不动的那部分尽量少。
 *
 * The continuous-scroll PDF document view. This layer does three things: measure the
 * container, decide which pages belong in the render band, and drive full-text extraction and
 * matching for search. The layout and matching algorithms live in pdfLayout.ts / pdfSearch.ts
 * as unit-tested pure functions, leaving only the DOM and PDF.js plumbing here — deliberately
 * keeping the part jsdom cannot exercise as small as possible.
 */

import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import PdfPage from './PdfPage';
import styles from './PDFViewer.module.css';
import type { PdfPageSize } from './pdfLayout';
import {
  buildPdfPageOffsets,
  currentPdfPage,
  expandPdfRenderRange,
  PDF_VIEWPORT_PADDING,
  pdfPageTop,
  pdfScrollTopForPage,
  resolvePdfScale,
  totalPdfHeight,
  visiblePdfPageRange,
} from './pdfLayout';
import type { PdfPageMatch } from './pdfSearch';
import { findPdfMatchesInText, sortPdfPageMatches } from './pdfSearch';
import type { PdfjsModule } from './pdfTypes';

export type PdfDocumentHandle = { scrollToPage: (pageNumber: number) => void };

export type PdfSearchState = { matches: PdfPageMatch[]; searching: boolean };

type PdfDocumentViewProps = {
  pdfjs: PdfjsModule;
  document: import('pdfjs-dist').PDFDocumentProxy;
  scale: number;
  fitWidth: boolean;
  initialPage: number;
  query: string;
  /** 已排序的全文命中，由上层持有 / The sorted match list, owned by the parent. */
  matches: readonly PdfPageMatch[];
  activeMatch: PdfPageMatch | null;
  onSearchState: (state: PdfSearchState) => void;
  onPageChange: (pageNumber: number) => void;
  onError: (errorKey: string) => void;
  handleRef: React.Ref<PdfDocumentHandle>;
};

/** 尺寸细化的上报批次：太小会让滚动条抖，太大又迟迟对不齐 / Batch size for refined page sizes. */
const SIZE_REFINE_BATCH = 25;

/** 搜索防抖窗口，够盖住连续打字又不会让人觉得卡 / Search debounce; covers continuous typing without feeling laggy. */
const PDF_SEARCH_DEBOUNCE_MS = 250;

/** 共享的空数组，避免每次渲染给无命中的页发一个新引用而击穿 React.memo。 */
/** Shared empty array, so pages without matches keep a stable prop and React.memo still bites. */
const NO_MATCHES: readonly PdfPageMatch[] = [];

const PdfDocumentView: React.FC<PdfDocumentViewProps> = ({
  pdfjs,
  document,
  scale,
  fitWidth,
  initialPage,
  query,
  matches,
  activeMatch,
  onSearchState,
  onPageChange,
  onError,
  handleRef,
}) => {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [baseSizes, setBaseSizes] = useState<PdfPageSize[] | null>(null);
  /** 逐页缓存的文本片段，供搜索复用 / Per-page text runs, cached so repeat searches are instant. */
  const pageTextRef = useRef(new Map<number, string[]>());

  useEffect(() => {
    const element = scrollerRef.current;
    if (!element) return;
    const measure = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // ==================== 页尺寸 / Page sizes ====================

  useEffect(() => {
    let disposed = false;
    setBaseSizes(null);
    pageTextRef.current = new Map();

    void document
      .getPage(1)
      .then(async (first) => {
        if (disposed) return;
        const firstViewport = first.getViewport({ scale: 1 });
        const seed: PdfPageSize = { width: firstViewport.width, height: firstViewport.height };

        // 先用首页尺寸铺满，让滚动条和偏移立刻可用；绝大多数 PDF 各页等大，这份
        // 假设通常就是最终结果。之后再逐页校正，混排尺寸（横页、扫描件）才不会错位。
        // Seed every page with the first page's size so offsets and the scrollbar work
        // immediately; in the overwhelming majority of PDFs every page matches, making the
        // assumption exact. Pages are then refined one by one so mixed sizes — landscape
        // pages, scans — still land correctly.
        const sizes = Array.from<PdfPageSize>({ length: document.numPages }).fill(seed);
        setBaseSizes(sizes);

        const refined = sizes.slice();
        for (let pageNumber = 2; pageNumber <= document.numPages; pageNumber++) {
          if (disposed) return;
          const page = await document.getPage(pageNumber);
          const pageViewport = page.getViewport({ scale: 1 });
          refined[pageNumber - 1] = { width: pageViewport.width, height: pageViewport.height };
          if (pageNumber % SIZE_REFINE_BATCH === 0) setBaseSizes(refined.slice());
        }
        if (!disposed) setBaseSizes(refined.slice());
      })
      .catch(() => {
        if (!disposed) onError('preview.pdf.loadFailed');
      });

    return () => {
      disposed = true;
    };
  }, [document, onError]);

  // ==================== 布局 / Layout ====================

  // 取所有页里最宽的那页来算「适合宽度」，而不是首页：否则文档里只要有一张横页，
  // 它就会横向溢出容器。
  // Fit-width is derived from the widest page rather than the first: otherwise a single
  // landscape page anywhere in the document would overflow the container horizontally.
  const baseWidth = useMemo(
    () => (baseSizes ? baseSizes.reduce((widest, size) => Math.max(widest, size.width), 0) : 0),
    [baseSizes]
  );

  const effectiveScale = useMemo(
    () =>
      resolvePdfScale({
        fitWidth,
        scale,
        baseWidth,
        availableWidth: Math.max(240, viewport.width - PDF_VIEWPORT_PADDING),
      }),
    [baseWidth, fitWidth, scale, viewport.width]
  );

  const offsets = useMemo(
    () => buildPdfPageOffsets((baseSizes ?? []).map((size) => size.height * effectiveScale)),
    [baseSizes, effectiveScale]
  );

  const renderRange = useMemo(() => {
    const visible = visiblePdfPageRange({ offsets, scrollTop, viewportHeight: viewport.height });
    if (!visible) return null;
    return expandPdfRenderRange(visible, Math.max(0, offsets.length - 1));
  }, [offsets, scrollTop, viewport.height]);

  const scrollToPage = useCallback(
    (pageNumber: number) => {
      const element = scrollerRef.current;
      if (!element) return;
      element.scrollTo({ top: pdfScrollTopForPage(offsets, pageNumber) });
    },
    [offsets]
  );

  useImperativeHandle(handleRef, () => ({ scrollToPage }), [scrollToPage]);

  const handleScroll = useCallback(() => {
    const element = scrollerRef.current;
    if (!element) return;
    setScrollTop(element.scrollTop);
  }, []);

  useEffect(() => {
    if (offsets.length <= 1 || viewport.height <= 0) return;
    onPageChange(currentPdfPage({ offsets, scrollTop, viewportHeight: viewport.height }));
  }, [offsets, onPageChange, scrollTop, viewport.height]);

  // 缩放会改变所有偏移；不主动锚定的话，视图会跳到文档里完全不相干的位置。
  // 记住缩放前停在哪一页，缩放后滚回去。
  // Zooming changes every offset, and without re-anchoring the view lands somewhere unrelated
  // in the document. Remember the page before the change and scroll back to it afterwards.
  const anchorRef = useRef({ scale: effectiveScale, pageNumber: initialPage });
  useEffect(() => {
    if (offsets.length <= 1) return;
    if (anchorRef.current.scale === effectiveScale) {
      anchorRef.current.pageNumber = currentPdfPage({ offsets, scrollTop, viewportHeight: viewport.height });
      return;
    }
    anchorRef.current.scale = effectiveScale;
    scrollToPage(anchorRef.current.pageNumber);
  }, [effectiveScale, offsets, scrollToPage, scrollTop, viewport.height]);

  // 文档首次可滚动时恢复上次停留的页码。
  // Restore the previously viewed page as soon as the document becomes scrollable.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || offsets.length <= 1 || viewport.height <= 0) return;
    restoredRef.current = true;
    if (initialPage > 1) scrollToPage(initialPage);
  }, [initialPage, offsets.length, scrollToPage, viewport.height]);

  // ==================== 搜索 / Search ====================

  // 打字要防抖：每敲一个字就重扫一遍全文，在几百页的文档上会把 worker 占满，
  // 而中间那些半截查询词的结果用户根本看不到。
  // Debounce typing: rescanning the whole document on every keystroke saturates the worker on
  // a document of any size, and the results for half-typed queries are never seen anyway.
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), PDF_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const query = debouncedQuery;
    if (!query) {
      onSearchState({ matches: [], searching: false });
      return;
    }

    let disposed = false;
    onSearchState({ matches: [], searching: true });
    const found: PdfPageMatch[] = [];

    const run = async () => {
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
        if (disposed) return;

        let items = pageTextRef.current.get(pageNumber);
        if (!items) {
          const page = await document.getPage(pageNumber);
          const textContent = await page.getTextContent();
          // 只保留带 str 的项：PDF.js 的文本层也是这么过滤的，两边的下标必须一致，
          // 否则高亮会整体错位到别的文字上。
          // Keep only items carrying `str`, exactly as PDF.js's text layer does — the two
          // index spaces must agree or highlights land on the wrong words entirely.
          items = textContent.items
            .filter((item): item is typeof item & { str: string } => 'str' in item)
            .map((item) => item.str);
          pageTextRef.current.set(pageNumber, items);
        }
        if (disposed) return;

        for (const match of findPdfMatchesInText(items.join(''), query)) {
          found.push({ pageNumber, ...match });
        }
        // 边找边报：长文档里首个命中应该马上能跳过去，而不是等全文扫完。
        // Report as we go: in a long document the first hit should be navigable immediately
        // rather than after the whole file has been scanned.
        if (pageNumber % SIZE_REFINE_BATCH === 0)
          onSearchState({ matches: sortPdfPageMatches(found), searching: true });
      }
      if (!disposed) onSearchState({ matches: sortPdfPageMatches(found), searching: false });
    };

    void run().catch(() => {
      if (!disposed) onSearchState({ matches: sortPdfPageMatches(found), searching: false });
    });

    return () => {
      disposed = true;
    };
  }, [debouncedQuery, document, onSearchState]);

  // 按页分组，让每个 PdfPage 只拿到自己那几处命中——否则任何一次命中变化都会让
  // 所有页的 props 变化，React.memo 就白加了。
  // Grouped per page so each PdfPage only receives its own matches; passing the whole list
  // would change every page's props on any search change and defeat React.memo.
  const matchesByPage = useMemo(() => {
    const byPage = new Map<number, PdfPageMatch[]>();
    for (const match of matches) {
      const list = byPage.get(match.pageNumber) ?? [];
      list.push(match);
      byPage.set(match.pageNumber, list);
    }
    return byPage;
  }, [matches]);

  // 只在「当前命中真的换了」时滚动。不加这道闸，effect 会跟着 scrollToPage 的身份变化
  // 重跑——而后者依赖 offsets，每批页尺寸校正都会让它变一次，结果是用户滚到哪都会被
  // 反复拽回上一处命中。
  // Scroll only when the current match genuinely changes. Without this guard the effect
  // re-runs whenever scrollToPage's identity changes — and that depends on offsets, which
  // change with every batch of refined page sizes, so the user would be yanked back to the
  // previous match no matter where they scrolled.
  const scrolledMatchRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeMatch) {
      scrolledMatchRef.current = null;
      return;
    }
    const key = `${activeMatch.pageNumber}:${activeMatch.start}:${activeMatch.end}`;
    if (scrolledMatchRef.current === key) return;
    scrolledMatchRef.current = key;
    // 粗跳到页：先把这一页拉进渲染区间，文本层建好后 PdfPage 会再把命中精确居中。
    // A coarse jump to the page pulls it into the render band; once the text layer exists,
    // PdfPage centres the match precisely.
    scrollToPage(activeMatch.pageNumber);
  }, [activeMatch, scrollToPage]);

  const handleRenderError = useCallback(() => onError('preview.pdf.loadFailed'), [onError]);

  return (
    <div ref={scrollerRef} className={styles.viewer} onScroll={handleScroll}>
      <div className={styles.canvasStack} style={{ height: `${totalPdfHeight(offsets)}px` }}>
        {baseSizes?.map((size, index) => {
          const pageNumber = index + 1;
          const inBand = renderRange !== null && index >= renderRange.first && index <= renderRange.last;
          const pageMatches = matchesByPage.get(pageNumber) ?? NO_MATCHES;
          return (
            <PdfPage
              key={pageNumber}
              pdfjs={pdfjs}
              document={document}
              pageNumber={pageNumber}
              top={pdfPageTop(offsets, index)}
              width={size.width * effectiveScale}
              height={size.height * effectiveScale}
              scale={effectiveScale}
              active={inBand}
              matches={pageMatches}
              // 只把当前命中发给它所在的那一页，其余页的 props 保持不变。
              // Only the page owning the current match hears about it; other pages keep stable props.
              activeMatch={activeMatch?.pageNumber === pageNumber ? activeMatch : null}
              onRenderError={handleRenderError}
            />
          );
        })}
      </div>
    </div>
  );
};

export default PdfDocumentView;
