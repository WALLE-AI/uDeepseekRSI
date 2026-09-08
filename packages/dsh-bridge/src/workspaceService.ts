import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import { access, readFile, realpath, readdir, readlink, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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

export type WorkspacePreviewSession = {
  session_id: string;
  url: string;
};

export type WorkspacePreviewInspection =
  | { kind: 'static' }
  | { kind: 'vite'; command: string; confirmation_token: string };

export type WorkspacePreviewResource = {
  body: Buffer;
  headers: Record<string, string>;
};

type ActiveWorkspacePreview = {
  id: string;
  token: string;
  rootPath: string;
  entryPath: string;
  watcher?: FSWatcher;
  child?: ChildProcess;
  timer?: NodeJS.Timeout;
  changedPaths: Set<string>;
};

type ViteConfirmation = { rootPath: string; expiresAt: number };

type ViteProject = { manager: 'bun' | 'npm' | 'pnpm' | 'yarn'; command: string };

const PREVIEW_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.cjs',
  '.css',
  '.eot',
  '.gif',
  '.htm',
  '.html',
  '.ico',
  '.jpeg',
  '.jpg',
  '.js',
  '.json',
  '.map',
  '.mjs',
  '.mov',
  '.mp3',
  '.mp4',
  '.ogg',
  '.otf',
  '.png',
  '.svg',
  '.ttf',
  '.txt',
  '.wasm',
  '.wav',
  '.webm',
  '.webmanifest',
  '.webp',
  '.woff',
  '.woff2',
  '.xml',
]);

const PREVIEW_MIME_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.eot': 'application/vnd.ms-fontobject',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
};

export class WorkspacePreviewError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code);
    this.name = 'WorkspacePreviewError';
  }
}

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

function previewRelativeSegments(value: string): string[] {
  if (!value) return [];
  let decoded: string[];
  try {
    decoded = value.split('/').map((segment) => decodeURIComponent(segment));
  } catch {
    throw new WorkspacePreviewError('WORKSPACE_PREVIEW_PATH_INVALID', 400);
  }
  if (
    decoded.some(
      (segment) => !segment || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0')
    )
  ) {
    throw new WorkspacePreviewError('WORKSPACE_PREVIEW_PATH_INVALID', 400);
  }
  return decoded;
}

function isSensitivePreviewPath(segments: string[]): boolean {
  return segments.some((segment) => {
    const lower = segment.toLocaleLowerCase('en-US');
    return (
      lower.startsWith('.') ||
      lower === 'id_rsa' ||
      lower === 'id_ed25519' ||
      ['.key', '.p12', '.pem', '.pfx'].includes(extname(lower))
    );
  });
}

function previewContentType(path: string): string {
  return PREVIEW_MIME_TYPES[extname(path).toLocaleLowerCase('en-US')] ?? 'application/octet-stream';
}

function previewRootRef(entry: ProjectFileRef): ProjectFileRef {
  const slash = entry.relative_path.lastIndexOf('/');
  return { pe_id: entry.pe_id, relative_path: slash < 0 ? '' : entry.relative_path.slice(0, slash) };
}

async function reservePreviewPort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('WORKSPACE_PREVIEW_PORT_FAILED'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function detectViteProject(rootPath: string): Promise<ViteProject | null> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(join(rootPath, 'package.json'), 'utf8')) as unknown;
  } catch {
    return null;
  }
  if (!manifest || typeof manifest !== 'object') return null;
  const packageJson = manifest as Record<string, unknown>;
  const scripts = packageJson.scripts;
  const dependencies = packageJson.dependencies;
  const devDependencies = packageJson.devDependencies;
  const devScript = scripts && typeof scripts === 'object' ? (scripts as Record<string, unknown>).dev : undefined;
  const hasViteDependency = [dependencies, devDependencies].some(
    (group) => group && typeof group === 'object' && typeof (group as Record<string, unknown>).vite === 'string'
  );
  if (typeof devScript !== 'string' || !hasViteDependency) return null;
  if (!(await pathExists(join(rootPath, 'node_modules', 'vite')))) {
    throw new WorkspacePreviewError('WORKSPACE_PREVIEW_DEPENDENCIES_MISSING', 409);
  }

  const manager =
    (await pathExists(join(rootPath, 'bun.lockb'))) || (await pathExists(join(rootPath, 'bun.lock')))
      ? 'bun'
      : (await pathExists(join(rootPath, 'pnpm-lock.yaml')))
        ? 'pnpm'
        : (await pathExists(join(rootPath, 'yarn.lock')))
          ? 'yarn'
          : 'npm';
  return { manager, command: `${manager} run dev -- --host 127.0.0.1 --port <port> --strictPort` };
}

