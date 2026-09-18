/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The upload allowlist. The filesystem is supplied as a fake probe, which is the point of the
 * injected-probe design: symlink escape is the branch that most needs a test and the one hardest
 * to construct for real, since creating a symlink on Windows needs elevation.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  resolveBrowserUploadPath,
  resolveBrowserUploadPaths,
  type BrowserUploadProbe,
} from '@process/services/browser-control/policies/uploadPolicy';

const abs = (...parts: string[]): string => path.resolve(path.sep, ...parts);

const WORKSPACE = abs('work');
const OUTSIDE = abs('secrets');

/**
 * A filesystem where `links` maps a path to the real path it resolves to, and everything else
 * resolves to itself. Anything with a recorded size is a regular file.
 */
const fakeProbe = (
  options: { links?: Record<string, string>; files?: Record<string, number>; directories?: string[] } = {}
): BrowserUploadProbe => ({
  realPath: (candidate) => {
    const resolved = options.links?.[candidate];
    if (resolved) return resolved;
    if (options.files?.[candidate] !== undefined) return candidate;
    if (candidate === WORKSPACE || options.directories?.includes(candidate)) return candidate;
    throw new Error(`ENOENT: ${candidate}`);
  },
  stat: (candidate) => {
    const size = options.files?.[candidate];
    if (size !== undefined) return { isFile: true, size };
    if (candidate === WORKSPACE || options.directories?.includes(candidate)) return { isFile: false, size: 0 };
    return null;
  },
});

