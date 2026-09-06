import { constants } from 'node:fs';
import { copyFile, cp, mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { listProjectDirectory, resolveProjectPath, type ProjectFileRef, type StoredProject } from './workspaceService';

type FsParams = Record<string, unknown>;

function fileRef(value: unknown): ProjectFileRef {
  if (!value || typeof value !== 'object') throw new Error('PROJECT_REF_INVALID');
  const ref = value as Record<string, unknown>;
  if (typeof ref.pe_id !== 'string' || typeof ref.relative_path !== 'string') throw new Error('PROJECT_REF_INVALID');
  return { pe_id: ref.pe_id, relative_path: ref.relative_path };
}

export async function projectSnapshots(projects: StoredProject[], targets: unknown): Promise<unknown[]> {
  if (!Array.isArray(targets)) throw new Error('PROJECT_REF_INVALID');
  return await Promise.all(
    targets.map(async (target) => {
      const ref = fileRef(target);
      return { target: ref, entries: await listProjectDirectory(projects, ref) };
    })
  );
}

async function createFile(projects: StoredProject[], ref: ProjectFileRef): Promise<void> {
  const path = await resolveProjectPath(projects, ref, { allowMissingLeaf: true });
  const handle = await open(path, 'wx');
  await handle.close();
}

async function copyOrMove(
  projects: StoredProject[],
  from: ProjectFileRef,
  toDirectory: ProjectFileRef,
  move: boolean
): Promise<{ to: ProjectFileRef }> {
  const source = await resolveProjectPath(projects, from);
  await resolveProjectPath(projects, toDirectory);
  const relativePath = toDirectory.relative_path
    ? `${toDirectory.relative_path}/${basename(source)}`
    : basename(source);
  const destinationRef = { pe_id: toDirectory.pe_id, relative_path: relativePath };
  const destination = await resolveProjectPath(projects, destinationRef, { allowMissingLeaf: true });
  if (move) await rename(source, destination);
  else await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
  return { to: destinationRef };
}

type SearchMatch = { pe_id: string; relative_path: string; name: string; kind: 'file' | 'dir' | 'symlink' };

async function searchRoot(
  projects: StoredProject[],
  root: ProjectFileRef,
  query: string,
  limit: number
): Promise<SearchMatch[]> {
  const matches: SearchMatch[] = [];
  const pending: ProjectFileRef[] = [root];
  while (pending.length > 0 && matches.length < limit) {
    const directory = pending.shift()!;
    // Breadth-first traversal is intentionally ordered and bounded by the result limit.
    // eslint-disable-next-line no-await-in-loop
    const entries = await listProjectDirectory(projects, directory);
    for (const entry of entries) {
      const relativePath = directory.relative_path ? `${directory.relative_path}/${entry.name}` : entry.name;
      if (entry.name.toLocaleLowerCase().includes(query)) {
        matches.push({ pe_id: directory.pe_id, relative_path: relativePath, name: entry.name, kind: entry.kind });
        if (matches.length >= limit) break;
      }
      if (entry.kind === 'dir') pending.push({ pe_id: directory.pe_id, relative_path: relativePath });
    }
  }
  return matches;
}

export async function executeProjectFsRequest(
  projects: StoredProject[],
  method: string,
  params: FsParams
): Promise<unknown> {
  switch (method) {
    case 'fs/subscribe':
    case 'fs/remount':
      return { snapshots: await projectSnapshots(projects, params.targets) };
    case 'fs/unsubscribe':
    case 'fs/searchCancel':
      return null;
    case 'fs/mkdir': {
      const ref = fileRef(params.dir);
      await mkdir(await resolveProjectPath(projects, ref, { allowMissingLeaf: true }));
      return null;
    }
    case 'fs/createFile': {
      await createFile(projects, fileRef(params.file));
      return null;
    }
    case 'fs/remove': {
      const ref = fileRef(params.target);
      if (ref.relative_path === '') throw new Error('PROJECT_ROOT_IMMUTABLE');
      await rm(await resolveProjectPath(projects, ref), { recursive: true });
      return null;
    }
    case 'fs/rename': {
      const from = fileRef(params.from);
      const to = fileRef(params.to);
      if (from.pe_id !== to.pe_id || from.relative_path === '' || to.relative_path === '') {
        throw new Error('PROJECT_RENAME_INVALID');
      }
      await rename(
        await resolveProjectPath(projects, from),
        await resolveProjectPath(projects, to, { allowMissingLeaf: true })
      );
      return { to };
    }
    case 'fs/copy':
      return await copyOrMove(projects, fileRef(params.from), fileRef(params.to_dir), false);
    case 'fs/move':
      return await copyOrMove(projects, fileRef(params.from), fileRef(params.to_dir), true);
    case 'fs/search': {
      const roots = Array.isArray(params.roots) ? params.roots.map(fileRef) : [];
      const query = typeof params.query === 'string' ? params.query.trim().toLocaleLowerCase() : '';
      const limit = typeof params.limit === 'number' ? Math.max(1, Math.min(params.limit, 1_000)) : 200;
      const matches = (await Promise.all(roots.map((root) => searchRoot(projects, root, query, limit))))
        .flat()
        .slice(0, limit);
      return { matches, total: matches.length, truncated: matches.length >= limit };
    }
    default:
      throw new Error(`PROJECT_FS_METHOD_UNSUPPORTED:${method}`);
  }
}

export async function copyExternalFiles(
  projects: StoredProject[],
  filePaths: string[],
  target: ProjectFileRef
): Promise<{ copied_files: string[]; failed_files: Array<{ path: string; reason: string }> }> {
  const targetDirectory = await resolveProjectPath(projects, target);
  const copied_files: string[] = [];
  const failed_files: Array<{ path: string; reason: string }> = [];
  await Promise.all(
    filePaths.map(async (source) => {
      try {
        const destination = join(targetDirectory, basename(source));
        await copyFile(source, destination, constants.COPYFILE_EXCL);
        copied_files.push(destination);
      } catch (error) {
        failed_files.push({ path: source, reason: error instanceof Error ? error.message : String(error) });
      }
    })
  );
  return { copied_files, failed_files };
}
