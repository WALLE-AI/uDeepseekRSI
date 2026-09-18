/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 单页 PDF：canvas + 可选中的文本层。
 *
 * 这个组件的核心职责是「进出可视区」这件事——`active` 为 false 时它只留一个占位 div，
 * 不建 canvas、不建文本层。一页 A4 在 2x 位图下大约 8MB，100 页文档如果全都常驻，
 * 光位图就接近 1GB；释放不在可视区的页是这份内存预算唯一的兜底。
 *
 * A single PDF page: canvas plus a selectable text layer. Its central responsibility is
 * entering and leaving the viewport — when `active` is false it renders nothing but a
 * placeholder div, with no canvas and no text layer. An A4 page at a 2x bitmap is roughly 8MB,
 * so a 100-page document that kept every page resident would approach a gigabyte of bitmaps;
 * releasing off-screen pages is the only thing holding that budget down.
 */

import React, { useEffect, useRef } from 'react';
import type { PdfjsModule, PdfTextLayer } from './pdfTypes';
import type { PdfPageMatch } from './pdfSearch';
import { buildPdfHighlightRuns, slicePdfMatchAcrossItems } from './pdfSearch';
import { pdfOutputScale } from './pdfLayout';
import styles from './PDFViewer.module.css';

type PdfPageProps = {
  pdfjs: PdfjsModule;
  document: import('pdfjs-dist').PDFDocumentProxy;
  /** 1 基页码 / One-based page number. */
  pageNumber: number;
  /** 页顶在文档坐标系里的 y 偏移 / Offset of the page top within the document. */
  top: number;
  width: number;
  height: number;
  scale: number;
  /** 是否落在渲染区间内 / Whether this page is inside the render band. */
  active: boolean;
  matches: readonly PdfPageMatch[];
  activeMatch: PdfPageMatch | null;
  onRenderError: (error: unknown) => void;
};

/**
 * 把搜索命中写进文本层的 DOM。
 *
 * 直接改 textDiv 的子节点，而不是另铺一层高亮 div：文本层的每个 span 位置和字体都已经
 * 由 PDF.js 算好，在它内部切片天然跟着走；再铺一层就得自己复刻整套排版，缩放时必然错位。
 *
 * Write search matches into the text layer's DOM by editing each text div's children rather
 * than overlaying a separate highlight layer: PDF.js has already positioned and sized every
 * span, so slicing inside one inherits that for free, whereas an overlay would mean
 * reimplementing the layout and would drift on every zoom.
 */
const paintHighlights = (
  textLayer: PdfTextLayer,
  matches: readonly PdfPageMatch[],
  activeMatch: PdfPageMatch | null,
  touched: Set<number>
): HTMLElement | null => {
  const items = textLayer.textContentItemsStr;
  const divs = textLayer.textDivs;

  // 先把上一轮改过的节点还原成纯文本，避免高亮层层叠加。
  // Restore previously edited nodes to plain text first, so highlights cannot accumulate.
  for (const index of touched) {
    const div = divs[index];
    if (div) div.textContent = items[index] ?? '';
  }
  touched.clear();

  // 每个文本片段收集自己身上的所有区间，再一次性重建，避免同一节点被改多次。
  // Collect every range landing on each run, then rebuild once, so a node is never edited twice.
  const byItem = new Map<number, { start: number; end: number; selected: boolean }[]>();
  for (const match of matches) {
    const selected =
      activeMatch !== null &&
      activeMatch.pageNumber === match.pageNumber &&
      activeMatch.start === match.start &&
      activeMatch.end === match.end;
    for (const slice of slicePdfMatchAcrossItems(items, match)) {
      const ranges = byItem.get(slice.itemIndex) ?? [];
      ranges.push({ start: slice.start, end: slice.end, selected });
      byItem.set(slice.itemIndex, ranges);
    }
  }

  let selectedElement: HTMLElement | null = null;
  for (const [itemIndex, ranges] of byItem) {
    const div = divs[itemIndex];
    const text = items[itemIndex] ?? '';
    if (!div) continue;

    const runs = buildPdfHighlightRuns(text.length, ranges);
    if (runs.length === 0) continue;

    const fragment = window.document.createDocumentFragment();
    let cursor = 0;
    for (const run of runs) {
      if (run.start > cursor) fragment.append(text.slice(cursor, run.start));
      const mark = window.document.createElement('span');
      // 类名沿用 PDF.js 的命名，样式表里用 :global 对应，便于和上游文档对照。
      // Class names follow PDF.js's own, matched by :global in the stylesheet.
      mark.className = run.selected ? 'highlight selected' : 'highlight';
      mark.textContent = text.slice(run.start, run.end);
      if (run.selected && !selectedElement) selectedElement = mark;
      fragment.append(mark);
      cursor = run.end;
    }
    if (cursor < text.length) fragment.append(text.slice(cursor));

    div.textContent = '';
    div.append(fragment);
    touched.add(itemIndex);
  }

  return selectedElement;
};

