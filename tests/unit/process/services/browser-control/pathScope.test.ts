/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Containment is the primitive both the upload allowlist and "reveal this download" rest on, so
 * the cases that matter are the ones where a string comparison would have said yes: a sibling
 * directory sharing a prefix, and `..` climbing back out after a plausible-looking descent.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { findContainingRoot, isPathInsideRoot } from '@process/services/browser-control/policies/pathScope';

const abs = (...parts: string[]): string => path.resolve(path.sep, ...parts);

describe('isPathInsideRoot', () => {
  it('accepts a file directly inside the root', () => {
    expect(isPathInsideRoot(abs('work'), abs('work', 'notes.txt'))).toBe(true);
  });

  it('accepts a file nested several levels down', () => {
    expect(isPathInsideRoot(abs('work'), abs('work', 'a', 'b', 'c.txt'))).toBe(true);
  });

  it('rejects the root itself, which is a directory and not an uploadable file', () => {
    expect(isPathInsideRoot(abs('work'), abs('work'))).toBe(false);
  });

  it('rejects a sibling directory that merely shares the root as a string prefix', () => {
    // `startsWith(root)` would accept this, which is the whole reason the check uses path.relative.
    expect(isPathInsideRoot(abs('work'), abs('work-evil', 'secrets.txt'))).toBe(false);
  });

  it('rejects a path that climbs back out with ..', () => {
    expect(isPathInsideRoot(abs('work'), abs('work', '..', 'etc', 'passwd'))).toBe(false);
  });

  it('rejects a path that climbs out and back in under a different root', () => {
    expect(isPathInsideRoot(abs('work'), abs('work', 'sub', '..', '..', 'other', 'f.txt'))).toBe(false);
  });

  it('rejects empty inputs rather than treating them as the filesystem root', () => {
    expect(isPathInsideRoot('', abs('work', 'a.txt'))).toBe(false);
    expect(isPathInsideRoot(abs('work'), '')).toBe(false);
  });
});

describe('findContainingRoot', () => {
  it('returns the root that contains the candidate', () => {
    const roots = [abs('work'), abs('attachments')];
    expect(findContainingRoot(roots, abs('attachments', 'a.png'))).toBe(abs('attachments'));
  });

  it('returns null when no root contains it', () => {
    expect(findContainingRoot([abs('work')], abs('elsewhere', 'a.png'))).toBeNull();
  });

  it('returns null for an empty root list, so an unconfigured allowlist allows nothing', () => {
    expect(findContainingRoot([], abs('work', 'a.png'))).toBeNull();
  });
});
