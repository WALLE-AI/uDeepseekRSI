/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Guards for the in-app browser's download fallback.
 *
 * Two of these are security properties rather than conveniences. The suggested file name
 * comes straight from a remote server, so it is attacker-controlled: it must never be able
 * to escape the downloads directory or produce a name the filesystem rejects. And the
 * containment check is what stands between "reveal the file we just saved" and "hand the
 * OS file manager any path the renderer asks for".
 */

import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  session: { fromPartition: () => ({ on: () => undefined }) },
}));

import {
  ensureUniqueDownloadPath,
  isInsideDirectory,
  safeDownloadFileName,
} from '@process/services/browser-control/browserDownloads';

describe('safeDownloadFileName', () => {
  it('keeps an ordinary name untouched, spaces and hyphens included', () => {
    expect(safeDownloadFileName('quarterly report-v2.pdf')).toBe('quarterly report-v2.pdf');
  });

  it('keeps non-ASCII names intact', () => {
    expect(safeDownloadFileName('报告 sample.pdf')).toBe('报告 sample.pdf');
  });

  it.each([
    ['../../../etc/passwd', 'passwd'],
    ['..\\..\\Windows\\System32\\evil.dll', 'evil.dll'],
    ['/absolute/path/report.pdf', 'report.pdf'],
  ])('strips directory traversal from %s', (input, expected) => {
    expect(safeDownloadFileName(input)).toBe(expected);
  });

  it('replaces characters that are illegal in a file name', () => {
    expect(safeDownloadFileName('a<b>c:d"e|f?g*h.pdf')).toBe('a_b_c_d_e_f_g_h.pdf');
  });

  it('removes control characters without mangling the rest', () => {
    // Built from char codes so the control bytes stay visible in the source.
    const bell = String.fromCharCode(0x07);
    const unitSeparator = String.fromCharCode(0x1f);
    const del = String.fromCharCode(0x7f);
    expect(safeDownloadFileName(`re${bell}po${unitSeparator}rt${del}.pdf`)).toBe('report.pdf');
  });

  it('defuses Windows reserved device names', () => {
    expect(safeDownloadFileName('CON.pdf')).toBe('_CON.pdf');
    expect(safeDownloadFileName('lpt1.txt')).toBe('_lpt1.txt');
  });

  it('drops leading dots so a download cannot become a hidden file', () => {
    expect(safeDownloadFileName('...bashrc')).toBe('bashrc');
  });

  it('strips trailing dots and spaces, which Windows cannot store', () => {
    expect(safeDownloadFileName('report.pdf. ')).toBe('report.pdf');
  });

  it('falls back to a generated name when nothing usable survives', () => {
    expect(safeDownloadFileName('   ')).toMatch(/^download-\d+$/);
    expect(safeDownloadFileName('/')).toMatch(/^download-\d+$/);
  });

  it('truncates an over-long name but preserves the extension', () => {
    const result = safeDownloadFileName(`${'a'.repeat(400)}.pdf`);
    expect(result.length).toBeLessThanOrEqual(180);
    // The extension decides how the file opens, so it must survive truncation.
    expect(result.endsWith('.pdf')).toBe(true);
  });
});

describe('ensureUniqueDownloadPath', () => {
  it('returns the target untouched when nothing is in the way', () => {
    expect(ensureUniqueDownloadPath(path.join('/d', 'a.pdf'), () => false)).toBe(path.join('/d', 'a.pdf'));
  });

  it('never silently overwrites an existing file', () => {
    const taken = new Set([path.join('/d', 'a.pdf')]);
    expect(ensureUniqueDownloadPath(path.join('/d', 'a.pdf'), (candidate) => taken.has(candidate))).toBe(
      path.join('/d', 'a (1).pdf')
    );
  });

  it('keeps counting past the first collision', () => {
    const taken = new Set([path.join('/d', 'a.pdf'), path.join('/d', 'a (1).pdf'), path.join('/d', 'a (2).pdf')]);
    expect(ensureUniqueDownloadPath(path.join('/d', 'a.pdf'), (candidate) => taken.has(candidate))).toBe(
      path.join('/d', 'a (3).pdf')
    );
  });

  it('falls back to a timestamp rather than looping forever', () => {
    const result = ensureUniqueDownloadPath(path.join('/d', 'a.pdf'), () => true);
    expect(result).toMatch(/a-\d+\.pdf$/);
  });
});

describe('isInsideDirectory', () => {
  it('accepts a file directly inside the directory', () => {
    expect(isInsideDirectory('/downloads/AionUi', '/downloads/AionUi/report.pdf')).toBe(true);
  });

  it('rejects the directory itself', () => {
    expect(isInsideDirectory('/downloads/AionUi', '/downloads/AionUi')).toBe(false);
  });

  it('rejects an escape via ..', () => {
    expect(isInsideDirectory('/downloads/AionUi', '/downloads/AionUi/../../etc/passwd')).toBe(false);
  });

  it('rejects a sibling that merely shares the prefix', () => {
    // A naive startsWith check would let this through.
    expect(isInsideDirectory('/downloads/AionUi', '/downloads/AionUi-evil/payload.exe')).toBe(false);
  });

  it('rejects an unrelated absolute path', () => {
    expect(isInsideDirectory('/downloads/AionUi', '/etc/passwd')).toBe(false);
  });
});