function viteSpawnPlan(manager: ViteProject['manager'], port: number): { command: string; args: string[] } {
  const args = ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'];
  if (process.platform !== 'win32') return { command: manager, args };
  const line = `${manager} run dev -- --host 127.0.0.1 --port ${port} --strictPort`;
  return { command: 'cmd.exe', args: ['/d', '/s', '/c', line] };
}

function stopPreviewChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

/** Serves project-scoped front-end files without exposing absolute paths to the renderer. */
export class WorkspacePreviewService {
  readonly #sessions = new Map<string, ActiveWorkspacePreview>();
  readonly #tokens = new Map<string, ActiveWorkspacePreview>();
  readonly #viteConfirmations = new Map<string, ViteConfirmation>();
  readonly #onChanged: (event: { session_id: string; changed_paths: string[] }) => void;

  constructor(onChanged: (event: { session_id: string; changed_paths: string[] }) => void) {
    this.#onChanged = onChanged;
  }

  async inspect(projects: StoredProject[], root: ProjectFileRef): Promise<WorkspacePreviewInspection> {
    for (const [token, confirmation] of this.#viteConfirmations) {
      if (confirmation.expiresAt < Date.now()) this.#viteConfirmations.delete(token);
    }
    let rootPath: string;
    try {
      rootPath = await resolveProjectPath(projects, root);
      if (!(await stat(rootPath)).isDirectory()) throw new Error('PROJECT_NOT_DIRECTORY');
    } catch {
      throw new WorkspacePreviewError('WORKSPACE_PREVIEW_NOT_FOUND', 404);
    }
    const vite = await detectViteProject(rootPath);
    if (!vite) return { kind: 'static' };
    const confirmationToken = randomUUID();
    this.#viteConfirmations.set(confirmationToken, { rootPath, expiresAt: Date.now() + 5 * 60_000 });
    return { kind: 'vite', command: vite.command, confirmation_token: confirmationToken };
  }

  async start(
    projects: StoredProject[],
    entry: ProjectFileRef,
    root: ProjectFileRef | undefined,
    origin: string,
    options: { mode?: 'static' | 'vite'; confirmationToken?: string } = {}
  ): Promise<WorkspacePreviewSession> {
    if (extname(entry.relative_path).toLocaleLowerCase('en-US') !== '.html') {
      throw new WorkspacePreviewError('WORKSPACE_PREVIEW_ENTRY_INVALID', 400);
    }
    const rootRef = root ?? previewRootRef(entry);
    if (rootRef.pe_id !== entry.pe_id) throw new WorkspacePreviewError('WORKSPACE_PREVIEW_ROOT_INVALID', 400);

    let rootPath: string;
    let entryPath: string;
    try {
      [rootPath, entryPath] = await Promise.all([
        resolveProjectPath(projects, rootRef),
        resolveProjectPath(projects, entry),
      ]);
      assertContained(rootPath, entryPath);
      if (!(await stat(rootPath)).isDirectory() || !(await stat(entryPath)).isFile()) {
        throw new WorkspacePreviewError('WORKSPACE_PREVIEW_ENTRY_INVALID', 400);
      }
    } catch (error) {
      if (error instanceof WorkspacePreviewError) throw error;
      throw new WorkspacePreviewError('WORKSPACE_PREVIEW_NOT_FOUND', 404);
    }

    if (options.mode === 'vite') {
      const confirmation = options.confirmationToken
        ? this.#viteConfirmations.get(options.confirmationToken)
        : undefined;
      if (
        !confirmation ||
        confirmation.expiresAt < Date.now() ||
        comparePath(confirmation.rootPath) !== comparePath(rootPath)
      ) {
        throw new WorkspacePreviewError('WORKSPACE_PREVIEW_CONFIRMATION_REQUIRED', 403);
      }
      this.#viteConfirmations.delete(options.confirmationToken!);
      return await this.#startVite(rootPath, entryPath);
    }

    const id = randomUUID();
    const token = randomUUID();
    const changedPaths = new Set<string>();
    let session: ActiveWorkspacePreview;
    try {
      const watcher = watch(rootPath, { recursive: true }, (_eventType, filename) => {
        const relativePath = filename?.toString().replaceAll('\\', '/') ?? '';
        if (relativePath) changedPaths.add(relativePath);
        if (session.timer) clearTimeout(session.timer);
        session.timer = setTimeout(() => {
          session.timer = undefined;
          const paths = [...changedPaths];
          changedPaths.clear();
          this.#onChanged({ session_id: id, changed_paths: paths });
        }, 250);
      });
      session = { id, token, rootPath, entryPath, watcher, changedPaths };
      watcher.once('error', () => this.stop(id));
    } catch {
      throw new WorkspacePreviewError('WORKSPACE_PREVIEW_WATCH_FAILED', 500);
    }

    this.#sessions.set(id, session);
    this.#tokens.set(token, session);
    const entryRelative = relative(rootPath, entryPath)
      .split(sep)
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    return {
      session_id: id,
      url: `${origin}/api/workspace-preview/content/${encodeURIComponent(token)}/${entryRelative}`,
    };
  }

