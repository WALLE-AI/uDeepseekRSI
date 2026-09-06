import { randomUUID } from 'node:crypto';
import { realpath, readdir, readlink, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

export type WorkspaceBinding = {
  conversationId: string;
  projectId: string;
  workspacePeId: string;
  canonicalPath: string;
  displayPath: string;
  revision: number;
};

export type StoredProjectEntry = {
  peId: string;
  role: 'workspace' | 'attached';
  canonicalPath: string;
  displayPath: string;
  displayName?: string;
  orderIndex: number;
};

export type StoredProject = {
  id: string;
  name: string;
  workspacePeId: string;
  entries: StoredProjectEntry[];
};

export type ProjectFileRef = { pe_id: string; relative_path: string };

const comparePath = (path: string): string =>
  process.platform === 'win32' ? path.replaceAll('/', '\\').toLocaleLowerCase('en-US') : path;

export async function canonicalizeWorkspace(path: string): Promise<string> {
  if (!path.trim() || !isAbsolute(path)) throw new Error('WORKSPACE_PATH_UNAVAILABLE');
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory()) throw new Error('WORKSPACE_PATH_UNAVAILABLE');
  return canonical;
}

export function sameCanonicalPath(left: string, right: string): boolean {
  return comparePath(resolve(left)) === comparePath(resolve(right));
}

export function ensureWorkspaceProject(projects: StoredProject[], canonicalPath: string): StoredProject {
  const existing = projects.find((project) => {
    const root = project.entries.find((entry) => entry.peId === project.workspacePeId);
    return Boolean(root && sameCanonicalPath(root.canonicalPath, canonicalPath));
  });
  if (existing) return existing;

  const projectId = randomUUID();
  const peId = randomUUID();
  const project: StoredProject = {
    id: projectId,
    name: basename(canonicalPath) || canonicalPath,
    workspacePeId: peId,
    entries: [
      {
        peId,
        role: 'workspace',
        canonicalPath,
        displayPath: canonicalPath,
        orderIndex: 0,
      },
    ],
  };
  projects.push(project);
  return project;
}

export function projectDto(project: StoredProject): Record<string, unknown> {
  return {
    project_id: project.id,
    name: project.name,
    explorer: {
      workspace_pe_id: project.workspacePeId,
      entries: project.entries.map((entry) => ({
        pe_id: entry.peId,
        role: entry.role,
        display_name: entry.displayName ?? null,
        display_path: entry.displayPath,
        order_index: entry.orderIndex,
        runtime_status: 'available',
      })),
    },
  };
}

export function findProjectEntry(projects: StoredProject[], peId: string): StoredProjectEntry | undefined {
  return projects.flatMap((project) => project.entries).find((entry) => entry.peId === peId);
}

function relativeSegments(relativePath: string): string[] {
  if (relativePath === '') return [];
  if (relativePath.includes('\\') || relativePath.includes('\0') || isAbsolute(relativePath)) {
    throw new Error('PROJECT_PATH_OUTSIDE_ROOT');
  }
  const segments = relativePath.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('PROJECT_PATH_OUTSIDE_ROOT');
  }
  return segments;
}

function assertContained(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === '') return;
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('PROJECT_PATH_OUTSIDE_ROOT');
}

export async function resolveProjectPath(
  projects: StoredProject[],
  ref: ProjectFileRef,
  options: { allowMissingLeaf?: boolean } = {}
): Promise<string> {
  const entry = findProjectEntry(projects, ref.pe_id);
  if (!entry) throw new Error('PROJECT_ENTRY_NOT_FOUND');
  const segments = relativeSegments(ref.relative_path);
  const candidate = resolve(entry.canonicalPath, ...segments);
  assertContained(entry.canonicalPath, candidate);

  if (options.allowMissingLeaf && segments.length > 0) {
    const parent = await realpath(resolve(candidate, '..'));
    assertContained(entry.canonicalPath, parent);
    return resolve(parent, segments.at(-1)!);
  }

  const canonical = await realpath(candidate);
  assertContained(entry.canonicalPath, canonical);
  return canonical;
}

export async function listProjectDirectory(
  projects: StoredProject[],
  target: ProjectFileRef
): Promise<Array<{ name: string; kind: 'file' | 'dir' | 'symlink'; symlink_target?: string }>> {
  const directory = await resolveProjectPath(projects, target);
  if (!(await stat(directory)).isDirectory()) throw new Error('PROJECT_NOT_DIRECTORY');
  const entries = await readdir(directory, { withFileTypes: true });
  const mapped = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isSymbolicLink()) {
        return {
          name: entry.name,
          kind: 'symlink' as const,
          symlink_target: await readlink(resolve(directory, entry.name)),
        };
      }
      return { name: entry.name, kind: entry.isDirectory() ? ('dir' as const) : ('file' as const) };
    })
  );
  return mapped.toSorted((left, right) => {
    const leftDir = left.kind === 'dir' ? 0 : 1;
    const rightDir = right.kind === 'dir' ? 0 : 1;
    return leftDir - rightDir || left.name.localeCompare(right.name);
  });
}
