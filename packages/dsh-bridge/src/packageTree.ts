import { lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { DshApiError } from './apiError';

/** Shared by skill and expert packages: lowercase kebab-case, no path separators. */
export const PACKAGE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const PACKAGE_MAX_FILE_BYTES = 1024 * 1024;
export const PACKAGE_MAX_TOTAL_BYTES = 10 * 1024 * 1024;

export type PackageTreeLimits = {
  maxFileBytes: number;
  maxTotalBytes: number;
  invalidCode: string;
  limitCode: string;
};

/**
 * Validates a package tree before it is copied into a managed root.
 *
 * Rejecting symbolic links is a security control, not a convenience check: a link
 * inside an imported package would let the copy escape the managed root.
 */
export async function validatePackageTree(path: string, limits: PackageTreeLimits): Promise<number> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new DshApiError(400, limits.invalidCode, 'Symbolic links are not supported.');
  if (info.isFile()) {
    if (info.size > limits.maxFileBytes) {
      throw new DshApiError(400, limits.limitCode, 'A package file exceeds the size limit.');
    }
    return info.size;
  }
  if (!info.isDirectory()) throw new DshApiError(400, limits.invalidCode, 'The source is not a file or directory.');
  let total = 0;
  for (const entry of await readdir(path)) {
    // Packages are intentionally validated recursively before copying.
    // eslint-disable-next-line no-await-in-loop
    total += await validatePackageTree(join(path, entry), limits);
    if (total > limits.maxTotalBytes) {
      throw new DshApiError(400, limits.limitCode, 'The package exceeds the size limit.');
    }
  }
  return total;
}

/**
 * Asserts that `canonicalTarget` lives inside `canonicalRoot`. Both must already be
 * resolved with `realpath` by the caller, so this stays a pure path-relation check.
 *
 * `allowRoot` distinguishes "read something under the root" (the root itself is a
 * harmless no-op) from "delete something under the root" (deleting the root is not).
 */
export function assertContained(
  canonicalRoot: string,
  canonicalTarget: string,
  code: string,
  options?: { allowRoot?: boolean }
): void {
  const pathFromRoot = relative(canonicalRoot, canonicalTarget);
  const escapes = pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot);
  const isRoot = !pathFromRoot;
  if (escapes || (isRoot && options?.allowRoot === false)) {
    throw new DshApiError(403, code, 'The path is outside its managed root.');
  }
}

/**
 * Splits `---\n<yaml>\n---\n<body>` into parsed frontmatter and the remaining body.
 *
 * Skills discard the body; experts keep it as persona prose. That difference is why
 * the shared seam is here rather than at the document level.
 */
export function parseFrontmatter(
  content: string,
  invalidCode: string
): { data: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new DshApiError(400, invalidCode, 'The document requires YAML frontmatter.');
  const metadata = parseYaml(match[1]) as unknown;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new DshApiError(400, invalidCode, 'Frontmatter must be an object.');
  }
  return { data: metadata as Record<string, unknown>, body: content.slice(match[0].length) };
}
