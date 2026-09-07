import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { createDshConnection } from './createDshConnection';
import { DshBridge } from './DshBridge';
import { copyExternalFiles, executeProjectFsRequest, projectSnapshots } from './projectFsService';
import {
  OfficePreviewError,
  OfficePreviewService,
  type OfficeDocumentType,
  type OfficePreviewPort,
} from './officePreviewService';
import type {
  BridgePermissionDecision,
  BridgePermissionRequest,
  BridgeUpdate,
  DesktopShellPort,
  DshAgentPort,
  DshMcpServer,
  DshSessionConfigOption,
} from './types';
import {
  canonicalizeWorkspace,
  ensureWorkspaceProject,
  projectDto,
  resolveProjectPath,
  sameCanonicalPath,
  type StoredProject,
  type WorkspaceBinding,
} from './workspaceService';

type RuntimeSummary = {
  state: 'idle' | 'starting' | 'running' | 'cancelling' | 'waiting_confirmation';
  can_send_message: boolean;
  has_task: boolean;
  task_status: 'pending' | 'running' | 'finished';
  is_processing: boolean;
  pending_confirmations: number;
  turn_id: string | null;
  supports_midturn_delivery: boolean;
};

type StoredConversation = {
  id: string;
  name: string;
  type: 'acp';
  status: 'pending' | 'running' | 'finished';
  source: 'aionui';
  pinned: boolean;
  assistant: { id: string; source: 'dsh'; name: string; avatar: string; backend: 'acp' };
  created_at: number;
  modified_at: number;
  extra: Record<string, unknown> & { workspace: string; backend: 'acp'; current_model_id: string };
  runtime: RuntimeSummary;
  prompt_capability?: { image: boolean; audio: boolean };
  session_id?: string;
  project_id?: string;
};

type StoredMessage = {
  id: string;
  conversation_id: string;
  msg_id: string;
  type: 'text' | 'thinking' | 'tool_call' | 'tips';
  content: unknown;
  position: 'left' | 'right' | 'center';
  status: 'finish' | 'pending' | 'error' | 'work';
  hidden: boolean;
  created_at: number;
  backend_turn_id?: string;
};

type PersistedState = {
  conversations: StoredConversation[];
  messages: Record<string, StoredMessage[]>;
  clientSettings: Record<string, unknown>;
  projects: StoredProject[];
  workspaceBindings: WorkspaceBinding[];
};

type ActiveTurn = { turnId: string; messageId: string; text: string; startedAt: number };
type PendingPermission = {
  request: BridgePermissionRequest;
  messageId: string;
  resolve: (decision: BridgePermissionDecision) => void;
};

export type DshApiServerOptions = {
  host?: string;
  port?: number;
  cwd: string;
  dshHome: string;
  dataFile: string;
  patchPaths?: string[];
  env?: NodeJS.ProcessEnv;
  mcpServers?: readonly DshMcpServer[];
  desktopShell?: DesktopShellPort;
  officePreviewPort?: OfficePreviewPort;
  agentPortFactory?: (handlers: {
    onUpdate: (update: BridgeUpdate) => void;
    onPermissionRequest: (request: BridgePermissionRequest) => Promise<BridgePermissionDecision>;
  }) => DshAgentPort;
};

const DSH_PROVIDER_ID = 'deepseek-official';
const DEFAULT_MODEL_ID = 'deepseek-v4-flash';
const ASSISTANT_ID = 'dsh:deepseek-harness';

type ModelCatalogEntry = { id: string; label: string };

function modelCatalogEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname
    .replace(/\/+$/, '')
    .replace(/\/(?:chat\/)?completions$/i, '')
    .replace(/\/+$/, '');
  if (!/\/v1\/models$/i.test(url.pathname)) {
    if (!/\/v1$/i.test(url.pathname)) url.pathname = `${url.pathname}/v1`;
    url.pathname = `${url.pathname}/models`;
  }
  return url.toString();
}

function toDshModelValue(modelId: string): string {
  return JSON.stringify([DSH_PROVIDER_ID, modelId]);
}

function toUiModelId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return DEFAULT_MODEL_ID;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && typeof parsed[1] === 'string' && parsed[1].trim()) return parsed[1].trim();
  } catch {
    // Already a plain model id.
  }
  return value.trim();
}

function idleRuntime(): RuntimeSummary {
  return {
    state: 'idle',
    can_send_message: true,
    has_task: false,
    task_status: 'finished',
    is_processing: false,
    pending_confirmations: 0,
    turn_id: null,
    supports_midturn_delivery: false,
  };
}

function runningRuntime(turnId: string): RuntimeSummary {
  return {
    state: 'running',
    can_send_message: false,
    has_task: true,
    task_status: 'running',
    is_processing: true,
    pending_confirmations: 0,
    turn_id: turnId,
    supports_midturn_delivery: false,
  };
}

function extractText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text;
  if (typeof record.content === 'string') return record.content;
  if (record.content && typeof record.content === 'object') return extractText(record.content);
  if (record.chunk && typeof record.chunk === 'object') return extractText(record.chunk);
  return '';
}

