/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PDF 文本搜索。
 *
 * 搜索建立在文本层之上，而不是对 canvas 做 OCR：PDF.js 的 `TextLayer` 已经给出
 * `textContentItemsStr`（每个文本片段的字符串）和 `textDivs`（对应的 DOM 节点），
 * 把命中区间映射回片段索引，就能直接在那些节点上套高亮，不用重新排版。
 *
 * 这里全部是纯函数，原因和 pdfLayout.ts 一样：jsdom 渲染不出文本层，只有把索引映射
 * 单独抽出来才测得到——而索引映射恰恰是最容易写错、错了又最难看出来的部分（偏一位
 * 只会让高亮错开一个字，不会报错）。
 *
 * Text search for the PDF viewer, built on the text layer rather than OCR over the canvas:
 * PDF.js's `TextLayer` already exposes `textContentItemsStr` (the string of each text run)
 * and `textDivs` (their DOM nodes), so mapping a match back to run indices is enough to
 * highlight in place without re-laying anything out.
 *
 * All pure functions, for the same reason as pdfLayout.ts: jsdom cannot render a text layer,
 * so the index mapping is only testable in isolation — and the index mapping is exactly the
 * part that is easy to get wrong and hard to notice, since an off-by-one merely shifts a
 * highlight by one character instead of throwing.
 */

/** 命中区间，相对于整页文本 / A match, as a range over the page's concatenated text. */
export type PdfTextMatch = { start: number; end: number };

/** 页内命中，用于跨页导航 / A match located within a specific page, for cross-page navigation. */
export type PdfPageMatch = PdfTextMatch & { pageNumber: number };

/** 命中落在某个文本片段上的部分 / The slice of a match that falls inside one text run. */
export type PdfMatchSlice = { itemIndex: number; start: number; end: number };

/**
 * 大小写无关归一化，且严格保持长度。
 *
 * 长度必须一致，否则归一化后算出的下标没法映射回原文。`toLowerCase()` 对极少数字符
 * 会变长（比如 'İ' 变成两个码元），这些字符原样保留——宁可漏掉一个生僻字的大小写匹配，
 * 也不能让全页的高亮整体错位。
 *
 * Case-insensitive normalization that strictly preserves length, because otherwise indices
 * computed over the normalized text cannot be mapped back to the original. `toLowerCase()`
 * lengthens a handful of characters ('İ' becomes two code units); those are left as-is.
 * Missing a case-insensitive match on one exotic character is much better than shifting
 * every highlight on the page.
 */
export const normalizePdfSearchText = (text: string): string =>
  text
    .split('')
    .map((unit) => {
      const lowered = unit.toLowerCase();
      return lowered.length === 1 ? lowered : unit;
    })
    .join('');

/**
 * 在一页文本里找出所有命中。
 *
 * 用 indexOf 逐个前进而不是正则：查询串是用户输入的，直接塞进正则会让 `.` `(` `*`
 * 这些字符变成元字符，搜 "f(x)" 会搜不到或者抛异常。
 *
 * All matches within a page's text. `indexOf` stepping rather than a regular expression:
 * the query is user input, and interpolating it would turn `.`, `(`, `*` into metacharacters
 * — searching for "f(x)" would silently miss or throw.
 */
export const findPdfMatchesInText = (text: string, query: string): PdfTextMatch[] => {
  if (!query) return [];
  const haystack = normalizePdfSearchText(text);
  const needle = normalizePdfSearchText(query);
  if (!needle) return [];

  const matches: PdfTextMatch[] = [];
  let cursor = 0;
  for (;;) {
    const found = haystack.indexOf(needle, cursor);
    if (found === -1) break;
    matches.push({ start: found, end: found + needle.length });
    // 前进一个字符而不是整个 needle：这样 "aa" 在 "aaa" 里能找到两处重叠命中，
    // 与浏览器查找一致。
    // Advance by one character rather than the whole needle, so "aa" finds both overlapping
    // matches in "aaa" — the same behaviour as the browser's own find.
    cursor = found + 1;
  }
  return matches;
};