  stop(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    if (session.timer) clearTimeout(session.timer);
    session.watcher?.close();
    if (session.child) stopPreviewChild(session.child);
    this.#sessions.delete(session.id);
    this.#tokens.delete(session.token);
  }

  dispose(): void {
    for (const sessionId of this.#sessions.keys()) this.stop(sessionId);
    this.#viteConfirmations.clear();
  }

  async #startVite(rootPath: string, entryPath: string): Promise<WorkspacePreviewSession> {
    const vite = await detectViteProject(rootPath);
    if (!vite) throw new WorkspacePreviewError('WORKSPACE_PREVIEW_VITE_UNSUPPORTED', 400);
    const port = await reservePreviewPort();
    const url = `http://127.0.0.1:${port}`;
    const plan = viteSpawnPlan(vite.manager, port);
    const child = spawn(plan.command, plan.args, {
      cwd: rootPath,
      detached: process.platform !== 'win32',
      env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const id = randomUUID();
    child.stdout?.resume();
    child.stderr?.resume();
    const session: ActiveWorkspacePreview = {
      id,
      token: '',
      rootPath,
      entryPath,
      child,
      changedPaths: new Set(),
    };
    let spawnFailed = false;
    this.#sessions.set(id, session);
    child.once('exit', () => {
      if (this.#sessions.get(id)?.child === child) this.#sessions.delete(id);
    });
    child.once('error', () => {
      spawnFailed = true;
      if (this.#sessions.get(id)?.child === child) this.#sessions.delete(id);
    });

    const startedAt = Date.now();
    while (Date.now() - startedAt < 20_000) {
      if (spawnFailed || child.exitCode !== null) {
        this.#sessions.delete(id);
        throw new WorkspacePreviewError('WORKSPACE_PREVIEW_VITE_START_FAILED', 500);
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
        if (response.status < 500) return { session_id: id, url };
      } catch {
        // Vite may bind the port before its first transform is ready.
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolveReady) => setTimeout(resolveReady, 200));
    }
    this.#sessions.delete(id);
    stopPreviewChild(child);
    throw new WorkspacePreviewError('WORKSPACE_PREVIEW_VITE_START_TIMEOUT', 504);
  }

  async read(token: string, requestPath: string, accept: string | undefined): Promise<WorkspacePreviewResource> {
    const session = this.#tokens.get(token);
    if (!session) throw new WorkspacePreviewError('WORKSPACE_PREVIEW_NOT_FOUND', 404);
    const segments = previewRelativeSegments(requestPath);
    if (isSensitivePreviewPath(segments)) throw new WorkspacePreviewError('WORKSPACE_PREVIEW_FORBIDDEN', 403);

    let path = resolve(session.rootPath, ...segments);
    try {
      path = await realpath(path);
      try {
        assertContained(session.rootPath, path);
      } catch {
        throw new WorkspacePreviewError('WORKSPACE_PREVIEW_FORBIDDEN', 403);
      }
      if (!(await stat(path)).isFile()) throw new WorkspacePreviewError('WORKSPACE_PREVIEW_NOT_FOUND', 404);
    } catch (error) {
      if (error instanceof WorkspacePreviewError) throw error;
      const canFallback = Boolean(accept?.includes('text/html')) && extname(segments.at(-1) ?? '') === '';
      if (!canFallback) throw new WorkspacePreviewError('WORKSPACE_PREVIEW_NOT_FOUND', 404);
      path = session.entryPath;
    }

    const extension = extname(path).toLocaleLowerCase('en-US');
    if (!PREVIEW_EXTENSIONS.has(extension)) throw new WorkspacePreviewError('WORKSPACE_PREVIEW_FORBIDDEN', 403);
    return {
      body: await readFile(path),
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': previewContentType(path),
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    };
  }
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