describe('resolveBrowserUploadPath', () => {
  it('accepts a file inside the workspace', () => {
    const target = path.join(WORKSPACE, 'report.pdf');
    const outcome = resolveBrowserUploadPath(
      { requestedPath: target, allowedRoots: [WORKSPACE] },
      fakeProbe({ files: { [target]: 1024 } })
    );
    expect(outcome).toEqual({ ok: true, path: target, root: WORKSPACE, size: 1024 });
  });

  it('rejects an arbitrary absolute path outside every allowed root', () => {
    const target = path.join(OUTSIDE, 'id_rsa');
    const outcome = resolveBrowserUploadPath(
      { requestedPath: target, allowedRoots: [WORKSPACE] },
      fakeProbe({ files: { [target]: 10 } })
    );
    expect(outcome).toMatchObject({ ok: false, code: 'OUTSIDE_WORKSPACE' });
  });

  it('rejects a path that traverses out with ..', () => {
    const target = path.join(WORKSPACE, '..', 'secrets', 'id_rsa');
    const outcome = resolveBrowserUploadPath(
      { requestedPath: target, allowedRoots: [WORKSPACE] },
      fakeProbe({ files: { [path.resolve(target)]: 10 } })
    );
    expect(outcome).toMatchObject({ ok: false, code: 'OUTSIDE_WORKSPACE' });
  });

  it('rejects a relative path outright', () => {
    const outcome = resolveBrowserUploadPath({ requestedPath: 'report.pdf', allowedRoots: [WORKSPACE] }, fakeProbe());
    expect(outcome).toMatchObject({ ok: false, code: 'NOT_ABSOLUTE' });
  });

  it('rejects an empty path', () => {
    const outcome = resolveBrowserUploadPath({ requestedPath: '   ', allowedRoots: [WORKSPACE] }, fakeProbe());
    expect(outcome).toMatchObject({ ok: false, code: 'INVALID_PATH' });
  });

  it('rejects a path containing NUL, which would truncate the syscall mid-string', () => {
    const outcome = resolveBrowserUploadPath(
      { requestedPath: `${path.join(WORKSPACE, 'a.txt')}\0.png`, allowedRoots: [WORKSPACE] },
      fakeProbe()
    );
    expect(outcome).toMatchObject({ ok: false, code: 'INVALID_PATH' });
  });

  it('rejects everything when no root is configured', () => {
    const target = path.join(WORKSPACE, 'a.txt');
    const outcome = resolveBrowserUploadPath(
      { requestedPath: target, allowedRoots: [] },
      fakeProbe({ files: { [target]: 1 } })
    );
    expect(outcome).toMatchObject({ ok: false, code: 'OUTSIDE_WORKSPACE' });
  });

  it('rejects a symlink inside the workspace pointing outside it', () => {
    // The requested path passes containment; only resolving the link reveals the escape.
    const link = path.join(WORKSPACE, 'innocent.txt');
    const realTarget = path.join(OUTSIDE, 'id_rsa');
    const outcome = resolveBrowserUploadPath(
      { requestedPath: link, allowedRoots: [WORKSPACE] },
      fakeProbe({ links: { [link]: realTarget }, files: { [realTarget]: 10 } })
    );
    expect(outcome).toMatchObject({ ok: false, code: 'SYMLINK_ESCAPE' });
  });

  it('accepts a symlink that stays inside the workspace', () => {
    const link = path.join(WORKSPACE, 'shortcut.pdf');
    const realTarget = path.join(WORKSPACE, 'deep', 'report.pdf');
    const outcome = resolveBrowserUploadPath(
      { requestedPath: link, allowedRoots: [WORKSPACE] },
      fakeProbe({ links: { [link]: realTarget }, files: { [realTarget]: 2048 } })
    );
    expect(outcome).toMatchObject({ ok: true, path: realTarget, size: 2048 });
  });

  it('accepts a file when the workspace root is itself a symlink', () => {
    // On macOS /tmp is a link to /private/tmp, so the root has to be resolved too.
    const linkedRoot = abs('work');
    const realRoot = abs('private', 'work');
    const target = path.join(linkedRoot, 'a.txt');
    const realTarget = path.join(realRoot, 'a.txt');
    const outcome = resolveBrowserUploadPath(
      { requestedPath: target, allowedRoots: [linkedRoot] },
      fakeProbe({ links: { [target]: realTarget, [linkedRoot]: realRoot }, files: { [realTarget]: 5 } })
    );
    expect(outcome).toMatchObject({ ok: true, path: realTarget, root: realRoot });
  });

  it('rejects a path that does not exist', () => {
    const outcome = resolveBrowserUploadPath(
      { requestedPath: path.join(WORKSPACE, 'ghost.txt'), allowedRoots: [WORKSPACE] },
      fakeProbe()
    );
    expect(outcome).toMatchObject({ ok: false, code: 'INVALID_PATH' });
  });

  it('rejects a directory, since only regular files can be uploaded', () => {
    const dir = path.join(WORKSPACE, 'assets');
    const outcome = resolveBrowserUploadPath(
      { requestedPath: dir, allowedRoots: [WORKSPACE] },
      fakeProbe({ directories: [dir] })
    );
    expect(outcome).toMatchObject({ ok: false, code: 'NOT_A_FILE' });
  });

  it('rejects a file over the size limit', () => {
    const target = path.join(WORKSPACE, 'huge.bin');
    const outcome = resolveBrowserUploadPath(
      { requestedPath: target, allowedRoots: [WORKSPACE], maxBytes: 1024 },
      fakeProbe({ files: { [target]: 1025 } })
    );
    expect(outcome).toMatchObject({ ok: false, code: 'TOO_LARGE' });
  });

  it('accepts a file exactly at the size limit', () => {
    const target = path.join(WORKSPACE, 'exact.bin');
    const outcome = resolveBrowserUploadPath(
      { requestedPath: target, allowedRoots: [WORKSPACE], maxBytes: 1024 },
      fakeProbe({ files: { [target]: 1024 } })
    );
    expect(outcome).toMatchObject({ ok: true, size: 1024 });
  });

  it('searches every allowed root, not just the first', () => {
    const attachments = abs('attachments');
    const target = path.join(attachments, 'a.png');
    const outcome = resolveBrowserUploadPath(
      { requestedPath: target, allowedRoots: [WORKSPACE, attachments] },
      fakeProbe({ directories: [attachments], files: { [target]: 7 } })
    );
    expect(outcome).toMatchObject({ ok: true, root: attachments });
  });
});

describe('resolveBrowserUploadPaths', () => {
  it('resolves a whole batch', () => {
    const a = path.join(WORKSPACE, 'a.txt');
    const b = path.join(WORKSPACE, 'b.txt');
    const outcome = resolveBrowserUploadPaths(
      { requestedPaths: [a, b], allowedRoots: [WORKSPACE] },
      fakeProbe({ files: { [a]: 1, [b]: 2 } })
    );
    expect(outcome).toEqual({ ok: true, paths: [a, b] });
  });

  it('rejects the whole batch when one entry escapes, rather than uploading the rest', () => {
    // Partial success would hand the page a different set of files from the one the agent
    // believes it sent, with no indication to the user.
    const good = path.join(WORKSPACE, 'a.txt');
    const bad = path.join(OUTSIDE, 'id_rsa');
    const outcome = resolveBrowserUploadPaths(
      { requestedPaths: [good, bad], allowedRoots: [WORKSPACE] },
      fakeProbe({ files: { [good]: 1, [bad]: 2 } })
    );
    expect(outcome).toMatchObject({ ok: false, code: 'OUTSIDE_WORKSPACE' });
  });

  it('resolves an empty batch to an empty list', () => {
    expect(resolveBrowserUploadPaths({ requestedPaths: [], allowedRoots: [WORKSPACE] }, fakeProbe())).toEqual({
      ok: true,
      paths: [],
    });
  });
});