/**
 * 把整页坐标下的命中区间切成「每个文本片段各占哪一段」。
 *
 * 一次命中经常跨多个片段：PDF 的文本是按排版切碎的，"hello" 可能被拆成 "hel" + "lo"
 * 两个 run。返回的每个 slice 都带片段内的相对下标，调用方据此在对应 DOM 节点里插高亮。
 *
 * Split a page-level match range into the portion belonging to each text run. A single match
 * routinely spans several runs — PDF text is fragmented by layout, so "hello" may well be
 * stored as "hel" + "lo". Each returned slice carries run-relative offsets, which is what the
 * caller needs to inject a highlight into the corresponding DOM node.
 */
export const slicePdfMatchAcrossItems = (items: readonly string[], match: PdfTextMatch): PdfMatchSlice[] => {
  const slices: PdfMatchSlice[] = [];
  let itemStart = 0;
  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex] ?? '';
    const itemEnd = itemStart + item.length;
    const start = Math.max(match.start, itemStart);
    const end = Math.min(match.end, itemEnd);
    if (start < end) slices.push({ itemIndex, start: start - itemStart, end: end - itemStart });
    itemStart = itemEnd;
    if (itemStart >= match.end) break;
  }
  return slices;
};

/** 待高亮区间；selected 表示它是当前选中的那一处 / A range to highlight; `selected` marks the current one. */
export type PdfHighlightRange = { start: number; end: number; selected: boolean };

/**
 * 把可能重叠的高亮区间压成一串互不相交、可直接生成 DOM 的片段。
 *
 * 会重叠是因为命中本身允许重叠（"aa" 在 "aaa" 里有两处），而 DOM 里没法让两个 span
 * 互相交叉。这里按字符做标记再合并同色游程：选中态优先于普通命中，所以当前命中即使被
 * 另一处命中盖住，也仍然显示成选中色——否则用户按「下一个」会看到高亮没有任何变化。
 *
 * Flatten possibly-overlapping highlight ranges into disjoint runs that can be turned into DOM
 * directly. Overlap arises because matches themselves may overlap ("aa" occurs twice in "aaa"),
 * and two spans cannot interleave in the DOM. This marks per character and then merges equal
 * runs, with selected taking priority over an ordinary match — so the current match still reads
 * as selected even when another match covers it, which is what makes "next" visibly do anything.
 */
export const buildPdfHighlightRuns = (length: number, ranges: readonly PdfHighlightRange[]): PdfHighlightRange[] => {
  if (length <= 0 || ranges.length === 0) return [];

  // 0 = 无高亮，1 = 命中，2 = 选中命中。
  // 0 = no highlight, 1 = match, 2 = selected match.
  const marks = new Uint8Array(length);
  for (const range of ranges) {
    const start = Math.max(0, Math.min(length, range.start));
    const end = Math.max(0, Math.min(length, range.end));
    const value = range.selected ? 2 : 1;
    for (let index = start; index < end; index++) {
      if (marks[index] < value) marks[index] = value;
    }
  }

  const runs: PdfHighlightRange[] = [];
  let index = 0;
  while (index < length) {
    const value = marks[index];
    if (value === 0) {
      index++;
      continue;
    }
    let end = index + 1;
    while (end < length && marks[end] === value) end++;
    runs.push({ start: index, end, selected: value === 2 });
    index = end;
  }
  return runs;
};

/**
 * 在命中列表里前后移动，到头回绕。
 *
 * 回绕是刻意的：用户按「下一个」到最后一处时，跳回第一处比原地不动更符合预期，
 * 也省掉一个「已到末尾」的提示态。
 *
 * Step through the match list, wrapping at either end. Wrapping is deliberate: on the last
 * match, "next" returning to the first is what a reader expects and removes the need for a
 * separate "end of document" state.
 */
export const stepPdfMatch = (total: number, current: number, direction: 1 | -1): number => {
  if (total <= 0) return -1;
  if (current < 0) return direction === 1 ? 0 : total - 1;
  return (current + direction + total) % total;
};

/**
 * 页码升序、页内按位置升序。
 *
 * 各页的搜索是并发完成的，返回顺序不确定；排序后「下一个命中」才是沿阅读顺序走的。
 *
 * Sorted by page, then by position within the page. Pages are searched concurrently and
 * therefore resolve out of order; sorting is what makes "next match" follow reading order.
 */
export const sortPdfPageMatches = (matches: readonly PdfPageMatch[]): PdfPageMatch[] =>
  matches.toSorted((left, right) => left.pageNumber - right.pageNumber || left.start - right.start);
