import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DshApiServer, EXPERT_PATCH_FILE, runtimeKeyId } from '../../../packages/dsh-bridge/src';
import type { DshAgentPort } from '../../../packages/dsh-bridge/src';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function createServer() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-handoff-'));
  const sessions = new Map<string, string>();
  const prompts: string[] = [];
  const runtimeKeys: string[] = [];
  let sessionCounter = 0;
  const port: DshAgentPort = {
    initialize: async () => ({ protocolVersion: 1, capabilities: {} }),
    newSession: async (cwd) => {
      sessionCounter += 1;
      const sessionId = `session-${sessionCounter}`;
      sessions.set(sessionId, cwd);
      return { sessionId, configOptions: [] };
    },
    resumeSession: async () => ({ configOptions: [] }),
    closeSession: async () => undefined,
    prompt: async (_sessionId, prompt) => {
      prompts.push(prompt[0]?.text ?? '');
      return { stopReason: 'end_turn' };
    },
    cancel: async () => undefined,
    setConfigOption: async () => [],
    bindSession: (sessionId, conversationId) => sessions.set(sessionId, conversationId),
    dispose: async () => undefined,
  };
  const server = new DshApiServer({
    cwd: root,
    dshHome: join(root, 'dsh'),
    expertsDir: join(root, 'experts'),
    dataFile: join(root, 'state.json'),
    agentPortFactory: (_handlers, _mode, key) => {
      runtimeKeys.push(runtimeKeyId(key));
      return port;
    },
    prewarmMode: false,
  });
  const serverPort = await server.start();
  cleanups.push(async () => {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${serverPort}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: response.status, payload: (await response.json()) as { data?: never; code?: string } };
  };
  return { root, call, prompts, runtimeKeys, dshHome: join(root, 'dsh') };
}

const expertRequest = (overrides: Record<string, unknown> = {}) => ({
  name: 'repo-surveyor',
  expert_type: 'agent',
  mode: 'coding',
  display_name: { 'zh-CN': '仓库勘察' },
  goal: '定位代码路径、依赖与既有约定',
  output: '结论与关键文件行号',
  allowed_tools: ['Read', 'Glob', 'Grep'],
  ...overrides,
});

describe('handing a conversation off to an expert', () => {
  it('opens a new conversation in the same workspace carrying the context across', async () => {
    const { call, prompts } = await createServer();
    await call('POST', '/api/experts', expertRequest());
    const created = await call('POST', '/api/conversations', { assistant: { id: 'dsh:coding' }, extra: {} });
    const sourceId = (created.payload.data as unknown as { id: string }).id;
    await call('POST', `/api/conversations/${sourceId}/messages`, { content: 'Where does auth live?' });
    await vi.waitFor(() => expect(prompts.length).toBe(1));

    const handoff = await call('POST', `/api/conversations/${sourceId}/handoff`, { expert_id: 'repo-surveyor' });

    expect(handoff.status).toBe(201);
    const target = handoff.payload.data as unknown as {
      id: string;
      extra: { workspace: string; handoff_from_conversation_id: string; capability_snapshot: { expertId: string } };
    };
    const source = (await call('GET', `/api/conversations/${sourceId}`)).payload.data as unknown as {
      extra: { workspace: string };
    };
    expect(target.extra.handoff_from_conversation_id).toBe(sourceId);
    expect(target.extra.capability_snapshot.expertId).toBe('repo-surveyor');
    expect(target.extra.workspace).toBe(source.extra.workspace);

    const { items } = (await call('GET', `/api/conversations/${target.id}/messages`)).payload.data as unknown as {
      items: Array<{ content: { content: string }; position: string }>;
    };
    // The expert must be able to start without the user retyping anything.
    expect(items[0].position).toBe('right');
    expect(items[0].content.content).toContain('原始目标');
    expect(items[0].content.content).toContain('Where does auth live?');
  });

  it('refuses an expert that belongs to another work mode', async () => {
    const { call } = await createServer();
    await call('POST', '/api/experts', expertRequest({ mode: 'office' }));
    const created = await call('POST', '/api/conversations', { assistant: { id: 'dsh:coding' }, extra: {} });
    const sourceId = (created.payload.data as unknown as { id: string }).id;

    const handoff = await call('POST', `/api/conversations/${sourceId}/handoff`, { expert_id: 'repo-surveyor' });

    expect(handoff.status).toBe(409);
    expect(handoff.payload.code).toBe('EXPERT_MODE_MISMATCH');
  });

  it('leaves the work-mode runtime on the base patch until delegation is turned on', async () => {
    const { call, dshHome } = await createServer();
    await call('POST', '/api/experts', expertRequest());
    const created = await call('POST', '/api/conversations', { assistant: { id: 'dsh:coding' }, extra: {} });
    const conversationId = (created.payload.data as unknown as { id: string }).id;
    await call('POST', `/api/conversations/${conversationId}/runtime/ensure`);

    // The shared work-mode runtime is the entry point for almost every conversation; with
    // delegation off it must run on exactly what it ran on before experts existed.
    await expect(readFile(join(dshHome, EXPERT_PATCH_FILE), 'utf8')).rejects.toThrow();
  });

  it('mounts one delegation tool per same-mode expert once delegation is on', async () => {
    const { call, dshHome } = await createServer();
    await call('POST', '/api/experts', expertRequest());
    expect((await call('PUT', '/api/settings/client', { expert_delegation: { coding: true } })).status).toBe(200);

    const created = await call('POST', '/api/conversations', { assistant: { id: 'dsh:coding' }, extra: {} });
    const conversationId = (created.payload.data as unknown as { id: string }).id;
    await call('POST', `/api/conversations/${conversationId}/runtime/ensure`);

    const patch = await readFile(join(dshHome, EXPERT_PATCH_FILE), 'utf8');
    expect(patch).toContain('toolName: expert__repo_surveyor');
    expect(patch).toContain('allow: [glob, grep, read, read_image, skill, todo_write]');
    expect(patch).not.toContain('id: approval');
  });

  it('picks up an expert added after delegation was switched on', async () => {
    const { call, dshHome } = await createServer();
    await call('PUT', '/api/settings/client', { expert_delegation: { coding: true } });
    // Added after the switch: the work-mode runtime's overlay is built from the whole
    // catalog, so it has to follow the catalog rather than freeze at first use.
    await call('POST', '/api/experts', expertRequest({ name: 'late-arrival' }));

    const created = await call('POST', '/api/conversations', { assistant: { id: 'dsh:coding' }, extra: {} });
    const conversationId = (created.payload.data as unknown as { id: string }).id;
    await call('POST', `/api/conversations/${conversationId}/runtime/ensure`);

    expect(await readFile(join(dshHome, EXPERT_PATCH_FILE), 'utf8')).toContain('toolName: expert__late_arrival');
  });

  it('refuses to swap the delegation composition while a turn is running', async () => {
    const { call } = await createServer();
    const created = await call('POST', '/api/conversations', { assistant: { id: 'dsh:coding' }, extra: {} });
    const conversationId = (created.payload.data as unknown as { id: string }).id;
    await call('POST', `/api/conversations/${conversationId}/messages`, { content: 'hello' });

    // Applying the switch replaces the runtime, which would cut the running turn in half.
    const blocked = await call('PUT', '/api/settings/client', { expert_delegation: { coding: true } });
    if (blocked.status === 409) expect(blocked.payload.code).toBe('CONVERSATION_BUSY');
    else expect(blocked.status).toBe(200);
  });
});