function responseData(response: ServerResponse, data: unknown, status = 200): void {
  response.writeHead(status, {
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json; charset=utf-8',
  });
  const payload =
    status < 400
      ? { success: true, data }
      : { success: false, ...(data && typeof data === 'object' ? data : { error: String(data) }) };
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function projectFileRef(value: unknown): { pe_id: string; relative_path: string } {
  if (!value || typeof value !== 'object') throw new Error('PROJECT_REF_INVALID');
  const ref = value as Record<string, unknown>;
  if (ref.kind !== undefined && ref.kind !== 'project') throw new Error('FILE_REF_KIND_UNSUPPORTED');
  if (typeof ref.pe_id !== 'string' || typeof ref.relative_path !== 'string') throw new Error('PROJECT_REF_INVALID');
  return { pe_id: ref.pe_id, relative_path: ref.relative_path };
}

function mimeType(path: string): string {
  const extension = extname(path).toLocaleLowerCase();
  return (
    (
      {
        '.gif': 'image/gif',
        '.jpeg': 'image/jpeg',
        '.jpg': 'image/jpeg',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.webp': 'image/webp',
        '.json': 'application/json',
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'text/javascript',
        '.ts': 'text/typescript',
        '.md': 'text/markdown',
      } as Record<string, string>
    )[extension] ?? 'application/octet-stream'
  );
}

export class DshApiServer {
  readonly #options: DshApiServerOptions;
  readonly #clients = new Set<WebSocket>();
  readonly #activeTurns = new Map<string, ActiveTurn>();
  readonly #pendingPermissions = new Map<string, PendingPermission>();
  readonly #fsWatchers = new Map<WebSocket, Map<string, FSWatcher>>();
  #state: PersistedState = {
    conversations: [],
    messages: {},
    clientSettings: {},
    projects: [],
    workspaceBindings: [],
  };
  #bridge: DshBridge | null = null;
  #server: Server | null = null;
  #wsServer: WebSocketServer | null = null;
  #persistQueue: Promise<void> = Promise.resolve();
  #port = 0;
  #models: ModelCatalogEntry[] = [{ id: DEFAULT_MODEL_ID, label: DEFAULT_MODEL_ID }];
  #officePreview: OfficePreviewPort;

  constructor(options: DshApiServerOptions) {
    this.#options = options;
    this.#officePreview =
      options.officePreviewPort ??
      new OfficePreviewService({
        env: options.env,
        emitStatus: (documentType, status) => this.#emit(`${documentType}-preview.status`, status),
      });
  }

  get port(): number {
    return this.#port;
  }

  async start(): Promise<number> {
    if (this.#server) return this.#port;
    await this.#load();
    await this.#alignStoredWorkspaces();
    await this.#loadModelCatalog();
    this.#normalizeStoredModels();
    const handlers = {
      onUpdate: (update: BridgeUpdate) => this.#handleUpdate(update),
      onPermissionRequest: (request: BridgePermissionRequest) => this.#requestPermission(request),
    };
    const connection = this.#options.agentPortFactory
      ? this.#options.agentPortFactory(handlers)
      : createDshConnection({
          cwd: this.#options.cwd,
          dshHome: this.#options.dshHome,
          patchPaths: this.#options.patchPaths,
          mcpServers: this.#options.mcpServers,
          env: {
            ...this.#options.env,
            AIONUI_DEEPSEEK_MODELS_JSON: JSON.stringify(this.#models.map((model) => model.id)),
          },
          ...handlers,
        });
    this.#bridge = new DshBridge({ port: connection });
    await this.#bridge.start();

    const server = createServer((request, response) => void this.#route(request, response));
    const wsServer = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      if (new URL(request.url ?? '/', 'http://localhost').pathname !== '/ws') {
        socket.destroy();
        return;
      }
      wsServer.handleUpgrade(request, socket, head, (client) => wsServer.emit('connection', client, request));
    });
    wsServer.on('connection', (client) => {
      this.#clients.add(client);
      this.#fsWatchers.set(client, new Map());
      client.on('message', (raw) => void this.#handleWsMessage(client, raw.toString()));
      client.on('close', () => {
        this.#clients.delete(client);
        this.#closeFsWatchers(client);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.#options.port ?? 0, this.#options.host ?? '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Direct dsh backend did not bind a TCP port.');
    this.#port = address.port;
    this.#server = server;
    this.#wsServer = wsServer;
    return this.#port;
  }

  async stop(): Promise<void> {
    for (const pending of this.#pendingPermissions.values()) pending.resolve({ cancelled: true });
    this.#pendingPermissions.clear();
    for (const client of this.#clients) client.close();
    for (const client of this.#fsWatchers.keys()) this.#closeFsWatchers(client);
    this.#clients.clear();
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()) ?? resolve());
    this.#wsServer?.close();
    this.#server = null;
    this.#wsServer = null;
    await this.#persistQueue.catch((): undefined => undefined);
    await this.#bridge?.dispose();
    this.#bridge = null;
    await this.#officePreview.dispose();
    this.#port = 0;
  }

  async #officeFilePath(body: Record<string, unknown>): Promise<string> {
    if (body.file) return await resolveProjectPath(this.#state.projects, projectFileRef(body.file));
    if (typeof body.file_path !== 'string' || !isAbsolute(body.file_path)) {
      throw new OfficePreviewError('OFFICECLI_START_FAILED', 'An absolute Office file path is required.');
    }
    try {
      const filePath = await realpath(body.file_path);
      const workspace = await canonicalizeWorkspace(
        typeof body.workspace === 'string' && body.workspace.trim() ? body.workspace : this.#options.cwd
      );
      const rel = relative(workspace, filePath);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('outside');
      if (!(await stat(filePath)).isFile()) throw new Error('not-file');
      return filePath;
    } catch (error) {
      if (error instanceof OfficePreviewError) throw error;
      throw new Error('PATH_OUTSIDE_SANDBOX', { cause: error });
    }
  }

  async #load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#options.dataFile, 'utf8')) as PersistedState;
      this.#state = {
        conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
        messages: parsed.messages && typeof parsed.messages === 'object' ? parsed.messages : {},
        clientSettings: parsed.clientSettings && typeof parsed.clientSettings === 'object' ? parsed.clientSettings : {},
        projects: Array.isArray(parsed.projects) ? parsed.projects : [],
        workspaceBindings: Array.isArray(parsed.workspaceBindings) ? parsed.workspaceBindings : [],
      };
      for (const conversation of this.#state.conversations) {
        conversation.runtime = idleRuntime();
        conversation.status = 'finished';
      }
    } catch {
      this.#state = { conversations: [], messages: {}, clientSettings: {}, projects: [], workspaceBindings: [] };
    }
  }

  async #alignStoredWorkspaces(): Promise<void> {
    let changed = false;
    for (const conversation of this.#state.conversations) {
      try {
        // Alignment mutates the shared project registry in conversation order.
        // eslint-disable-next-line no-await-in-loop
        const canonicalPath = await canonicalizeWorkspace(conversation.extra.workspace);
        const project = ensureWorkspaceProject(this.#state.projects, canonicalPath);
        const existing = this.#state.workspaceBindings.find((binding) => binding.conversationId === conversation.id);
        const revision = existing?.revision ?? 1;
        const binding: WorkspaceBinding = {
          conversationId: conversation.id,
          projectId: project.id,
          workspacePeId: project.workspacePeId,
          canonicalPath,
          displayPath: conversation.extra.workspace,
          revision,
        };
        if (
          !existing ||
          existing.projectId !== binding.projectId ||
          existing.workspacePeId !== binding.workspacePeId ||
          !sameCanonicalPath(existing.canonicalPath, binding.canonicalPath)
        ) {
          this.#state.workspaceBindings = this.#state.workspaceBindings.filter(
            (item) => item.conversationId !== conversation.id
          );
          this.#state.workspaceBindings.push(binding);
          changed = true;
        }
        if (conversation.project_id !== project.id || !sameCanonicalPath(conversation.extra.workspace, canonicalPath)) {
          conversation.project_id = project.id;
          conversation.extra.workspace = canonicalPath;
          changed = true;
        }
      } catch {
        // Keep the stored path so the runtime can return a precise unavailable error.
      }
    }
    if (changed) await this.#persist();
  }

  async #workspaceForConversation(conversation: StoredConversation): Promise<string> {
    const binding = this.#state.workspaceBindings.find((item) => item.conversationId === conversation.id);
    if (!binding || !conversation.project_id || binding.projectId !== conversation.project_id) {
      throw new Error('WORKSPACE_BINDING_MISMATCH');
    }
    const project = this.#state.projects.find((item) => item.id === binding.projectId);
    const root = project?.entries.find((entry) => entry.peId === project.workspacePeId);
    if (!project || !root || root.peId !== binding.workspacePeId) throw new Error('WORKSPACE_BINDING_MISMATCH');
    const canonicalPath = await canonicalizeWorkspace(binding.canonicalPath);
    if (
      !sameCanonicalPath(canonicalPath, root.canonicalPath) ||
      !sameCanonicalPath(canonicalPath, conversation.extra.workspace)
    ) {
      throw new Error('WORKSPACE_BINDING_MISMATCH');
    }
    return canonicalPath;
  }

  async #registeredPath(path: string): Promise<string> {
    if (!isAbsolute(path)) throw new Error('PROJECT_PATH_OUTSIDE_ROOT');
    const canonical = await realpath(path);
    const registered = this.#state.projects.some((project) =>
      project.entries.some((entry) => {
        const rel = relative(entry.canonicalPath, canonical);
        return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
      })
    );
    if (!registered) throw new Error('PROJECT_PATH_OUTSIDE_ROOT');
    return canonical;
  }

  async #loadModelCatalog(): Promise<void> {
    const env = this.#options.env ?? process.env;
    const baseUrl = env.DEEPSEEK_URL?.trim();
    if (!baseUrl) return;

    try {
      const headers: Record<string, string> = {};
      const apiKey = env.DEEPSEEK_API_KEY?.trim();
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const response = await fetch(modelCatalogEndpoint(baseUrl), {
        headers,
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as { data?: Array<{ id?: unknown }> };
      const ids = Array.isArray(payload.data)
        ? payload.data
            .map((model) => (typeof model?.id === 'string' ? model.id.trim() : ''))
            .filter((id, index, values) => Boolean(id) && values.indexOf(id) === index)
        : [];
      if (ids.length > 0) this.#models = ids.map((id) => ({ id, label: id }));
    } catch (error) {
      console.warn(
        `[dsh-bridge] Could not load /v1/models; using ${DEFAULT_MODEL_ID}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  #normalizeStoredModels(): void {
    for (const conversation of this.#state.conversations) {
      const currentModelId = toUiModelId(conversation.extra.current_model_id);
      conversation.extra.current_model_id = currentModelId;
      conversation.extra.cached_config_options = this.#uiConfigOptions(
        Array.isArray(conversation.extra.cached_config_options)
          ? (conversation.extra.cached_config_options as DshSessionConfigOption[])
          : [],
        currentModelId
      );
    }
  }

  #modelOptions(currentModelId?: string): ModelCatalogEntry[] {
    return !currentModelId || this.#models.some((model) => model.id === currentModelId)
      ? this.#models
      : [{ id: currentModelId, label: currentModelId }, ...this.#models];
  }

  #defaultModelId(): string {
    return this.#models[0]?.id ?? DEFAULT_MODEL_ID;
  }

  #uiConfigOptions(options: DshSessionConfigOption[], currentModelId: string): DshSessionConfigOption[] {
    const modelOption = options.find((option) => option.id === 'model' || option.category === 'model');
    const remaining = options.filter((option) => option !== modelOption);
    return [
      {
        ...modelOption,
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        option_type: 'select',
        currentValue: currentModelId,
        current_value: currentModelId,
        options: this.#modelOptions(currentModelId).map((model) => ({
          value: model.id,
          name: model.label,
          label: model.label,
        })),
      },
      ...remaining,
    ];
  }

  async #persist(): Promise<void> {
    const serialized = JSON.stringify(this.#state, null, 2);
    const persist = async (): Promise<void> => {
      await mkdir(dirname(this.#options.dataFile), { recursive: true });
      const temporary = `${this.#options.dataFile}.tmp`;
      await writeFile(temporary, serialized, 'utf8');
      await rename(temporary, this.#options.dataFile);
    };
    const pending = this.#persistQueue.catch((): undefined => undefined).then(persist);
    this.#persistQueue = pending;
    await pending;
  }

  #emit(name: string, data: unknown): void {
    const frame = JSON.stringify({ name, data });
    for (const client of this.#clients) {
      if (client.readyState === client.OPEN) client.send(frame);
    }
  }

  #sendFs(client: WebSocket, data: unknown): void {
    if (client.readyState === client.OPEN) client.send(JSON.stringify({ name: 'fs', data }));
  }

  #closeFsWatchers(client: WebSocket): void {
    for (const watcher of this.#fsWatchers.get(client)?.values() ?? []) watcher.close();
    this.#fsWatchers.delete(client);
  }

  async #setFsSubscriptions(client: WebSocket, targets: unknown, replace: boolean): Promise<void> {
    if (!Array.isArray(targets)) throw new Error('PROJECT_REF_INVALID');
    const watchers = this.#fsWatchers.get(client) ?? new Map<string, FSWatcher>();
    this.#fsWatchers.set(client, watchers);
    if (replace) {
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    }
    const resolvedTargets = await Promise.all(
      targets.map(async (rawTarget) => {
        if (!rawTarget || typeof rawTarget !== 'object') throw new Error('PROJECT_REF_INVALID');
        const value = rawTarget as Record<string, unknown>;
        if (typeof value.pe_id !== 'string' || typeof value.relative_path !== 'string') {
          throw new Error('PROJECT_REF_INVALID');
        }
        const target = { pe_id: value.pe_id, relative_path: value.relative_path };
        return { target, directory: await resolveProjectPath(this.#state.projects, target) };
      })
    );
    for (const { target, directory } of resolvedTargets) {
      const key = `${target.pe_id}\0${target.relative_path}`;
      if (watchers.has(key)) continue;
      let timer: NodeJS.Timeout | undefined;
      const watcher = watch(directory, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          void projectSnapshots(this.#state.projects, [target]).then(
            ([snapshot]) =>
              this.#sendFs(client, {
                jsonrpc: '2.0',
                method: 'fs/snapshot',
                params: { ...(snapshot as object), reason: 'overflow' },
              }),
            (): void => undefined
          );
        }, 75);
      });
      watcher.on('close', () => timer && clearTimeout(timer));
      watchers.set(key, watcher);
    }
  }

  async #handleWsMessage(client: WebSocket, raw: string): Promise<void> {
    let id: unknown;
    try {
      const outer = JSON.parse(raw) as { name?: unknown; data?: unknown };
      if (outer.name !== 'fs' || !outer.data || typeof outer.data !== 'object') return;
      const request = outer.data as { id?: unknown; method?: unknown; params?: unknown };
      id = request.id;
      if (typeof request.method !== 'string') throw new Error('PROJECT_FS_METHOD_INVALID');
      const params =
        request.params && typeof request.params === 'object' ? (request.params as Record<string, unknown>) : {};
      if (request.method === 'fs/subscribe' || request.method === 'fs/remount') {
        await this.#setFsSubscriptions(client, params.targets, request.method === 'fs/remount');
      } else if (request.method === 'fs/unsubscribe' && Array.isArray(params.targets)) {
        const watchers = this.#fsWatchers.get(client);
        for (const target of params.targets) {
          const ref = target as Record<string, unknown>;
          const key = `${String(ref.pe_id)}\0${String(ref.relative_path)}`;
          watchers?.get(key)?.close();
          watchers?.delete(key);
        }
      }
      const result = await executeProjectFsRequest(this.#state.projects, request.method, params);
      if (request.method === 'fs/search' && result && typeof result === 'object') {
        const search = result as { matches: unknown[]; total: number; truncated: boolean };
        this.#sendFs(client, {
          jsonrpc: '2.0',
          method: 'fs/searchMatch',
          params: { search_id: id, matches: search.matches },
        });
        this.#sendFs(client, {
          jsonrpc: '2.0',
          id,
          result: { limit_reached: search.truncated, total: search.total },
        });
        return;
      }
      if (id !== undefined) this.#sendFs(client, { jsonrpc: '2.0', id, result });
      await this.#persist();
    } catch (error) {
      if (id !== undefined) {
        this.#sendFs(client, {
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
        });
      }
    }
  }

  #handleUpdate(update: BridgeUpdate): void {
    const active = this.#activeTurns.get(update.conversationId);
    if (!active) return;
    const payload = update.payload as Record<string, unknown>;
    const text = extractText(payload);
    if (update.kind === 'assistant-text' && text) {
      active.text += text;
      this.#emit('message.stream', {
        type: 'text',
        data: text,
        msg_id: active.messageId,
        turn_id: active.turnId,
        conversation_id: update.conversationId,
        created_at: Date.now(),
        position: 'left',
        status: 'work',
      });
      return;
    }
    if (update.kind === 'reasoning' && text) {
      this.#emit('message.stream', {
        type: 'thinking',
        data: { content: text, status: 'thinking' },
        msg_id: `${active.messageId}:thinking`,
        turn_id: active.turnId,
        conversation_id: update.conversationId,
        created_at: Date.now(),
      });
      return;
    }
    if (update.kind === 'usage') {
      this.#emit('message.stream', {
        type: 'acp_context_usage',
        data: payload,
        msg_id: active.messageId,
        turn_id: active.turnId,
        conversation_id: update.conversationId,
      });
      return;
    }
    if (update.kind === 'tool-start' || update.kind === 'tool-update') {
      const toolCallId = String(payload.toolCallId ?? payload.tool_call_id ?? `tool-${update.sequence}`);
      this.#emit('message.stream', {
        type: 'acp_tool_call',
        data: {
          update: {
            ...payload,
            sessionUpdate: update.kind === 'tool-start' ? 'tool_call' : 'tool_call_update',
            tool_call_id: toolCallId,
          },
        },
        msg_id: `${active.messageId}:tool:${toolCallId}`,
        turn_id: active.turnId,
        conversation_id: update.conversationId,
        created_at: Date.now(),
      });
    }
  }

  #requestPermission(request: BridgePermissionRequest): Promise<BridgePermissionDecision> {
    const conversationId = request.conversationId ?? '';
    const active = this.#activeTurns.get(conversationId);
    if (!conversationId || !active) return Promise.resolve({ cancelled: true });
    const rawToolCall =
      request.toolCall && typeof request.toolCall === 'object' ? (request.toolCall as Record<string, unknown>) : {};
    const callId = String(rawToolCall.toolCallId ?? rawToolCall.tool_call_id ?? randomUUID());
    const messageId = `${active.messageId}:permission:${callId}`;
    const conversation = this.#state.conversations.find((item) => item.id === conversationId);
    if (conversation) {
      conversation.runtime = {
        ...conversation.runtime,
        state: 'waiting_confirmation',
        pending_confirmations: conversation.runtime.pending_confirmations + 1,
      };
    }
    this.#emit('message.stream', {
      type: 'acp_permission',
      data: {
        session_id: request.sessionId,
        options: request.options.map((option) => ({
          option_id: option.optionId,
          kind: option.kind,
          name: option.name ?? option.kind,
        })),
        tool_call: {
          ...rawToolCall,
          tool_call_id: callId,
          raw_input: rawToolCall.rawInput ?? rawToolCall.raw_input,
        },
      },
      msg_id: messageId,
      turn_id: active.turnId,
      conversation_id: conversationId,
      created_at: Date.now(),
    });
    return new Promise<BridgePermissionDecision>((resolve) => {
      this.#pendingPermissions.set(`${conversationId}:${callId}`, { request, messageId, resolve });
    });
  }

  async #ensureSession(conversation: StoredConversation): Promise<void> {
    const workspace = await this.#workspaceForConversation(conversation);
    const existingSession = this.#bridge?.getSession(conversation.id);
    if (existingSession) {
      if (!sameCanonicalPath(existingSession.cwd, workspace)) throw new Error('WORKSPACE_BINDING_MISMATCH');
      return;
    }
    const session = conversation.session_id
      ? await this.#bridge?.resumeSession(conversation.id, conversation.session_id, workspace)
      : await this.#bridge?.createSession(conversation.id, workspace);
    if (!session) throw new Error('DeepSeek Harness bridge is unavailable.');
    conversation.session_id = session.sessionId;
    conversation.extra.acp_session_id = session.sessionId;
    const currentModelId = toUiModelId(conversation.extra.current_model_id);
    conversation.extra.current_model_id = currentModelId;
    conversation.extra.cached_config_options = this.#uiConfigOptions(session.configOptions, currentModelId);
    await this.#persist();
  }

  async #sendPrompt(conversation: StoredConversation, text: string, turnId: string, messageId: string): Promise<void> {
    try {
      await this.#ensureSession(conversation);
      this.#emit('message.stream', {
        type: 'start',
        data: {},
        msg_id: messageId,
        turn_id: turnId,
        conversation_id: conversation.id,
        created_at: Date.now(),
      });
      const stopReason = await this.#bridge?.prompt(conversation.id, text, turnId);
      const active = this.#activeTurns.get(conversation.id);
      if (active?.text) {
        (this.#state.messages[conversation.id] ??= []).push({
          id: messageId,
          conversation_id: conversation.id,
          msg_id: messageId,
          type: 'text',
          content: { content: active.text },
          position: 'left',
          status: 'finish',
          hidden: false,
          created_at: Date.now(),
          backend_turn_id: turnId,
        });
      }
      conversation.status = 'finished';
      conversation.runtime = idleRuntime();
      conversation.modified_at = Date.now();
      await this.#persist();
      this.#emit('message.stream', {
        type: stopReason === 'failed' ? 'error' : 'finish',
        data: stopReason === 'failed' ? { message: 'DeepSeek Harness turn failed.' } : {},
        msg_id: messageId,
        turn_id: turnId,
        conversation_id: conversation.id,
        created_at: Date.now(),
      });
      this.#emit('turn.completed', {
        session_id: conversation.id,
        turn_id: turnId,
        status: 'finished',
        state: 'ai_waiting_input',
        can_send_message: true,
        runtime: conversation.runtime,
        workspace: conversation.extra.workspace,
        model: {
          platform: 'deepseek-harness',
          name: toUiModelId(conversation.extra.current_model_id),
          use_model: toUiModelId(conversation.extra.current_model_id),
        },
        last_message: { id: messageId, type: 'text', content: active?.text ?? '', created_at: Date.now() },
      });
    } catch (error) {
      conversation.status = 'finished';
      conversation.runtime = idleRuntime();
      this.#emit('message.stream', {
        type: 'error',
        data: { message: error instanceof Error ? error.message : String(error) },
        msg_id: messageId,
        turn_id: turnId,
        conversation_id: conversation.id,
        created_at: Date.now(),
      });
    } finally {
      this.#activeTurns.delete(conversation.id);
    }
  }

  async #route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method === 'OPTIONS') {
        responseData(response, null, 204);
        return;
      }
      const url = new URL(request.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const method = request.method ?? 'GET';
      if (path === '/health') {
        responseData(response, { status: 'ok', backend: 'deepseek-harness', version: 'direct' });
        return;
      }
      if (path === '/api/system/current-user') {
        responseData(response, { id: 'system_default_user', username: 'local' });
        return;
      }
      if (path === '/api/system/info') {
        responseData(response, {
          cache_dir: join(this.#options.dshHome, 'cache'),
          work_dir: this.#options.cwd,
          log_dir: join(this.#options.dshHome, 'logs'),
          platform: process.platform,
          arch: process.arch,
        });
        return;
      }
      if (path === '/api/settings/client') {
        if (method === 'GET') {
          const result: Record<string, unknown> = {};
          for (const key of url.searchParams.getAll('keys').flatMap((value) => value.split(','))) {
            result[key] = this.#state.clientSettings[key];
          }
          responseData(response, result);
          return;
        }
        const body = await readJsonBody(request);
        Object.assign(this.#state.clientSettings, body);
        await this.#persist();
        responseData(response, true);
        return;
      }
      if (path === '/api/agents/management' || path === '/api/agents') {
        responseData(response, [this.#agentRecord()]);
        return;
      }
      if (path === '/api/assistants') {
        responseData(response, [this.#assistantRecord()]);
        return;
      }
      const officePreviewMatch = path.match(/^\/api\/(word|excel|ppt)-preview\/(start|stop)$/);
      if (officePreviewMatch && method === 'POST') {
        const documentType = officePreviewMatch[1] as OfficeDocumentType;
        const action = officePreviewMatch[2];
        const body = await readJsonBody(request);
        const filePath = await this.#officeFilePath(body);
        if (action === 'stop') {
          await this.#officePreview.stop(filePath);
          responseData(response, null);
          return;
        }
        const expectedExtensions: Record<OfficeDocumentType, string> = {
          word: '.docx',
          excel: '.xlsx',
          ppt: '.pptx',
        };
        if (extname(filePath).toLocaleLowerCase() !== expectedExtensions[documentType]) {
          throw new OfficePreviewError('OFFICECLI_START_FAILED', `Invalid ${documentType} document extension.`);
        }
        responseData(response, await this.#officePreview.start(filePath, documentType));
        return;
      }
      if (
        path === `/api/assistants/${encodeURIComponent(ASSISTANT_ID)}` ||
        path === `/api/assistants/${ASSISTANT_ID}`
      ) {
        responseData(response, this.#assistantDetailRecord());
        return;
      }
      if (path.startsWith('/api/shell/')) {
        if (!this.#options.desktopShell) {
          responseData(response, { error: 'Desktop shell is unavailable.', code: 'SHELL_UNAVAILABLE' }, 501);
          return;
        }
        const body = await readJsonBody(request);
        if (path === '/api/shell/check-tool-installed') {
          responseData(response, await this.#options.desktopShell.checkToolInstalled(String(body.tool ?? '')));
          return;
        }
        if (path === '/api/shell/open-folder-with') {
          const folderPath = await this.#registeredPath(String(body.folder_path ?? ''));
          const tool = body.tool;
          if (tool !== 'vscode' && tool !== 'terminal' && tool !== 'explorer') throw new Error('SHELL_TOOL_INVALID');
          await this.#options.desktopShell.openFolderWith(folderPath, tool);
          responseData(response, null);
          return;
        }
        if (path === '/api/shell/open-file') {
          await this.#options.desktopShell.openFile(await this.#registeredPath(String(body.file_path ?? '')));
          responseData(response, null);
          return;
        }
        if (path === '/api/shell/show-item-in-folder') {
          await this.#options.desktopShell.showItemInFolder(await this.#registeredPath(String(body.file_path ?? '')));
          responseData(response, null);
          return;
        }
        if (path === '/api/shell/open-external') {
          await this.#options.desktopShell.openExternal(String(body.url ?? ''));
          responseData(response, null);
          return;
        }
      }
      if (path === '/api/fs/content' && (method === 'POST' || method === 'PUT')) {
        const body = await readJsonBody(request);
        const ref = projectFileRef(body.file);
        const filePath = await resolveProjectPath(this.#state.projects, ref);
        if (method === 'PUT') {
          const expected = Number(request.headers['if-match']);
          if (Number.isFinite(expected) && (await stat(filePath)).mtimeMs !== expected) {
            responseData(response, { error: 'File changed on disk.', code: 'FILE_MODIFIED' }, 409);
            return;
          }
          if (typeof body.data !== 'string') throw new Error('FILE_CONTENT_INVALID');
          await writeFile(filePath, body.data, 'utf8');
          responseData(response, true);
          return;
        }
        const data = await readFile(filePath);
        const encoding = body.encoding;
        if (encoding === 'base64') responseData(response, data.toString('base64'));
        else if (encoding === 'dataurl')
          responseData(response, `data:${mimeType(filePath)};base64,${data.toString('base64')}`);
        else responseData(response, data.toString('utf8'));
        return;
      }
      if (path === '/api/fs/content/metadata' && method === 'POST') {
        const body = await readJsonBody(request);
        const filePath = await resolveProjectPath(this.#state.projects, projectFileRef(body.file));
        const metadata = await stat(filePath);
        responseData(response, {
          name: basename(filePath),
          path: filePath,
          size: metadata.size,
          type: mimeType(filePath),
          last_modified: metadata.mtimeMs,
          is_directory: metadata.isDirectory(),
        });
        return;
      }
      if (path === '/api/fs/reveal' && method === 'POST') {
        if (!this.#options.desktopShell) throw new Error('SHELL_UNAVAILABLE');
        const body = await readJsonBody(request);
        await this.#options.desktopShell.showItemInFolder(
          await resolveProjectPath(this.#state.projects, projectFileRef(body))
        );
        responseData(response, null);
        return;
      }
      if (path === '/api/fs/copy-absolute-path' && method === 'POST') {
        if (!this.#options.desktopShell) throw new Error('SHELL_UNAVAILABLE');
        const body = await readJsonBody(request);
        this.#options.desktopShell.copyText(await resolveProjectPath(this.#state.projects, projectFileRef(body)));
        responseData(response, null);
        return;
      }
      if (path === '/api/fs/open-system' && method === 'POST') {
        if (!this.#options.desktopShell) throw new Error('SHELL_UNAVAILABLE');
        const body = await readJsonBody(request);
        await this.#options.desktopShell.openFile(
          await resolveProjectPath(this.#state.projects, projectFileRef(body.file))
        );
        responseData(response, null);
        return;
      }
      if (path === '/api/fs/copy' && method === 'POST') {
        const body = await readJsonBody(request);
        const filePaths = Array.isArray(body.file_paths)
          ? body.file_paths.filter((item): item is string => typeof item === 'string')
          : [];
        responseData(response, await copyExternalFiles(this.#state.projects, filePaths, projectFileRef(body.target)));
        return;
      }
      if (path === '/api/conversations' && method === 'GET') {
        const items = this.#state.conversations.toSorted((a, b) => b.modified_at - a.modified_at);
        responseData(response, { items, total: items.length, has_more: false });
        return;
      }
      if (path === '/api/conversations' && method === 'POST') {
        const body = await readJsonBody(request);
        const now = Date.now();
        const extra = body.extra && typeof body.extra === 'object' ? (body.extra as Record<string, unknown>) : {};
        const requestedWorkspace =
          typeof extra.workspace === 'string' && extra.workspace ? extra.workspace : this.#options.cwd;
        const canonicalWorkspace = await canonicalizeWorkspace(requestedWorkspace);
        const project = ensureWorkspaceProject(this.#state.projects, canonicalWorkspace);
        const conversation: StoredConversation = {
          id: typeof body.id === 'string' ? body.id : randomUUID().slice(0, 8),
          name: typeof body.name === 'string' && body.name ? body.name : 'DeepSeek Harness',
          type: 'acp',
          status: 'pending',
          source: 'aionui',
          pinned: false,
          assistant: { id: ASSISTANT_ID, source: 'dsh', name: 'DeepSeek Harness', avatar: '', backend: 'acp' },
          created_at: now,
          modified_at: now,
          extra: {
            ...extra,
            workspace: canonicalWorkspace,
            backend: 'acp',
            current_model_id: this.#modelOptions()[0]?.id ?? DEFAULT_MODEL_ID,
          },
          project_id: project.id,
          runtime: idleRuntime(),
          prompt_capability: { image: false, audio: false },
        };
        this.#state.conversations.push(conversation);
        this.#state.workspaceBindings.push({
          conversationId: conversation.id,
          projectId: project.id,
          workspacePeId: project.workspacePeId,
          canonicalPath: canonicalWorkspace,
          displayPath: requestedWorkspace,
          revision: 1,
        });
        this.#state.messages[conversation.id] = [];
        await this.#persist();
        this.#emit('conversation.listChanged', {
          conversation_id: conversation.id,
          action: 'created',
          source: 'aionui',
        });
        responseData(response, conversation, 201);
        return;
      }
      if (path === '/api/conversations/active-count') {
        responseData(response, { count: this.#activeTurns.size });
        return;
      }
      if (path === '/api/sidebar') {
        responseData(response, {
          groups: [
            {
              scope: { type: 'chats' },
              items: this.#state.conversations.map((conversation) => ({ type: 'conversation', conversation })),
              has_more: false,
            },
          ],
          has_more_groups: false,
        });
        return;
      }
      const projectFolderMatch = path.match(/^\/api\/projects\/([^/]+)\/folders(?:\/([^/]+))?$/);
      if (projectFolderMatch) {
        const project = this.#state.projects.find((item) => item.id === decodeURIComponent(projectFolderMatch[1]));
        if (!project) {
          responseData(response, { error: 'Project not found.', code: 'NOT_FOUND' }, 404);
          return;
        }
        if (method === 'POST' && !projectFolderMatch[2]) {
          const body = await readJsonBody(request);
          if (typeof body.uri !== 'string') throw new Error('PROJECT_FOLDER_URI_INVALID');
          const canonicalPath = await canonicalizeWorkspace(fileURLToPath(body.uri));
          for (const entry of project.entries) {
            const fromEntry = relative(entry.canonicalPath, canonicalPath);
            if (
              fromEntry === '' ||
              (fromEntry !== '..' && !fromEntry.startsWith(`..${sep}`) && !isAbsolute(fromEntry))
            ) {
              responseData(response, {
                pe_id: entry.peId,
                role: entry.role,
                display_name: entry.displayName ?? null,
                display_path: entry.displayPath,
                order_index: entry.orderIndex,
                runtime_status: 'available',
              });
              return;
            }
            const fromCandidate = relative(canonicalPath, entry.canonicalPath);
            if (fromCandidate !== '..' && !fromCandidate.startsWith(`..${sep}`) && !isAbsolute(fromCandidate)) {
              responseData(
                response,
                { error: 'Folder overlaps an existing root.', code: 'project_explorer_overlap' },
                409
              );
              return;
            }
          }
          const entry = {
            peId: randomUUID(),
            role: 'attached' as const,
            canonicalPath,
            displayPath: canonicalPath,
            displayName: typeof body.display_name === 'string' ? body.display_name : undefined,
            orderIndex: project.entries.length,
          };
          project.entries.push(entry);
          await this.#persist();
          responseData(response, {
            pe_id: entry.peId,
            role: entry.role,
            display_name: entry.displayName ?? null,
            display_path: entry.displayPath,
            order_index: entry.orderIndex,
            runtime_status: 'available',
          });
          return;
        }
        if (method === 'DELETE' && projectFolderMatch[2]) {
          const peId = decodeURIComponent(projectFolderMatch[2]);
          if (peId === project.workspacePeId) {
            responseData(response, { error: 'Workspace root cannot be removed.', code: 'PROJECT_ROOT_IMMUTABLE' }, 409);
            return;
          }
          project.entries = project.entries.filter((entry) => entry.peId !== peId);
          await this.#persist();
          responseData(response, null);
          return;
        }
      }
      const projectResolveMatch = path.match(/^\/api\/projects\/([^/]+)\/resolve-ref$/);
      if (projectResolveMatch && method === 'POST') {
        const project = this.#state.projects.find((item) => item.id === decodeURIComponent(projectResolveMatch[1]));
        if (!project) {
          responseData(response, { error: 'Project not found.', code: 'NOT_FOUND' }, 404);
          return;
        }
        const body = await readJsonBody(request);
        const file = body.file;
        if (!file || typeof file !== 'object' || (file as Record<string, unknown>).kind !== 'local') {
          responseData(response, { file, upgraded: false });
          return;
        }
        try {
          const canonical = await realpath(String((file as Record<string, unknown>).path ?? ''));
          const entry = project.entries.find((candidate) => {
            const rel = relative(candidate.canonicalPath, canonical);
            return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
          });
          if (!entry) responseData(response, { file, upgraded: false });
          else {
            responseData(response, {
              file: {
                kind: 'project',
                pe_id: entry.peId,
                relative_path: relative(entry.canonicalPath, canonical).replaceAll(sep, '/'),
              },
              upgraded: true,
            });
          }
        } catch {
          responseData(response, { file, upgraded: false });
        }
        return;
      }
      const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
      if (projectMatch && method === 'GET') {
        const projectId = decodeURIComponent(projectMatch[1]);
        const project = this.#state.projects.find((item) => item.id === projectId);
        if (!project) {
          responseData(response, { error: 'Project not found.', code: 'NOT_FOUND' }, 404);
          return;
        }
        responseData(response, projectDto(project));
        return;
      }
      const conversationMatch = path.match(/^\/api\/conversations\/([^/]+)(?:\/(.*))?$/);
      if (conversationMatch) {
        const conversationId = decodeURIComponent(conversationMatch[1]);
        const tail = conversationMatch[2] ?? '';
        const conversation = this.#state.conversations.find((item) => item.id === conversationId);
        if (!conversation) {
          responseData(response, { error: 'Conversation not found.', code: 'NOT_FOUND' }, 404);
          return;
        }
        if (!tail && method === 'GET') {
          responseData(response, conversation);
          return;
        }
        if (!tail && method === 'PATCH') {
          const body = await readJsonBody(request);
          if (typeof body.name === 'string') conversation.name = body.name;
          if (typeof body.pinned === 'boolean') conversation.pinned = body.pinned;
          if (body.extra && typeof body.extra === 'object') {
            const nextExtra = body.extra as Record<string, unknown>;
            const requestedWorkspace =
              typeof nextExtra.workspace === 'string' ? nextExtra.workspace.trim() : conversation.extra.workspace;
            if (requestedWorkspace && !sameCanonicalPath(requestedWorkspace, conversation.extra.workspace)) {
              if (this.#activeTurns.has(conversation.id)) {
                responseData(
                  response,
                  { error: 'Workspace cannot change during an active turn.', code: 'WORKSPACE_CHANGE_ACTIVE_TURN' },
                  409
                );
                return;
              }
              const canonicalWorkspace = await canonicalizeWorkspace(requestedWorkspace);
              if (this.#bridge?.getSession(conversation.id)) await this.#bridge.closeSession(conversation.id);
              const project = ensureWorkspaceProject(this.#state.projects, canonicalWorkspace);
              const previous = this.#state.workspaceBindings.find((item) => item.conversationId === conversation.id);
              this.#state.workspaceBindings = this.#state.workspaceBindings.filter(
                (item) => item.conversationId !== conversation.id
              );
              this.#state.workspaceBindings.push({
                conversationId: conversation.id,
                projectId: project.id,
                workspacePeId: project.workspacePeId,
                canonicalPath: canonicalWorkspace,
                displayPath: requestedWorkspace,
                revision: (previous?.revision ?? 0) + 1,
              });
              conversation.project_id = project.id;
              conversation.extra = { ...conversation.extra, ...nextExtra, workspace: canonicalWorkspace };
              delete conversation.session_id;
              delete conversation.extra.acp_session_id;
              delete conversation.extra.cached_config_options;
            } else {
              conversation.extra = { ...conversation.extra, ...nextExtra, workspace: conversation.extra.workspace };
            }
          }
          conversation.modified_at = Date.now();
          await this.#persist();
          this.#emit('conversation.listChanged', { conversation_id: conversation.id, action: 'updated' });
          responseData(response, true);
          return;
        }
        if (!tail && method === 'DELETE') {
          this.#state.conversations = this.#state.conversations.filter((item) => item.id !== conversationId);
          this.#state.workspaceBindings = this.#state.workspaceBindings.filter(
            (item) => item.conversationId !== conversationId
          );
          delete this.#state.messages[conversationId];
          if (this.#bridge?.getSession(conversationId)) await this.#bridge.closeSession(conversationId);
          await this.#persist();
          this.#emit('conversation.listChanged', { conversation_id: conversationId, action: 'deleted' });
          responseData(response, true);
          return;
        }
        if (tail === 'messages' && method === 'GET') {
          const items = this.#state.messages[conversationId] ?? [];
          responseData(response, {
            items,
            oldest_cursor: items[0]?.id ?? null,
            newest_cursor: items.at(-1)?.id ?? null,
            has_more_before: false,
            has_more_after: false,
          });
          return;
        }
        if (tail === 'messages/latest' && method === 'GET') {
          const type = url.searchParams.get('type');
          const latest = (this.#state.messages[conversationId] ?? []).findLast(
            (message) => !type || message.type === type
          );
          responseData(response, latest ?? null);
          return;
        }
        if (tail === 'messages' && method === 'POST') {
          if (this.#activeTurns.has(conversationId)) {
            responseData(response, { error: 'Conversation is already running.', code: 'CONVERSATION_BUSY' }, 409);
            return;
          }
          const body = await readJsonBody(request);
          const text = typeof body.content === 'string' ? body.content : '';
          if (!text.trim()) {
            responseData(response, { error: 'Message content is empty.', code: 'INVALID_MESSAGE' }, 400);
            return;
          }
          const turnId = `turn_${randomUUID().slice(0, 8)}`;
          const userId = randomUUID().slice(0, 8);
          const assistantId = randomUUID().slice(0, 8);
          const createdAt = Date.now();
          (this.#state.messages[conversationId] ??= []).push({
            id: userId,
            conversation_id: conversationId,
            msg_id: userId,
            type: 'text',
            content: { content: text },
            position: 'right',
            status: 'finish',
            hidden: false,
            created_at: createdAt,
            backend_turn_id: turnId,
          });
          conversation.status = 'running';
          conversation.runtime = runningRuntime(turnId);
          conversation.modified_at = createdAt;
          this.#activeTurns.set(conversationId, { turnId, messageId: assistantId, text: '', startedAt: createdAt });
          await this.#persist();
          void this.#sendPrompt(conversation, text, turnId, assistantId);
          responseData(response, { msg_id: userId, turn_id: turnId, runtime: conversation.runtime }, 202);
          return;
        }
        if ((tail === 'runtime/ensure' || tail === 'runtime/restart') && method === 'POST') {
          if (tail === 'runtime/restart' && this.#bridge?.getSession(conversationId)) {
            await this.#bridge.closeSession(conversationId);
            delete conversation.session_id;
          }
          await this.#ensureSession(conversation);
          responseData(response, {
            recovered: false,
            config_options: conversation.extra.cached_config_options ?? [],
            runtime: conversation.runtime,
          });
          return;
        }
        if (tail === 'cancel' && method === 'POST') {
          conversation.runtime = { ...conversation.runtime, state: 'cancelling' };
          for (const [key, pending] of this.#pendingPermissions) {
            if (key.startsWith(`${conversationId}:`)) {
              pending.resolve({ cancelled: true });
              this.#pendingPermissions.delete(key);
            }
          }
          await this.#bridge?.cancel(conversationId);
          responseData(response, { runtime: conversation.runtime });
          return;
        }
        const confirmationMatch = tail.match(/^confirmations\/([^/]+)\/confirm$/);
        if (confirmationMatch && method === 'POST') {
          const callId = decodeURIComponent(confirmationMatch[1]);
          const key = `${conversationId}:${callId}`;
          const pending = this.#pendingPermissions.get(key);
          if (!pending) {
            responseData(response, { error: 'Permission request not found.', code: 'NOT_FOUND' }, 404);
            return;
          }
          const body = await readJsonBody(request);
          pending.resolve({ optionId: String(body.data ?? '') });
          this.#pendingPermissions.delete(key);
          conversation.runtime = {
            ...conversation.runtime,
            state: 'running',
            pending_confirmations: Math.max(0, conversation.runtime.pending_confirmations - 1),
          };
          this.#emit('confirmation.remove', { conversation_id: conversationId, id: pending.messageId });
          responseData(response, null);
          return;
        }
        if (tail.startsWith('config-options/') && method === 'PUT') {
          await this.#ensureSession(conversation);
          const body = await readJsonBody(request);
          const configId = decodeURIComponent(tail.slice('config-options/'.length));
          const requestedValue = String(body.value ?? '');
          const bridgeValue = configId === 'model' ? toDshModelValue(requestedValue) : requestedValue;
          const session = await this.#bridge?.setConfigOption(conversationId, configId, bridgeValue);
          if (configId === 'model') conversation.extra.current_model_id = requestedValue;
          const configOptions = this.#uiConfigOptions(
            session?.configOptions ?? [],
            toUiModelId(conversation.extra.current_model_id)
          );
          conversation.extra.cached_config_options = configOptions;
          await this.#persist();
          responseData(response, { confirmation: 'observed', config_options: configOptions });
          return;
        }
        if (tail === 'active-lease' && method === 'POST') {
          responseData(response, null);
          return;
        }
        if (tail === 'usage') {
          responseData(response, null);
          return;
        }
        if (tail === 'slash-commands' || tail === 'confirmations' || tail === 'artifacts' || tail === 'associated') {
          responseData(response, []);
          return;
        }
      }
      if (
        path === '/api/skills' ||
        path === '/api/cron/jobs' ||
        path === '/api/mcp/servers' ||
        path === '/api/providers' ||
        path === '/api/teams' ||
        path === '/api/extensions/acp-adapters'
      ) {
        responseData(response, []);
        return;
      }
      if (path === '/api/mcp/servers/import' && method === 'POST') {
        const body = await readJsonBody(request);
        const servers = Array.isArray(body.servers) ? body.servers : [];
        responseData(
          response,
          servers.map((server, index) =>
            Object.assign({}, server && typeof server === 'object' ? server : {}, { id: `bootstrap-${index}` })
          )
        );
        return;
      }
      const channelSettingsMatch = path.match(/^\/api\/channel\/settings\/([^/]+)$/);
      if (channelSettingsMatch && method === 'GET') {
        responseData(response, {
          platform: decodeURIComponent(channelSettingsMatch[1]),
          assistant: null,
          default_model: null,
        });
        return;
      }
      if (path === '/api/auth/status') {
        responseData(response, { authenticated: true, mode: 'local' });
        return;
      }
      if (path === '/api/auth/internal/users/system' || path === '/api/settings') {
        responseData(response, {});
        return;
      }
      responseData(
        response,
        { error: `Direct dsh backend route is not implemented: ${method} ${path}`, code: 'NOT_IMPLEMENTED' },
        501
      );
    } catch (error) {
      if (error instanceof OfficePreviewError) {
        responseData(response, { error: error.message, code: error.code }, 500);
        return;
      }
      if (error instanceof Error && error.message === 'PATH_OUTSIDE_SANDBOX') {
        responseData(response, { error: error.message, code: error.message }, 403);
        return;
      }
      responseData(
        response,
        { error: error instanceof Error ? error.message : String(error), code: 'DIRECT_DSH_BACKEND_ERROR' },
        500
      );
    }
  }

  #assistantRecord(): Record<string, unknown> {
    return {
      id: ASSISTANT_ID,
      name: 'DeepSeek Harness',
      name_i18n: {},
      description: 'Direct deepseek-harness ACP backend',
      description_i18n: {},
      context_i18n: {},
      prompts_i18n: {},
      source: 'generated',
      avatar: '',
      enabled: true,
      sort_order: 0,
      agent_id: ASSISTANT_ID,
      agent: { type: 'acp', source: 'builtin', acp_backend: ASSISTANT_ID },
      enabled_skills: [],
      custom_skill_names: [],
      disabled_builtin_skills: [],
      prompts: [],
      models: this.#models.map((model) => model.id),
      agent_status: 'online',
      team_selectable: false,
      team_block_reason: 'Direct deepseek-harness sessions are single-agent.',
      deletable: false,
    };
  }

  #assistantDetailRecord(): Record<string, unknown> {
    const defaultModelId = this.#defaultModelId();
    return {
      id: ASSISTANT_ID,
      source: 'generated',
      agent_status: 'online',
      team_selectable: false,
      team_block_reason: 'Direct deepseek-harness sessions are single-agent.',
      deletable: false,
      profile: {
        name: 'DeepSeek Harness',
        name_i18n: {},
        description: 'Direct deepseek-harness ACP backend',
        description_i18n: {},
        avatar: '',
      },
      state: { enabled: true, sort_order: 0 },
      engine: {
        agent_id: ASSISTANT_ID,
        agent: { type: 'acp', source: 'builtin', acp_backend: ASSISTANT_ID },
      },
      rules: { content: '', storage_mode: 'backend' },
      prompts: { recommended: [], recommended_i18n: {} },
      defaults: {
        model: { mode: 'fixed', value: defaultModelId },
        permission: { mode: 'auto' },
        thought_level: { mode: 'auto' },
        skills: { mode: 'fixed', value: [] },
        mcps: { mode: 'fixed', value: [] },
      },
      capabilities: {
        default_skill_ids: [],
        custom_skill_names: [],
        default_disabled_builtin_skill_ids: [],
      },
      preferences: {
        last_model_id: defaultModelId,
        last_skill_ids: [],
        last_disabled_builtin_skill_ids: [],
        last_mcp_ids: [],
      },
    };
  }

  #agentRecord(): Record<string, unknown> {
    const defaultModelId = this.#defaultModelId();
    const configOptions = this.#uiConfigOptions([], defaultModelId);
    return {
      id: ASSISTANT_ID,
      name: 'DeepSeek Harness',
      description: 'Direct deepseek-harness ACP backend',
      agent_type: 'acp',
      agent_source: 'builtin',
      enabled: true,
      installed: true,
      status: 'online',
      config_options: { config_options: configOptions },
      available_models: {
        current_model_id: defaultModelId,
        current_model_label: defaultModelId,
        available_models: this.#modelOptions(),
      },
      available_modes: { current_mode_id: 'default', available_modes: [] },
    };
  }
}
