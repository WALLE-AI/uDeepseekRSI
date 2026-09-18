/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildPdfHighlightRuns,
  findPdfMatchesInText,
  normalizePdfSearchText,
  slicePdfMatchAcrossItems,
  sortPdfPageMatches,
  stepPdfMatch,
} from '@renderer/pages/conversation/Preview/components/viewers/PDFViewer/pdfSearch';
import { describe, expect, it } from 'vitest';

describe('normalizePdfSearchText', () => {
  it('lowercases without changing length', () => {
    const input = 'Hello WORLD';
    expect(normalizePdfSearchText(input)).toBe('hello world');
    expect(normalizePdfSearchText(input)).toHaveLength(input.length);
  });

  it('leaves characters that would lengthen under toLowerCase untouched', () => {
    // 'İ'.toLowerCase() 是两个码元；替换进去会让后续所有下标偏移，整页高亮错位。
    const input = 'İstanbul';
    expect(normalizePdfSearchText(input)).toHaveLength(input.length);
    expect(normalizePdfSearchText(input)).toBe('İstanbul');
  });
});

describe('findPdfMatchesInText', () => {
  it('finds every occurrence, case-insensitively', () => {
    expect(findPdfMatchesInText('Cat cat CAT', 'cat')).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 11 },
    ]);
  });

  it('finds overlapping matches, like the browser find bar', () => {
    expect(findPdfMatchesInText('aaa', 'aa')).toEqual([
      { start: 0, end: 2 },
      { start: 1, end: 3 },
    ]);
  });

  it('treats regex metacharacters as literals', () => {
    // 查询串是用户输入；插进正则的话 "f(x)" 会变成捕获组，搜不到还可能抛异常。
    expect(findPdfMatchesInText('call f(x) twice', 'f(x)')).toEqual([{ start: 5, end: 9 }]);
    expect(findPdfMatchesInText('a.b and axb', 'a.b')).toEqual([{ start: 0, end: 3 }]);
  });

  it('returns nothing for an empty query', () => {
    expect(findPdfMatchesInText('anything', '')).toEqual([]);
  });

  it('matches CJK text', () => {
    expect(findPdfMatchesInText('预览面板与预览标签', '预览')).toEqual([
      { start: 0, end: 2 },
      { start: 5, end: 7 },
    ]);
  });
});

describe('slicePdfMatchAcrossItems', () => {
  const items = ['hel', 'lo ', 'world'];

  it('maps a match contained in one run to run-relative offsets', () => {
    expect(slicePdfMatchAcrossItems(items, { start: 6, end: 11 })).toEqual([{ itemIndex: 2, start: 0, end: 5 }]);
  });

  it('splits a match that spans several runs', () => {
    // "hello" 在 PDF 里被排版切成 "hel" + "lo"，高亮必须落到两个 DOM 节点上。
    expect(slicePdfMatchAcrossItems(items, { start: 0, end: 5 })).toEqual([
      { itemIndex: 0, start: 0, end: 3 },
      { itemIndex: 1, start: 0, end: 2 },
    ]);
  });

  it('stops walking once the match has been consumed', () => {
    const slices = slicePdfMatchAcrossItems(items, { start: 0, end: 1 });
    expect(slices).toEqual([{ itemIndex: 0, start: 0, end: 1 }]);
  });

  it('skips empty runs without producing zero-width slices', () => {
    expect(slicePdfMatchAcrossItems(['ab', '', 'cd'], { start: 1, end: 3 })).toEqual([
      { itemIndex: 0, start: 1, end: 2 },
      { itemIndex: 2, start: 0, end: 1 },
    ]);
  });

  it('returns nothing when the match lies past the end of the runs', () => {
    expect(slicePdfMatchAcrossItems(items, { start: 100, end: 105 })).toEqual([]);
  });
});

describe('buildPdfHighlightRuns', () => {
  it('keeps disjoint ranges separate', () => {
    expect(
      buildPdfHighlightRuns(10, [
        { start: 0, end: 2, selected: false },
        { start: 5, end: 7, selected: false },
      ])
    ).toEqual([
      { start: 0, end: 2, selected: false },
      { start: 5, end: 7, selected: false },
    ]);
  });

  it('merges adjacent ranges of the same kind', () => {
    expect(
      buildPdfHighlightRuns(10, [
        { start: 0, end: 3, selected: false },
        { start: 3, end: 6, selected: false },
      ])
    ).toEqual([{ start: 0, end: 6, selected: false }]);
  });

  it('lets the selected range win where matches overlap', () => {
    // "aa" 在 "aaa" 里有两处重叠命中；选中的那一处必须仍然显示为选中色，
    // 否则按「下一个」时界面看不出任何变化。
    const runs = buildPdfHighlightRuns(3, [
      { start: 0, end: 2, selected: false },
      { start: 1, end: 3, selected: true },
    ]);
    expect(runs).toEqual([
      { start: 0, end: 1, selected: false },
      { start: 1, end: 3, selected: true },
    ]);
  });

  it('clamps ranges that fall outside the run', () => {
    expect(buildPdfHighlightRuns(4, [{ start: -5, end: 99, selected: false }])).toEqual([
      { start: 0, end: 4, selected: false },
    ]);
  });

  it('produces nothing for an empty run or no ranges', () => {
    expect(buildPdfHighlightRuns(0, [{ start: 0, end: 1, selected: true }])).toEqual([]);
    expect(buildPdfHighlightRuns(5, [])).toEqual([]);
  });
});

describe('stepPdfMatch', () => {
  it('wraps at both ends', () => {
    expect(stepPdfMatch(3, 2, 1)).toBe(0);
    expect(stepPdfMatch(3, 0, -1)).toBe(2);
  });

  it('enters the list from the correct end when nothing is selected', () => {
    expect(stepPdfMatch(3, -1, 1)).toBe(0);
    expect(stepPdfMatch(3, -1, -1)).toBe(2);
  });

  it('reports no selection for an empty result set', () => {
    expect(stepPdfMatch(0, -1, 1)).toBe(-1);
  });
});

describe('sortPdfPageMatches', () => {
  it('orders by page, then by position, so "next" follows reading order', () => {
    // 各页是并发搜索的，到达顺序不确定。
    const sorted = sortPdfPageMatches([
      { pageNumber: 3, start: 5, end: 8 },
      { pageNumber: 1, start: 9, end: 12 },
      { pageNumber: 1, start: 2, end: 5 },
    ]);
    expect(sorted).toEqual([
      { pageNumber: 1, start: 2, end: 5 },
      { pageNumber: 1, start: 9, end: 12 },
      { pageNumber: 3, start: 5, end: 8 },
    ]);
  });

  it('does not mutate its input', () => {
    const input = [
      { pageNumber: 2, start: 0, end: 1 },
      { pageNumber: 1, start: 0, end: 1 },
    ];
    sortPdfPageMatches(input);
    expect(input[0].pageNumber).toBe(2);
  });
});
