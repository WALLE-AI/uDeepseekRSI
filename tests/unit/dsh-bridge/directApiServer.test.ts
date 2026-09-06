import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function createServer(env?: NodeJS.ProcessEnv, officePreviewPort?: OfficePreviewPort) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-api-server-'));
  let emitUpdate: ((update: BridgeUpdate) => void) | undefined;
  let requestPermission: ((request: BridgePermissionRequest) => Promise<BridgePermissionDecision>) | undefined;
  const sessions = new Map<string, string>();
  const setConfigCalls: Array<{ sessionId: string; configId: string; value: string }> = [];
  const port: DshAgentPort = {
    initialize: async () => ({ protocolVersion: 1, capabilities: {} }),
    newSession: async (cwd) => {
      sessions.set('session-1', cwd);
      return { sessionId: 'session-1', configOptions: [] };
    },
    resumeSession: async () => ({ configOptions: [] }),
    closeSession: async () => undefined,
    prompt: async (sessionId, prompt) => {
      const conversationId = sessions.get(sessionId) ?? '';
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
  });
  const serverPort = await server.start();
  cleanups.push(async () => {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  });
  return { baseUrl: `http://127.0.0.1:${serverPort}`, root, serverPort, setConfigCalls };
}

describe('direct DeepSeek Harness HTTP backend', () => {
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
        available_models: { available_models: Array<{ id: string; label: string }> };
      }>;
    };
    expect(authorization).toBe('Bearer model-api-key');
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
    expect(setConfigCalls.at(-1)?.value).toBe('["aionui-deepseek","deepseek-ai/DeepSeek-V4-Pro"]');
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
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      source: 'generated',
      agent: { type: 'acp', acp_backend: 'dsh:deepseek-harness' },
      name_i18n: {},
    });
    expect(body.data[0].models).toHaveLength(1);
    expect(body.data[0].models.every((model) => typeof model === 'string')).toBe(true);

    const detailResponse = await fetch(`${baseUrl}/api/assistants/dsh%3Adeepseek-harness`);
    const detail = (await detailResponse.json()) as {
      data: { defaults: { model: { mode: string; value: string } }; preferences: { last_mcp_ids: string[] } };
    };
    expect(detail.data.defaults.model).toMatchObject({ mode: 'fixed' });
    expect(typeof detail.data.defaults.model.value).toBe('string');
    expect(detail.data.preferences.last_mcp_ids).toEqual([]);
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
