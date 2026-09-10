import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { DshApiServer } from '../../../packages/dsh-bridge/src';
import type {
  BridgePermissionDecision,
  BridgePermissionRequest,
  BridgeUpdate,
  DshAgentPort,
  OfficeDocumentType,
  OfficePreviewPort,
} from '../../../packages/dsh-bridge/src';

const cleanups: Array<() => Promise<void>> = [];

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.restoreAllMocks();
});

async function createServer(
  env?: NodeJS.ProcessEnv,
  officePreviewPort?: OfficePreviewPort,
  options?: {
    authToken?: string;
    prewarmMode?: 'office' | 'coding' | 'research' | false;
    portOverrides?: Partial<DshAgentPort>;
  }
) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-api-server-'));
  let emitUpdate: ((update: BridgeUpdate) => void) | undefined;
  let requestPermission: ((request: BridgePermissionRequest) => Promise<BridgePermissionDecision>) | undefined;
  const sessions = new Map<string, string>();
  const setConfigCalls: Array<{ sessionId: string; configId: string; value: string }> = [];
  const sessionMcpServers: unknown[][] = [];
  const prompts: string[] = [];
  const port: DshAgentPort = {
    initialize: async () => ({ protocolVersion: 1, capabilities: {} }),
    newSession: async (cwd, mcpServers) => {
      sessions.set('session-1', cwd);
      sessionMcpServers.push([...(mcpServers ?? [])]);
      return { sessionId: 'session-1', configOptions: [] };
    },
    resumeSession: async (_sessionId, _cwd, mcpServers) => {
      sessionMcpServers.push([...(mcpServers ?? [])]);
      return { configOptions: [] };
    },
    closeSession: async () => undefined,
    prompt: async (sessionId, prompt) => {
      const conversationId = sessions.get(sessionId) ?? '';
      prompts.push(prompt[0]?.text ?? '');
      if (prompt[0]?.text === 'use tool') {
        await requestPermission?.({
          conversationId,
          sessionId,
          toolCall: { toolCallId: 'call-1', title: 'Write file' },
          options: [{ optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' }],
        });
      }
      emitUpdate?.({
        conversationId,
        sessionId,
        sequence: 1,
        kind: 'assistant-text',
        payload: { content: { text: 'DIRECT_OK' } },
      });
      return { stopReason: 'end_turn' };
    },
    cancel: async () => undefined,
    setConfigOption: async (sessionId, configId, value) => {
      setConfigCalls.push({ sessionId, configId, value });
      return [];
    },
    bindSession: (sessionId, conversationId) => sessions.set(sessionId, conversationId),
    dispose: async () => undefined,
    ...options?.portOverrides,
  };
  const server = new DshApiServer({
    cwd: root,
    dshHome: join(root, 'dsh'),
    dataFile: join(root, 'state.json'),
    agentPortFactory: (handlers) => {
      emitUpdate = handlers.onUpdate;
      requestPermission = handlers.onPermissionRequest;
      return port;
    },
    env,
    officePreviewPort,
    authToken: options?.authToken,
    prewarmMode: options?.prewarmMode ?? false,
  });
  const serverPort = await server.start();
  cleanups.push(async () => {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  });
  return {
    baseUrl: `http://127.0.0.1:${serverPort}`,
    root,
    serverPort,
    setConfigCalls,
    sessionMcpServers,
    prompts,
<<<<<<< HEAD
    port,
=======
>>>>>>> bc237b88135c02f5fff8c017bcef5645267a5591
  };
}

describe('direct DeepSeek Harness HTTP backend', () => {
  it('prewarms the configured runtime when the API server starts', async () => {
    const initialize = vi.fn(async () => ({ protocolVersion: 1, capabilities: {} }));
    await createServer(undefined, undefined, {
      prewarmMode: 'coding',
      portOverrides: { initialize },
    });

    await vi.waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
  });

  it('prepares a conversation session in the background and reuses it for ensure', async () => {
    const newSession = vi.fn(async () => ({ sessionId: 'prepared-session', configOptions: [] }));
    const { baseUrl } = await createServer(undefined, undefined, {
      prewarmMode: 'office',
      portOverrides: { newSession },
    });
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assistant: { id: 'dsh:office' }, extra: {} }),
      })
    ).json()) as { data: { id: string } };

    await vi.waitFor(() => expect(newSession).toHaveBeenCalledTimes(1));
    const ensured = await fetch(`${baseUrl}/api/conversations/${created.data.id}/runtime/ensure`, { method: 'POST' });

    expect(ensured.status).toBe(200);
    expect(newSession).toHaveBeenCalledTimes(1);
  });

  it('includes complete context in background session latency events', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { baseUrl } = await createServer();
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assistant: { id: 'dsh:office' }, extra: {} }),
      })
    ).json()) as { data: { id: string } };
    await fetch(`${baseUrl}/api/conversations/${created.data.id}/runtime/ensure`, { method: 'POST' });

    const event = info.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.startsWith('[dsh-latency] '))
      .map((line) => JSON.parse(line.slice('[dsh-latency] '.length)) as Record<string, unknown>)
      .find((candidate) => candidate.stage === 'session_ready');
    expect(event).toMatchObject({
      conversation_id: created.data.id,
      work_mode: 'office',
      cold_runtime: true,
      resumed_session: false,
      mcp_count: 0,
      elapsed_ms: expect.any(Number),
    });
  });

  it('deduplicates concurrent runtime ensure and first-message session startup', async () => {
    const sessionReady = deferred<{ sessionId: string; configOptions: [] }>();
    let newSessionCalls = 0;
    const { baseUrl } = await createServer(undefined, undefined, {
      portOverrides: {
        newSession: async () => {
          newSessionCalls += 1;
          return await sessionReady.promise;
        },
      },
    });
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extra: {} }),
      })
    ).json()) as { data: { id: string } };

    const ensured = fetch(`${baseUrl}/api/conversations/${created.data.id}/runtime/ensure`, { method: 'POST' });
    await vi.waitFor(() => expect(newSessionCalls).toBe(1));
    const sent = await fetch(`${baseUrl}/api/conversations/${created.data.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });
    expect(sent.status).toBe(202);
    expect(newSessionCalls).toBe(1);

    sessionReady.resolve({ sessionId: 'shared-session', configOptions: [] });
    expect((await ensured).status).toBe(200);
  });

  it('clears a failed session startup so runtime ensure can retry', async () => {
    let newSessionCalls = 0;
    const { baseUrl } = await createServer(undefined, undefined, {
      portOverrides: {
        newSession: async () => {
          newSessionCalls += 1;
          if (newSessionCalls === 1) throw new Error('session startup failed');
          return { sessionId: 'retry-session', configOptions: [] };
        },
      },
    });
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extra: {} }),
      })
    ).json()) as { data: { id: string } };

    const first = await fetch(`${baseUrl}/api/conversations/${created.data.id}/runtime/ensure`, { method: 'POST' });
    const second = await fetch(`${baseUrl}/api/conversations/${created.data.id}/runtime/ensure`, { method: 'POST' });

    expect(first.status).toBe(500);
    expect(second.status).toBe(200);
    expect(newSessionCalls).toBe(2);
  });

  it('closes a partially configured session before retrying initialization', async () => {
    let newSessionCalls = 0;
    let setConfigCalls = 0;
    const closedSessions: string[] = [];
    const { baseUrl } = await createServer(undefined, undefined, {
      portOverrides: {
        newSession: async () => {
          newSessionCalls += 1;
          return { sessionId: `session-${newSessionCalls}`, configOptions: [] };
        },
        setConfigOption: async () => {
          setConfigCalls += 1;
          if (setConfigCalls === 1) throw new Error('config failed');
          return [];
        },
        closeSession: async (sessionId) => {
          closedSessions.push(sessionId);
        },
      },
    });
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extra: {} }),
      })
    ).json()) as { data: { id: string } };

    const first = await fetch(`${baseUrl}/api/conversations/${created.data.id}/runtime/ensure`, { method: 'POST' });
    const second = await fetch(`${baseUrl}/api/conversations/${created.data.id}/runtime/ensure`, { method: 'POST' });

    expect(first.status).toBe(500);
    expect(second.status).toBe(200);
    expect(newSessionCalls).toBe(2);
    expect(closedSessions).toEqual(['session-1']);
  });

  it('emits runtime initialization before a cold session becomes ready', async () => {
    const sessionReady = deferred<{ sessionId: string; configOptions: [] }>();
    const { baseUrl, serverPort } = await createServer(undefined, undefined, {
      portOverrides: { newSession: async () => await sessionReady.promise },
    });
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extra: {} }),
      })
    ).json()) as { data: { id: string } };
    const socket = new WebSocket(`ws://127.0.0.1:${serverPort}/ws`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    const initializing = new Promise<{ type: string; data: { phase: string } }>((resolve) => {
      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString()) as { name: string; data: { type: string; data: { phase?: string } } };
        if (frame.name === 'message.stream' && frame.data.data.phase === 'runtime_initializing') {
          resolve(frame.data as { type: string; data: { phase: string } });
        }
      });
    });

    const sent = await fetch(`${baseUrl}/api/conversations/${created.data.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });
    const event = await initializing;
    expect(sent.status).toBe(202);
    expect(event).toMatchObject({ type: 'start', data: { phase: 'runtime_initializing' } });
    sessionReady.resolve({ sessionId: 'session-1', configOptions: [] });
    socket.close();
  });

  it('rejects runtime restart while a conversation turn is active', async () => {
    const promptGate = deferred<void>();
    const { baseUrl } = await createServer(undefined, undefined, {
      portOverrides: {
        prompt: async () => {
          await promptGate.promise;
          return { stopReason: 'end_turn' };
        },
      },
    });
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extra: {} }),
      })
    ).json()) as { data: { id: string } };

    const sent = await fetch(`${baseUrl}/api/conversations/${created.data.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });
    const restarted = await fetch(`${baseUrl}/api/conversations/${created.data.id}/runtime/restart`, {
      method: 'POST',
    });
    const body = (await restarted.json()) as { code: string };
    promptGate.resolve(undefined);

    expect(sent.status).toBe(202);
    expect(restarted.status).toBe(409);
    expect(body.code).toBe('CONVERSATION_BUSY');
  });

  it('skips matching startup config and maps thought level to ACP reasoning effort', async () => {
    const modelValue = '["deepseek-official","deepseek-v4-flash"]';
    const { baseUrl, setConfigCalls } = await createServer(undefined, undefined, {
      portOverrides: {
        newSession: async () => ({
          sessionId: 'session-1',
          configOptions: [
            { id: 'model', currentValue: modelValue },
            { id: 'reasoning_effort', currentValue: 'high' },
          ],
        }),
      },
    });
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assistant: {
            id: 'dsh:office',
            conversation_overrides: { model: 'deepseek-v4-flash', permission: 'bypass', thought_level: 'low' },
          },
          extra: {},
        }),
      })
    ).json()) as { data: { id: string } };

    const ensured = await fetch(`${baseUrl}/api/conversations/${created.data.id}/runtime/ensure`, { method: 'POST' });
    expect(ensured.status).toBe(200);
    expect(setConfigCalls).toEqual([{ sessionId: 'session-1', configId: 'reasoning_effort', value: 'low' }]);
  });

  it('starts a first-run session without a custom DeepSeek gateway', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-first-run-'));
    const env = { ...process.env };
    delete env.DEEPSEEK_API_KEY;
    delete env.DEEPSEEK_BASE_URL;
    delete env.DEEPSEEK_URL;
    const server = new DshApiServer({
      cwd: root,
      dshHome: join(root, 'dsh'),
      dataFile: join(root, 'state.json'),
      patchPaths: [resolvePath('.aionui/dsh-aionui.patch.yml')],
      env,
    });
    cleanups.push(async () => {
      await server.stop();
      await rm(root, { recursive: true, force: true });
    });

    const serverPort = await server.start();
    const createResponse = await fetch(`http://127.0.0.1:${serverPort}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ extra: { workspace: root } }),
    });
    const created = (await createResponse.json()) as { data: { id: string } };
    const ensureResponse = await fetch(
      `http://127.0.0.1:${serverPort}/api/conversations/${created.data.id}/runtime/ensure`,
      { method: 'POST' }
    );

    expect(ensureResponse.status).toBe(200);
    const ensured = (await ensureResponse.json()) as {
      success: boolean;
      data: { config_options: Array<{ id: string; current_value: string }> };
    };
    expect(ensured.success).toBe(true);
    expect(ensured.data.config_options.find((option) => option.id === 'model')?.current_value).toBe(
      'deepseek-v4-flash'
    );
  }, 30_000);

  it('starts a session through the OpenAI-compatible gateway adapter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-gateway-'));
    const modelsServer = createHttpServer((request, response) => {
      expect(request.url).toBe('/v1/models');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'zai-org/GLM-5.3' }] }));
    });
    await new Promise<void>((resolveListen) => modelsServer.listen(0, '127.0.0.1', resolveListen));
    const address = modelsServer.address();
    if (!address || typeof address === 'string') throw new Error('Gateway fixture server did not start.');
    const server = new DshApiServer({
      cwd: root,
      dshHome: join(root, 'dsh'),
      dataFile: join(root, 'state.json'),
      patchPaths: [resolvePath('.aionui/dsh-aionui.patch.yml')],
      env: {
        DEEPSEEK_URL: `http://127.0.0.1:${address.port}/v1`,
        DEEPSEEK_API_KEY: 'gateway-api-key',
      },
    });
    cleanups.push(async () => {
      await server.stop();
      await new Promise<void>((resolveClose) => modelsServer.close(() => resolveClose()));
      await rm(root, { recursive: true, force: true });
    });

    const serverPort = await server.start();
    const created = (await (
      await fetch(`http://127.0.0.1:${serverPort}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extra: { workspace: root } }),
      })
    ).json()) as { data: { id: string } };
    const ensureResponse = await fetch(
      `http://127.0.0.1:${serverPort}/api/conversations/${created.data.id}/runtime/ensure`,
      { method: 'POST' }
    );
    const ensured = (await ensureResponse.json()) as {
      data: { config_options: Array<{ id: string; current_value: string }> };
    };

    expect(ensureResponse.status).toBe(200);
    expect(ensured.data.config_options.find((option) => option.id === 'model')?.current_value).toBe('zai-org/GLM-5.3');
  }, 30_000);

  it('uses the official provider when switching models without a gateway', async () => {
    const { baseUrl, setConfigCalls } = await createServer();
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extra: {} }),
      })
    ).json()) as { data: { id: string } };
    await fetch(`${baseUrl}/api/conversations/${created.data.id}/runtime/ensure`, { method: 'POST' });

    await fetch(`${baseUrl}/api/conversations/${created.data.id}/config-options/model`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'deepseek-v4-pro' }),
    });

    expect(setConfigCalls.at(-1)?.value).toBe('["deepseek-official","deepseek-v4-pro"]');
  });

  it('stores a provider without returning or persisting its API key', async () => {
    const modelsServer = createHttpServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'deepseek-chat' }] }));
    });
    await new Promise<void>((resolve) => modelsServer.listen(0, '127.0.0.1', resolve));
    const address = modelsServer.address();
    if (!address || typeof address === 'string') throw new Error('Provider fixture server did not start.');
    cleanups.push(() => new Promise<void>((resolve) => modelsServer.close(() => resolve())));
    const { baseUrl, root } = await createServer({});

    const response = await fetch(`${baseUrl}/api/providers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'provider-1',
        platform: 'custom',
        name: 'DeepSeek',
        base_url: `http://127.0.0.1:${address.port}/v1`,
        api_key: 'secret-provider-key',
        models: ['deepseek-chat'],
      }),
    });
    const created = (await response.json()) as {
      data: { api_key: string; has_api_key: boolean; api_key_hint: string };
    };

    expect(response.status).toBe(201);
    expect(created.data).toMatchObject({ api_key: '', has_api_key: true, api_key_hint: '...-key' });
    expect(await readFile(join(root, 'state.json'), 'utf8')).not.toContain('secret-provider-key');
  });

  it('keeps a stored API key when an edit sends an empty key', async () => {
    let authorization = '';
    const modelsServer = createHttpServer((request, response) => {
      authorization = String(request.headers.authorization ?? '');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'deepseek-chat' }] }));
    });
    await new Promise<void>((resolve) => modelsServer.listen(0, '127.0.0.1', resolve));
    const address = modelsServer.address();
    if (!address || typeof address === 'string') throw new Error('Provider fixture server did not start.');
    cleanups.push(() => new Promise<void>((resolve) => modelsServer.close(() => resolve())));
    const { baseUrl } = await createServer({});
    await fetch(`${baseUrl}/api/providers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'provider-1',
        platform: 'custom',
        name: 'Before',
        base_url: `http://127.0.0.1:${address.port}/v1`,
        api_key: 'preserved-key',
        models: ['deepseek-chat'],
      }),
    });

    await fetch(`${baseUrl}/api/providers/provider-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'After', api_key: '' }),
    });
    authorization = '';
    const modelsResponse = await fetch(`${baseUrl}/api/providers/provider-1/models`, { method: 'POST' });

    expect(modelsResponse.status).toBe(200);
    expect(authorization).toBe('Bearer preserved-key');
  });

  it('clears a stored API key only when explicitly requested', async () => {
    const { baseUrl } = await createServer({});
    const provider = (id: string) => ({
      id,
      platform: 'custom',
      name: id,
      base_url: 'http://127.0.0.1:3000/v1',
      api_key: `${id}-key`,
      models: ['deepseek-chat'],
    });
    await fetch(`${baseUrl}/api/providers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(provider('default-provider')),
    });
    await fetch(`${baseUrl}/api/providers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(provider('secondary-provider')),
    });

    const response = await fetch(`${baseUrl}/api/providers/secondary-provider`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clear_api_key: true }),
    });
    const updated = (await response.json()) as { data: { api_key: string; has_api_key: boolean } };

    expect(response.status).toBe(200);
    expect(updated.data).toMatchObject({ api_key: '', has_api_key: false });
  });

  it('uses a selected UI provider when encoding a model for DeepSeek Harness', async () => {
    const modelsServer = createHttpServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'deepseek-chat' }] }));
    });
    await new Promise<void>((resolve) => modelsServer.listen(0, '127.0.0.1', resolve));
    const address = modelsServer.address();
    if (!address || typeof address === 'string') throw new Error('Provider fixture server did not start.');
    cleanups.push(() => new Promise<void>((resolve) => modelsServer.close(() => resolve())));
    const { baseUrl, setConfigCalls } = await createServer({});
    await fetch(`${baseUrl}/api/providers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'provider-1',
        platform: 'custom',
        name: 'DeepSeek',
        base_url: `http://127.0.0.1:${address.port}/v1`,
        api_key: 'provider-key',
        models: ['deepseek-chat'],
      }),
    });
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extra: {} }),
      })
    ).json()) as { data: { id: string } };
    await fetch(`${baseUrl}/api/conversations/${created.data.id}/runtime/ensure`, { method: 'POST' });
    await fetch(`${baseUrl}/api/conversations/${created.data.id}/config-options/model`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'deepseek-chat' }),
    });

    expect(setConfigCalls.at(-1)?.value).toBe('["aionui-gateway","deepseek-chat"]');
  });

  it('rejects provider access without the internal backend token', async () => {
    const { baseUrl } = await createServer(undefined, undefined, { authToken: 'internal-token' });

    const denied = await fetch(`${baseUrl}/api/providers`);
    const allowed = await fetch(`${baseUrl}/api/providers`, {
      headers: { 'X-AionUI-Backend-Token': 'internal-token' },
    });

    expect(denied.status).toBe(401);
    expect(allowed.status).toBe(200);
  });

  it('loads pure model ids from /v1/models and only encodes the provider when setting dsh config', async () => {
    let authorization = '';
    const modelsServer = createHttpServer((request, response) => {
      authorization = String(request.headers.authorization ?? '');
      expect(request.url).toBe('/v1/models');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          data: [{ id: 'deepseek-ai/DeepSeek-V4-Flash' }, { id: 'deepseek-ai/DeepSeek-V4-Pro' }],
        })
      );
    });
    await new Promise<void>((resolve) => modelsServer.listen(0, '127.0.0.1', resolve));
    const address = modelsServer.address();
    if (!address || typeof address === 'string') throw new Error('Model fixture server did not start.');
    cleanups.push(() => new Promise<void>((resolve) => modelsServer.close(() => resolve())));

    const { baseUrl, setConfigCalls } = await createServer({
      DEEPSEEK_URL: `http://127.0.0.1:${address.port}/v1`,
      DEEPSEEK_API_KEY: 'model-api-key',
    });
    const agents = (await (await fetch(`${baseUrl}/api/agents`)).json()) as {
      data: Array<{
        available_models: {
          current_model_id: string;
          available_models: Array<{ id: string; label: string }>;
        };
      }>;
    };
    expect(authorization).toBe('Bearer model-api-key');
    expect(agents.data[0].available_models.current_model_id).toBe('deepseek-ai/DeepSeek-V4-Flash');
    expect(agents.data[0].available_models.available_models).toEqual([
      { id: 'deepseek-ai/DeepSeek-V4-Flash', label: 'deepseek-ai/DeepSeek-V4-Flash' },
      { id: 'deepseek-ai/DeepSeek-V4-Pro', label: 'deepseek-ai/DeepSeek-V4-Pro' },
    ]);

    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extra: {} }),
      })
    ).json()) as { data: { id: string; extra: { current_model_id: string } } };
    expect(created.data.extra.current_model_id).toBe('deepseek-ai/DeepSeek-V4-Flash');

    const ensured = (await (
      await fetch(`${baseUrl}/api/conversations/${created.data.id}/runtime/ensure`, { method: 'POST' })
    ).json()) as {
      data: { config_options: Array<{ id: string; current_value: string; options: Array<{ value: string }> }> };
    };
    const modelOption = ensured.data.config_options.find((option) => option.id === 'model');
    expect(modelOption?.current_value).toBe('deepseek-ai/DeepSeek-V4-Flash');
    expect(modelOption?.options.map((option) => option.value)).toEqual([
      'deepseek-ai/DeepSeek-V4-Flash',
      'deepseek-ai/DeepSeek-V4-Pro',
    ]);

    const switched = (await (
      await fetch(`${baseUrl}/api/conversations/${created.data.id}/config-options/model`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'deepseek-ai/DeepSeek-V4-Pro' }),
      })
    ).json()) as { data: { confirmation: string; config_options: Array<{ id: string; current_value: string }> } };
    expect(setConfigCalls.at(-1)?.value).toBe('["aionui-gateway","deepseek-ai/DeepSeek-V4-Pro"]');
    expect(switched.data.confirmation).toBe('observed');
    expect(switched.data.config_options.find((option) => option.id === 'model')?.current_value).toBe(
      'deepseek-ai/DeepSeek-V4-Pro'
    );
  });

  it('serializes concurrent state writes', async () => {
    const { baseUrl } = await createServer();
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        fetch(`${baseUrl}/api/settings/client`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [`concurrent.${index}`]: index }),
        })
      )
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
  });

  it('returns the AionUI assistant list contract without render-unsafe model objects', async () => {
    const { baseUrl } = await createServer();
    const response = await fetch(`${baseUrl}/api/assistants`);
    const body = (await response.json()) as {
      data: Array<{
        source: string;
        models: unknown[];
        agent: { type: string; acp_backend: string };
        name_i18n: Record<string, string>;
      }>;
    };

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(3);
    expect(body.data.map((assistant) => assistant.agent.acp_backend)).toEqual([
      'dsh:office',
      'dsh:coding',
      'dsh:research',
    ]);
    expect(body.data.every((assistant) => assistant.models.every((model) => typeof model === 'string'))).toBe(true);

    const detailResponse = await fetch(`${baseUrl}/api/assistants/dsh%3Adeepseek-harness`);
    const detail = (await detailResponse.json()) as {
      data: { defaults: { model: { mode: string; value: string } }; preferences: { last_mcp_ids: string[] } };
    };
    expect(detail.data.defaults.model).toMatchObject({ mode: 'fixed' });
    expect(typeof detail.data.defaults.model.value).toBe('string');
    expect(detail.data.preferences.last_mcp_ids).toEqual([]);
  });

  it('imports a skill and injects an assistant default only once per dsh session', async () => {
    const { baseUrl, root, prompts } = await createServer();
    const source = join(root, 'skill-source');
    await mkdir(source, { recursive: true });
    await writeFile(
      join(source, 'SKILL.md'),
      '---\nname: concise-summary\ndescription: Summarize precisely\n---\nDo it.\n'
    );

    const imported = await fetch(`${baseUrl}/api/skills/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skill_path: source }),
    });
    const listed = (await (await fetch(`${baseUrl}/api/skills`)).json()) as {
      data: Array<{ name: string; source: string }>;
    };
    expect(imported.status).toBe(201);
    expect(listed.data).toContainEqual(expect.objectContaining({ name: 'concise-summary', source: 'custom' }));

    await fetch(`${baseUrl}/api/assistants/dsh%3Acoding`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled_skills: ['concise-summary'],
        defaults: { skills: { mode: 'fixed', value: ['concise-summary'] } },
      }),
    });
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assistant: { id: 'dsh:coding' }, extra: {} }),
      })
    ).json()) as { data: { id: string } };

    for (const content of ['first', 'second']) {
      // Requests must remain sequential to verify injection state after the first completed turn.
      // eslint-disable-next-line no-await-in-loop
      await fetch(`${baseUrl}/api/conversations/${created.data.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(prompts[0]).toContain('/concise-summary');
    expect(prompts[1]).toBe('second');
  });

  it('scans and materializes an imported skill for a conversation', async () => {
    const { baseUrl, root } = await createServer();
    const source = join(root, 'scan-source');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'SKILL.md'), '---\nname: scan-skill\ndescription: Scanned skill\n---\nUse it.\n');

    const scanned = (await (
      await fetch(`${baseUrl}/api/skills/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder_path: source }),
      })
    ).json()) as { data: Array<{ name: string }> };
    await fetch(`${baseUrl}/api/skills/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skill_path: source }),
    });
    const conversation = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assistant: { id: 'dsh:office' }, extra: {} }),
      })
    ).json()) as { data: { id: string } };
    const materialized = (await (
      await fetch(`${baseUrl}/api/skills/materialize-for-agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: conversation.data.id, skills: ['scan-skill'] }),
      })
    ).json()) as { data: { skills: Array<{ name: string; source_path: string }> } };

    expect(scanned.data).toEqual([expect.objectContaining({ name: 'scan-skill' })]);
    expect(materialized.data.skills[0]).toMatchObject({ name: 'scan-skill' });
    expect(materialized.data.skills[0].source_path).toContain('SKILL.md');
  });

  it('keeps MCP secrets out of persisted state and hydrates them for the selected session', async () => {
    const { baseUrl, root, sessionMcpServers } = await createServer();
    const createdServer = (await (
      await fetch(`${baseUrl}/api/mcp/servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'fixture-mcp',
          enabled: true,
          transport: { type: 'stdio', command: process.execPath, args: ['fixture.js'], env: { MCP_SECRET: 'secret' } },
          original_json: '{"secret":"secret"}',
        }),
      })
    ).json()) as { data: { id: string } };
    const conversation = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assistant: { id: 'dsh:office', conversation_overrides: { mcp_ids: [createdServer.data.id] } },
          extra: {},
        }),
      })
    ).json()) as { data: { id: string } };

    const ensured = await fetch(`${baseUrl}/api/conversations/${conversation.data.id}/runtime/ensure`, {
      method: 'POST',
    });

    expect(ensured.status).toBe(200);
    expect(JSON.stringify(sessionMcpServers[0])).toContain('secret');
    expect(await readFile(join(root, 'state.json'), 'utf8')).not.toContain('secret');
  });

  it('rolls back a conflicting MCP batch import', async () => {
    const { baseUrl } = await createServer();
    const response = await fetch(`${baseUrl}/api/mcp/servers/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        servers: [
          { name: 'duplicate-mcp', transport: { type: 'stdio', command: process.execPath } },
          { name: 'duplicate-mcp', transport: { type: 'stdio', command: process.execPath } },
        ],
      }),
    });
    const listed = (await (await fetch(`${baseUrl}/api/mcp/servers`)).json()) as { data: unknown[] };

    expect(response.status).toBe(409);
    expect(listed.data).toEqual([]);
  });

  it('uses the conversation MCP snapshot after the global enabled state changes', async () => {
    const { baseUrl, sessionMcpServers } = await createServer();
    const server = (await (
      await fetch(`${baseUrl}/api/mcp/servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'snapshot-mcp',
          enabled: true,
          transport: { type: 'stdio', command: process.execPath, args: [] },
        }),
      })
    ).json()) as { data: { id: string } };
    await fetch(`${baseUrl}/api/assistants/dsh:office`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaults: { mcps: { mode: 'auto', value: [] } } }),
    });
    const conversation = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assistant: { id: 'dsh:office' }, extra: {} }),
      })
    ).json()) as { data: { id: string } };
    await fetch(`${baseUrl}/api/mcp/servers/${server.data.id}/toggle`, { method: 'POST' });

    await fetch(`${baseUrl}/api/conversations/${conversation.data.id}/runtime/ensure`, { method: 'POST' });

    expect(JSON.stringify(sessionMcpServers[0])).toContain('snapshot-mcp');
  });

  it('rejects an SSE MCP before creating the dsh session', async () => {
    const { baseUrl, sessionMcpServers } = await createServer();
    const server = (await (
      await fetch(`${baseUrl}/api/mcp/servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'legacy-sse', transport: { type: 'sse', url: 'https://example.com/sse' } }),
      })
    ).json()) as { data: { id: string } };
    const conversation = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assistant: { id: 'dsh:office', conversation_overrides: { mcp_ids: [server.data.id] } },
          extra: {},
        }),
      })
    ).json()) as { data: { id: string } };

    const response = await fetch(`${baseUrl}/api/conversations/${conversation.data.id}/runtime/ensure`, {
      method: 'POST',
    });

    expect(response.status).toBe(400);
    expect(sessionMcpServers).toHaveLength(0);
  });

  it('persists the selected work mode on new conversations', async () => {
    const { baseUrl } = await createServer();
    const response = await fetch(`${baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assistant: { id: 'dsh:coding' }, extra: {} }),
    });
    const created = (await response.json()) as {
      data: { assistant: { id: string }; extra: { work_mode: string } };
    };

    expect(created.data.assistant.id).toBe('dsh:coding');
    expect(created.data.extra.work_mode).toBe('coding');
  });

  it('persists research mode as an isolated conversation runtime', async () => {
    const { baseUrl } = await createServer();
    const response = await fetch(`${baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assistant: { id: 'dsh:research' }, extra: {} }),
    });
    const created = (await response.json()) as {
      data: { assistant: { id: string }; extra: { work_mode: string } };
    };

    expect(response.status).toBe(201);
    expect(created.data.assistant.id).toBe('dsh:research');
    expect(created.data.extra.work_mode).toBe('research');
  });

  it('does not allow a conversation work mode to change through extra updates', async () => {
    const { baseUrl } = await createServer();
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assistant: { id: 'dsh:coding' }, extra: {} }),
      })
    ).json()) as { data: { id: string } };

    const updateResponse = await fetch(`${baseUrl}/api/conversations/${created.data.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ extra: { work_mode: 'office' } }),
    });
    const conversation = (await (await fetch(`${baseUrl}/api/conversations/${created.data.id}`)).json()) as {
      data: { extra: { work_mode: string } };
    };

    expect(updateResponse.status).toBe(200);
    expect(conversation.data.extra.work_mode).toBe('coding');
  });

  it('maps the legacy assistant id to coding mode', async () => {
    const { baseUrl } = await createServer();
    const response = await fetch(`${baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assistant: { id: 'dsh:deepseek-harness' }, extra: {} }),
    });
    const created = (await response.json()) as { data: { extra: { work_mode: string } } };

    expect(response.status).toBe(201);
    expect(created.data.extra.work_mode).toBe('coding');
  });

  it('rejects unknown assistant ids instead of silently changing modes', async () => {
    const { baseUrl } = await createServer();
    const response = await fetch(`${baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assistant: { id: 'dsh:unknown' }, extra: {} }),
    });
    const body = (await response.json()) as { code: string };

    expect(response.status).toBe(400);
    expect(body.code).toBe('INVALID_ASSISTANT');
  });

  it('creates a conversation and persists a completed assistant turn', async () => {
    const { baseUrl } = await createServer();
    const createdResponse = await fetch(`${baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Direct', extra: {} }),
    });
    const created = (await createdResponse.json()) as { data: { id: string } };

    const sendResponse = await fetch(`${baseUrl}/api/conversations/${created.data.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });
    expect(sendResponse.status).toBe(202);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const messagesResponse = await fetch(`${baseUrl}/api/conversations/${created.data.id}/messages`);
    const messages = (await messagesResponse.json()) as {
      data: { items: Array<{ position: string; content: { content: string } }> };
    };
    expect(messages.data.items.map((item) => item.position)).toEqual(['right', 'left']);
    expect(messages.data.items[1].content.content).toBe('DIRECT_OK');

    const latestPlanResponse = await fetch(`${baseUrl}/api/conversations/${created.data.id}/messages/latest?type=plan`);
    const latestPlan = (await latestPlanResponse.json()) as { data: unknown };
    expect(latestPlanResponse.status).toBe(200);
    expect(latestPlan.data).toBeNull();
  });

  it('aligns the conversation, project explorer, and file preview to one workspace', async () => {
    const { baseUrl, root, serverPort } = await createServer();
    await writeFile(join(root, 'hello.txt'), 'hello workspace', 'utf8');
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extra: { workspace: root } }),
      })
    ).json()) as { data: { project_id: string; extra: { workspace: string } } };

    expect(created.data.project_id).toBeTruthy();
    expect(created.data.extra.workspace).toBe(root);
    const project = (await (await fetch(`${baseUrl}/api/projects/${created.data.project_id}`)).json()) as {
      data: { explorer: { workspace_pe_id: string; entries: Array<{ pe_id: string; display_path: string }> } };
    };
    const peId = project.data.explorer.workspace_pe_id;
    expect(project.data.explorer.entries[0]).toMatchObject({ pe_id: peId, display_path: root });

    const content = await fetch(`${baseUrl}/api/fs/content`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file: { kind: 'project', pe_id: peId, relative_path: 'hello.txt' },
        encoding: 'utf8',
      }),
    });
    expect(((await content.json()) as { data: string }).data).toBe('hello workspace');

    const escaped = await fetch(`${baseUrl}/api/fs/content`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file: { kind: 'project', pe_id: peId, relative_path: '../outside.txt' },
        encoding: 'utf8',
      }),
    });
    expect(escaped.status).toBe(500);

    const socket = new WebSocket(`ws://127.0.0.1:${serverPort}/ws`);
    const response = await new Promise<{ name: string; data: { id: number; result: { snapshots: unknown[] } } }>(
      (resolve, reject) => {
        socket.once('error', reject);
        socket.once('open', () => {
          socket.send(
            JSON.stringify({
              name: 'fs',
              data: {
                jsonrpc: '2.0',
                id: 1,
                method: 'fs/subscribe',
                params: { targets: [{ pe_id: peId, relative_path: '' }] },
              },
            })
          );
        });
        socket.once('message', (raw) => resolve(JSON.parse(raw.toString())));
      }
    );
    socket.close();
    expect(response.name).toBe('fs');
    expect(response.data.id).toBe(1);
    expect(response.data.result.snapshots).toEqual([
      {
        target: { pe_id: peId, relative_path: '' },
        entries: expect.arrayContaining([{ name: 'hello.txt', kind: 'file' }]),
      },
    ]);
  });

  it('serves a multi-file workspace preview and invalidates its URL when stopped', async () => {
    const { baseUrl, root } = await createServer();
    await mkdir(join(root, 'site'));
    await writeFile(
      join(root, 'site', 'index.html'),
      '<!doctype html><link rel="stylesheet" href="style.css"><main>preview ready</main>',
      'utf8'
    );
    await writeFile(join(root, 'site', 'style.css'), 'main { color: red; }', 'utf8');
    await writeFile(join(root, 'site', '.env'), 'SECRET=hidden', 'utf8');
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extra: { workspace: root } }),
      })
    ).json()) as { data: { project_id: string } };
    const project = (await (await fetch(`${baseUrl}/api/projects/${created.data.project_id}`)).json()) as {
      data: { explorer: { workspace_pe_id: string } };
    };
    const peId = project.data.explorer.workspace_pe_id;
    const started = await fetch(`${baseUrl}/api/workspace-preview/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entry: { kind: 'project', pe_id: peId, relative_path: 'site/index.html' },
      }),
    });
    const preview = (await started.json()) as { data: { session_id: string; url: string } };

    const html = await fetch(preview.data.url);
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await html.text()).toContain('preview ready');

    const stylesheet = await fetch(new URL('style.css', preview.data.url));
    expect(stylesheet.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(stylesheet.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await stylesheet.text()).toContain('color: red');

    const head = await fetch(preview.data.url, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');

    const routeFallback = await fetch(new URL('game/level/1', preview.data.url), {
      headers: { Accept: 'text/html' },
    });
    expect(routeFallback.status).toBe(200);
    expect(await routeFallback.text()).toContain('preview ready');

    const secret = await fetch(new URL('.env', preview.data.url));
    expect(secret.status).toBe(403);
    await fetch(`${baseUrl}/api/workspace-preview/${preview.data.session_id}`, { method: 'DELETE' });
    expect((await fetch(preview.data.url)).status).toBe(404);
  });

  it('emits one debounced refresh event when workspace preview files change', async () => {
    const { baseUrl, root, serverPort } = await createServer();
    await writeFile(join(root, 'index.html'), '<!doctype html><main>one</main>', 'utf8');
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extra: { workspace: root } }),
      })
    ).json()) as { data: { project_id: string } };
    const project = (await (await fetch(`${baseUrl}/api/projects/${created.data.project_id}`)).json()) as {
      data: { explorer: { workspace_pe_id: string } };
    };
    const started = await fetch(`${baseUrl}/api/workspace-preview/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entry: {
          kind: 'project',
          pe_id: project.data.explorer.workspace_pe_id,
          relative_path: 'index.html',
        },
      }),
    });
    const preview = (await started.json()) as { data: { session_id: string } };
    const socket = new WebSocket(`ws://127.0.0.1:${serverPort}/ws`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });

    const changed = new Promise<{ session_id: string; changed_paths: string[] }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('workspace preview change event timed out')), 3_000);
      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString()) as { name?: string; data?: unknown };
        if (frame.name !== 'workspace-preview.changed') return;
        clearTimeout(timeout);
        resolve(frame.data as { session_id: string; changed_paths: string[] });
      });
    });
    await writeFile(join(root, 'index.html'), '<!doctype html><main>two</main>', 'utf8');
    const event = await changed;
    socket.close();

    expect(event.session_id).toBe(preview.data.session_id);
    expect(event.changed_paths).toContain('index.html');
  });

  it('detects Vite but requires an explicit confirmation token before starting it', async () => {
    const { baseUrl, root } = await createServer();
    await mkdir(join(root, 'node_modules', 'vite'), { recursive: true });
    await writeFile(join(root, 'index.html'), '<!doctype html><main>vite</main>', 'utf8');
    await writeFile(
      join(root, 'dev-server.cjs'),
      "const http=require('node:http');const i=process.argv.indexOf('--port');const port=Number(process.argv[i+1]);http.createServer((_q,r)=>r.end('vite ready')).listen(port,'127.0.0.1');",
      'utf8'
    );
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { dev: 'node dev-server.cjs' }, devDependencies: { vite: '^6.0.0' } }),
      'utf8'
    );
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extra: { workspace: root } }),
      })
    ).json()) as { data: { project_id: string } };
    const project = (await (await fetch(`${baseUrl}/api/projects/${created.data.project_id}`)).json()) as {
      data: { explorer: { workspace_pe_id: string } };
    };
    const peId = project.data.explorer.workspace_pe_id;
    const inspectionResponse = await fetch(`${baseUrl}/api/workspace-preview/inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: { kind: 'project', pe_id: peId, relative_path: '' } }),
    });
    const inspection = (await inspectionResponse.json()) as {
      data: { kind: string; command: string; confirmation_token: string };
    };
    expect(inspection.data.kind).toBe('vite');
    expect(inspection.data.command).toContain('--host 127.0.0.1');

    const unconfirmed = await fetch(`${baseUrl}/api/workspace-preview/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entry: { kind: 'project', pe_id: peId, relative_path: 'index.html' },
        root: { kind: 'project', pe_id: peId, relative_path: '' },
        mode: 'vite',
      }),
    });
    expect(unconfirmed.status).toBe(403);
    expect(await unconfirmed.json()).toMatchObject({ code: 'WORKSPACE_PREVIEW_CONFIRMATION_REQUIRED' });

    const confirmed = await fetch(`${baseUrl}/api/workspace-preview/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entry: { kind: 'project', pe_id: peId, relative_path: 'index.html' },
        root: { kind: 'project', pe_id: peId, relative_path: '' },
        mode: 'vite',
        confirmation_token: inspection.data.confirmation_token,
      }),
    });
    expect(confirmed.status).toBe(200);
    const session = (await confirmed.json()) as { data: { session_id: string; url: string } };
    expect(await (await fetch(session.data.url)).text()).toBe('vite ready');
    await fetch(`${baseUrl}/api/workspace-preview/${session.data.session_id}`, { method: 'DELETE' });

    await expect
      .poll(
        async () => {
          try {
            await fetch(session.data.url, { signal: AbortSignal.timeout(200) });
            return false;
          } catch {
            return true;
          }
        },
        { timeout: 5_000 }
      )
      .toBe(true);
  });

  it('starts and stops OfficeCLI previews using the canonical project file path', async () => {
    const starts: Array<{ filePath: string; documentType: OfficeDocumentType }> = [];
    const stops: string[] = [];
    const officePreviewPort: OfficePreviewPort = {
      start: async (filePath, documentType) => {
        starts.push({ filePath, documentType });
        return { url: 'http://127.0.0.1:32123' };
      },
      stop: async (filePath) => {
        stops.push(filePath);
      },
      dispose: async () => undefined,
    };
    const { baseUrl, root } = await createServer(undefined, officePreviewPort);
    const documentPath = join(root, 'report.docx');
    await writeFile(documentPath, 'fixture', 'utf8');
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extra: { workspace: root } }),
      })
    ).json()) as { data: { project_id: string } };
    const project = (await (await fetch(`${baseUrl}/api/projects/${created.data.project_id}`)).json()) as {
      data: { explorer: { workspace_pe_id: string } };
    };
    const file = {
      kind: 'project',
      pe_id: project.data.explorer.workspace_pe_id,
      relative_path: 'report.docx',
    };

    const started = await fetch(`${baseUrl}/api/word-preview/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file }),
    });
    expect(started.status).toBe(200);
    expect((await started.json()) as unknown).toMatchObject({
      success: true,
      data: { url: 'http://127.0.0.1:32123' },
    });
    expect(starts).toEqual([{ filePath: documentPath, documentType: 'word' }]);

    const stopped = await fetch(`${baseUrl}/api/word-preview/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file }),
    });
    expect(stopped.status).toBe(200);
    expect(stops).toEqual([documentPath]);
  });

  it('rejects legacy Office preview paths outside the declared workspace', async () => {
    const officePreviewPort: OfficePreviewPort = {
      start: async () => ({ url: '' }),
      stop: async () => undefined,
      dispose: async () => undefined,
    };
    const { baseUrl } = await createServer(undefined, officePreviewPort);
    const response = await fetch(`${baseUrl}/api/word-preview/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_path: join(tmpdir(), 'outside.docx') }),
    });
    expect(response.status).toBe(403);
    expect((await response.json()) as unknown).toMatchObject({ code: 'PATH_OUTSIDE_SANDBOX' });
  });

  it('rejects unsupported AionCore-only routes explicitly', async () => {
    const { baseUrl } = await createServer();
    const response = await fetch(`${baseUrl}/api/aioncore-only`);
    const body = (await response.json()) as { code: string };
    expect(response.status).toBe(501);
    expect(body.code).toBe('NOT_IMPLEMENTED');
  });

  it('waits for an AionUI permission decision before continuing the dsh turn', async () => {
    const { baseUrl } = await createServer();
    const createdResponse = await fetch(`${baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ extra: {} }),
    });
    const created = (await createdResponse.json()) as { data: { id: string } };
    await fetch(`${baseUrl}/api/conversations/${created.data.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'use tool' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const waiting = (await (await fetch(`${baseUrl}/api/conversations/${created.data.id}`)).json()) as {
      data: { runtime: { state: string; pending_confirmations: number } };
    };
    expect(waiting.data.runtime).toMatchObject({ state: 'waiting_confirmation', pending_confirmations: 1 });

    const confirmation = await fetch(`${baseUrl}/api/conversations/${created.data.id}/confirmations/call-1/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: 'allow-once' }),
    });
    expect(confirmation.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const completed = (await (await fetch(`${baseUrl}/api/conversations/${created.data.id}`)).json()) as {
      data: { runtime: { state: string; pending_confirmations: number } };
    };
    expect(completed.data.runtime).toMatchObject({ state: 'idle', pending_confirmations: 0 });
  });
});