const PdfPage: React.FC<PdfPageProps> = ({
  pdfjs,
  document,
  pageNumber,
  top,
  width,
  height,
  scale,
  active,
  matches,
  activeMatch,
  onRenderError,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<PdfTextLayer | null>(null);
  const touchedRef = useRef(new Set<number>());

  useEffect(() => {
    if (!active) return;

    let disposed = false;
    let renderTask: import('pdfjs-dist').RenderTask | null = null;

    void document
      .getPage(pageNumber)
      .then(async (page) => {
        if (disposed) return;
        const canvas = canvasRef.current;
        const textContainer = textLayerRef.current;
        if (!canvas || !textContainer) return;

        const viewport = page.getViewport({ scale });
        const outputScale = pdfOutputScale(window.devicePixelRatio);
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        renderTask = page.render({
          canvas,
          viewport,
          transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
        });
        await renderTask.promise;
        if (disposed) return;

        // 文本层放在 canvas 之后建：它只影响选中和搜索，先把画面显示出来更重要。
        // Build the text layer after the canvas: it only affects selection and search, so
        // getting pixels on screen first matters more.
        textContainer.textContent = '';
        const textLayer = new pdfjs.TextLayer({
          textContentSource: page.streamTextContent(),
          container: textContainer,
          viewport,
        });
        layerRef.current = textLayer;
        await textLayer.render();
      })
      .catch((error: unknown) => {
        if (disposed) return;
        // 取消是正常的翻页/缩放路径，不是错误。
        // Cancellation is the ordinary paging and zooming path, not a failure.
        const name = error instanceof Error ? error.name : '';
        if (name === 'RenderingCancelledException' || name === 'AbortException') return;
        onRenderError(error);
      });

    return () => {
      disposed = true;
      renderTask?.cancel();
      layerRef.current?.cancel();
      layerRef.current = null;
      touchedRef.current.clear();
      // 把位图尺寸归零，让浏览器立刻回收这页的显存，而不是等 DOM 节点被回收。
      // Zero the bitmap so the browser reclaims this page's memory immediately rather than
      // waiting for the DOM node to be collected.
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      if (textLayerRef.current) textLayerRef.current.textContent = '';
    };
  }, [active, document, onRenderError, pageNumber, pdfjs, scale]);

  useEffect(() => {
    const textLayer = layerRef.current;
    if (!active || !textLayer) return;
    const selected = paintHighlights(textLayer, matches, activeMatch, touchedRef.current);
    selected?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, [active, activeMatch, matches]);

  return (
    <div
      className={styles.page}
      data-page-number={pageNumber}
      style={{
        top: `${top}px`,
        width: `${width}px`,
        height: `${height}px`,
        // 文本层的尺寸由 PDF.js 写成 calc(var(--total-scale-factor) * …)，这里提供该变量。
        // PDF.js sizes the text layer as calc(var(--total-scale-factor) * …); supply it here.
        ['--total-scale-factor' as string]: `${scale}`,
      }}
    >
      {active ? <canvas ref={canvasRef} className={styles.canvas} /> : <div className={styles.placeholder} />}
      <div ref={textLayerRef} className={styles.textLayer} />
      <span className={styles.pageBadge}>{pageNumber}</span>
    </div>
  );
};

export default React.memo(PdfPage);
