/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Download verdicts. The file name arrives from a remote server, so every case here treats it as
 * hostile input: a name that renders as `.pdf` while ending in `.exe`, a MIME type that disagrees
 * with the extension, and a Content-Length that lies.
 */

import { describe, expect, it } from 'vitest';

import {
  classifyDownloadKind,
  createBrowserDownloadId,
  DEFAULT_MAX_DOWNLOAD_BYTES,
  evaluateBrowserDownload,
  exceedsDownloadLimit,
  isPdfDownload,
  stripBidiControls,
} from '@process/services/browser-control/policies/downloadPolicy';

/** U+202E right-to-left override, by code point: it is invisible in source. */
const RLO = '\u202E';

describe('classifyDownloadKind', () => {
  it.each([
    ['setup.exe', 'executable'],
    ['Installer.MSI', 'executable'],
    ['app.dmg', 'executable'],
    ['tool.appimage', 'executable'],
    ['lib.dll', 'executable'],
    ['shortcut.lnk', 'executable'],
    ['run.bat', 'script'],
    ['deploy.ps1', 'script'],
    ['setup.sh', 'script'],
    ['index.mjs', 'script'],
    ['patch.reg', 'script'],
    ['report.pdf', 'other'],
    ['photo.PNG', 'other'],
    ['archive.zip', 'other'],
    ['notes', 'other'],
  ])('classifies %s as %s', (fileName, kind) => {
    expect(classifyDownloadKind(fileName)).toBe(kind);
  });

  it('classifies a DLL as executable even though double-clicking it does nothing', () => {
    // A DLL in the downloads directory is the raw material for DLL hijacking.
    expect(classifyDownloadKind('version.dll')).toBe('executable');
  });

  it('sees through a right-to-left override that makes an .exe render as .pdf', () => {
    expect(classifyDownloadKind(`invoice${RLO}fdp.exe`)).toBe('executable');
  });

  it('uses the MIME type when the extension gives nothing away', () => {
    expect(classifyDownloadKind('update', 'application/x-msdownload')).toBe('executable');
  });

  it('ignores MIME parameters when matching', () => {
    expect(classifyDownloadKind('update', 'application/x-msdownload; charset=binary')).toBe('executable');
  });

  it('does not let a harmless MIME type relax a dangerous extension', () => {
    expect(classifyDownloadKind('setup.exe', 'text/plain')).toBe('executable');
  });
});

describe('stripBidiControls', () => {
  it('removes the override so the name shown matches the name on disk', () => {
    expect(stripBidiControls(`invoice${RLO}fdp.exe`)).toBe('invoicefdp.exe');
  });

  it('leaves an ordinary name untouched, non-ASCII included', () => {
    expect(stripBidiControls('季度报告 v2.pdf')).toBe('季度报告 v2.pdf');
  });
});

describe('evaluateBrowserDownload', () => {
  it('allows an ordinary document', () => {
    expect(evaluateBrowserDownload({ fileName: 'report.pdf', totalBytes: 1024 })).toEqual({ action: 'allow' });
  });

  it('asks before saving a program', () => {
    expect(evaluateBrowserDownload({ fileName: 'setup.exe' })).toMatchObject({
      action: 'confirm',
      reason: 'executable',
    });
  });

  it('asks before saving a script', () => {
    expect(evaluateBrowserDownload({ fileName: 'install.sh' })).toMatchObject({ action: 'confirm', reason: 'script' });
  });

  it('blocks a download the server declares to be over the limit', () => {
    expect(evaluateBrowserDownload({ fileName: 'huge.dat', totalBytes: 2048, maxBytes: 1024 })).toMatchObject({
      action: 'block',
      reason: 'tooLarge',
    });
  });

  it('blocks on size before asking about the file type, since a refusal is cheaper than a prompt', () => {
    expect(evaluateBrowserDownload({ fileName: 'huge.exe', totalBytes: 2048, maxBytes: 1024 })).toMatchObject({
      action: 'block',
      reason: 'tooLarge',
    });
  });

  it('allows a download exactly at the limit', () => {
    expect(evaluateBrowserDownload({ fileName: 'exact.dat', totalBytes: 1024, maxBytes: 1024 })).toEqual({
      action: 'allow',
    });
  });

  it('does not block a chunked transfer whose size is unknown up front', () => {
    // A chunked response reports 0 bytes; the backstop during transfer is what covers it.
    expect(evaluateBrowserDownload({ fileName: 'stream.dat', totalBytes: 0, maxBytes: 1024 })).toEqual({
      action: 'allow',
    });
  });

  it('defaults to a 2 GiB cap', () => {
    expect(DEFAULT_MAX_DOWNLOAD_BYTES).toBe(2 * 1024 * 1024 * 1024);
    expect(evaluateBrowserDownload({ fileName: 'a.dat', totalBytes: DEFAULT_MAX_DOWNLOAD_BYTES + 1 })).toMatchObject({
      action: 'block',
    });
  });
});

describe('exceedsDownloadLimit', () => {
  it('catches a response that declared 1 KB and kept streaming', () => {
    expect(exceedsDownloadLimit(2048, 1024)).toBe(true);
  });

  it('does not fire at exactly the limit', () => {
    expect(exceedsDownloadLimit(1024, 1024)).toBe(false);
  });
});

describe('isPdfDownload', () => {
  it('recognizes the .pdf extension', () => {
    expect(isPdfDownload('report.pdf')).toBe(true);
  });

  it('is case-insensitive on the extension', () => {
    expect(isPdfDownload('Report.PDF')).toBe(true);
  });

  it('falls back to the MIME type when the extension gives nothing away', () => {
    expect(isPdfDownload('download', 'application/pdf')).toBe(true);
  });

  it('ignores MIME parameters when matching', () => {
    expect(isPdfDownload('download', 'application/pdf; charset=binary')).toBe(true);
  });

  it('is false for an unrelated extension and MIME type', () => {
    expect(isPdfDownload('photo.png', 'image/png')).toBe(false);
  });

  it('is false with no extension and no MIME type', () => {
    expect(isPdfDownload('notes')).toBe(false);
  });
});

describe('createBrowserDownloadId', () => {
  it('produces a distinct prefixed id each time', () => {
    const first = createBrowserDownloadId();
    const second = createBrowserDownloadId();
    expect(first).toMatch(/^dl-/);
    expect(first).not.toBe(second);
  });
});
