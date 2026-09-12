import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  const root = await mkdtemp(join(tmpdir(), 'dsh-experts-'));
  const sessions = new Map<string, string>();
  const prompts: string[] = [];
  const runtimeKeys: string[] = [];
  const port: DshAgentPort = {
    initialize: async () => ({ protocolVersion: 1, capabilities: {} }),
    newSession: async (cwd) => {
      sessions.set('session-1', cwd);
      return { sessionId: 'session-1', configOptions: [] };
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
  return { root, baseUrl, call, prompts, runtimeKeys, dshHome: join(root, 'dsh'), expertsDir: join(root, 'experts') };
}

const SKILL_DOC = ['---', 'name: dep-graph', 'description: Maps module dependencies', '---', '', 'Use it.'].join('\n');

const agentRequest = (overrides: Record<string, unknown> = {}) => ({
  name: 'repo-surveyor',
  expert_type: 'agent',
  mode: 'coding',
  display_name: { 'zh-CN': '仓库勘察' },
  goal: '定位代码路径、依赖与既有约定',
  method: '1. 读取约定文件\n2. 定位实现',
  output: '结论与关键文件行号，不改代码',
  allowed_tools: ['Read', 'Glob', 'Grep'],
  ...overrides,
});

const teamRequest = (overrides: Record<string, unknown> = {}) => ({
  name: 'rd-team',
  expert_type: 'team',
  mode: 'coding',
  display_name: { 'zh-CN': '研发专家团' },
  lead: { id: 'rd-lead', goal: '澄清需求、拆分任务、汇总交付', allowed_tools: ['Read', 'Task'] },
  members: [{ id: 'rd-architect', goal: '技术选型与模块划分', allowed_tools: ['Read', 'Grep'] }],
  ...overrides,
});

describe('expert package HTTP routes', () => {
  it('creates an agent expert and derives access from its tools', async () => {
    const { call } = await createServer();

    const created = await call('POST', '/api/experts', agentRequest());
    expect(created.status).toBe(201);
    const detail = created.payload.data as unknown as {
      name: string;
      access: { read: boolean; write: boolean; execute: boolean };
      revision: string;
      member_count: number;
    };
    expect(detail.name).toBe('repo-surveyor');
    // Read-only tool set, so the expert is read-only without anyone configuring `access`.
    expect(detail.access).toEqual({ read: true, write: false, execute: false });
    expect(detail.revision).toMatch(/^[0-9a-f]{12}$/);
    expect(detail.member_count).toBe(0);

    const list = await call('GET', '/api/experts');
    expect((list.payload.data as unknown as unknown[]).length).toBe(1);
  });

  it('rejects an attempt to configure access directly', async () => {
    const { call } = await createServer();
    const created = await call('POST', '/api/experts', agentRequest({ access: { read: true, write: true } }));
    expect(created.status).toBe(400);
    expect(created.payload.code).toBe('EXPERT_ACCESS_NOT_CONFIGURABLE');
  });

  it('rejects an empty tool allowlist rather than treating it as "no restriction"', async () => {
    const { call } = await createServer();
    const created = await call('POST', '/api/experts', agentRequest({ allowed_tools: [] }));
    expect(created.status).toBe(400);
    expect(created.payload.code).toBe('EXPERT_TOOLS_REQUIRED');
  });

  it('rejects a duplicate goal within the same mode but allows it in another mode', async () => {
    const { call } = await createServer();
    await call('POST', '/api/experts', agentRequest());

    const duplicate = await call('POST', '/api/experts', agentRequest({ name: 'repo-scout' }));
    expect(duplicate.status).toBe(409);
    expect(duplicate.payload.code).toBe('EXPERT_GOAL_CONFLICT');

    const otherMode = await call('POST', '/api/experts', agentRequest({ name: 'doc-scout', mode: 'office' }));
    expect(otherMode.status).toBe(201);
  });

  it('lets an update keep its own goal without self-conflicting', async () => {
    const { call } = await createServer();
    await call('POST', '/api/experts', agentRequest());
    const updated = await call('PUT', '/api/experts/repo-surveyor', agentRequest({ output: '更新后的交付物' }));
    expect(updated.status).toBe(200);
    expect((updated.payload.data as unknown as { persona: { output: string } }).persona.output).toBe('更新后的交付物');
  });

  it('rejects a name conflict on create and reports 404 for a missing expert', async () => {
    const { call } = await createServer();
    await call('POST', '/api/experts', agentRequest());

    const conflict = await call('POST', '/api/experts', agentRequest({ goal: '另一个目标' }));
    expect(conflict.status).toBe(409);
    expect(conflict.payload.code).toBe('EXPERT_NAME_CONFLICT');

    const missing = await call('GET', '/api/experts/nope');
    expect(missing.status).toBe(404);
    expect(missing.payload.code).toBe('EXPERT_NOT_FOUND');
  });

  it('resolves literal sub-paths before the :name pattern', async () => {
    const { call, expertsDir } = await createServer();
    const paths = await call('GET', '/api/experts/paths');
    expect(paths.status).toBe(200);
    expect((paths.payload.data as unknown as { user_experts_dir: string }).user_experts_dir).toBe(expertsDir);

    const vocabulary = await call('GET', '/api/experts/tool-vocabulary');
    expect(vocabulary.status).toBe(200);
    expect(vocabulary.payload.data as unknown as string[]).toContain('Read');
  });

  it('creates a team expert with an inlined lead and members', async () => {
    const { call } = await createServer();
    const created = await call('POST', '/api/experts', teamRequest());
    expect(created.status).toBe(201);
    const detail = created.payload.data as unknown as {
      expert_type: string;
      member_count: number;
      team_info: { lead_agent: string; member_agents: string[] };
      members: Array<{ id: string; role: string }>;
    };
    expect(detail.expert_type).toBe('team');
    expect(detail.member_count).toBe(2);
    expect(detail.team_info).toEqual({ lead_agent: 'rd-lead', member_agents: ['rd-architect'] });
    expect(detail.members.map((member) => member.role)).toEqual(['lead', 'member']);
  });

  it('rejects a team with no members', async () => {
    const { call } = await createServer();
    const created = await call('POST', '/api/experts', teamRequest({ members: [] }));
    expect(created.status).toBe(400);
    expect(created.payload.code).toBe('EXPERT_TEAM_INVALID');
  });

  it('rejects a team member that references an external expert', async () => {
    const { call } = await createServer();
    const created = await call(
      'POST',
      '/api/experts',
      teamRequest({ members: [{ id: 'rd-architect', ref: 'other-expert', goal: '架构', allowed_tools: ['Read'] }] })
    );
    expect(created.status).toBe(400);
    expect(created.payload.code).toBe('EXPERT_TEAM_NOT_SELF_CONTAINED');
  });

  it('imports a package from disk and refuses a second import of the same name', async () => {
    const { call, root } = await createServer();
    const source = join(root, 'incoming', 'doc-writer');
    await mkdir(join(source, '.aionui-expert'), { recursive: true });
    await mkdir(join(source, 'agents'), { recursive: true });
    await writeFile(
      join(source, '.aionui-expert', 'plugin.json'),
      JSON.stringify({
        manifestVersion: 1,
        name: 'doc-writer',
        expertType: 'agent',
        mode: 'office',
        agentName: 'doc-writer',
        displayName: { 'zh-CN': '文档撰写' },
        goal: '把素材写成可交付文档',
        allowedTools: ['Read', 'Write'],
        skills: [],
        runtime: {},
      }),
      'utf8'
    );
    await writeFile(
      join(source, 'agents', 'doc-writer.md'),
      ['---', 'name: doc-writer', 'goal: 把素材写成可交付文档', '---', '', '## 方法论 / Method', '', '写。'].join('\n'),
      'utf8'
    );

    const imported = await call('POST', '/api/experts/import', { expert_path: source });
    expect(imported.status).toBe(201);
    expect((imported.payload.data as unknown as { expert_name: string }).expert_name).toBe('doc-writer');

    const again = await call('POST', '/api/experts/import', { expert_path: source });
    expect(again.status).toBe(409);
    expect(again.payload.code).toBe('EXPERT_NAME_CONFLICT');

    const history = await call('GET', '/api/experts/import-history');
    expect((history.payload.data as unknown as unknown[]).length).toBe(2);
  });

  it('serves a bundled avatar without a backend token and rejects a path that escapes the package', async () => {
    const { call, baseUrl, expertsDir } = await createServer();
    await call('POST', '/api/experts', agentRequest());

    const pkg = join(expertsDir, 'repo-surveyor');
    await mkdir(join(pkg, 'avatars'), { recursive: true });
    await writeFile(join(pkg, 'avatars', 'expert.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const manifestFile = join(pkg, '.aionui-expert', 'plugin.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>;
    await writeFile(manifestFile, JSON.stringify({ ...manifest, avatar: './avatars/expert.png' }), 'utf8');

    expect(
      (await call('GET', '/api/experts/repo-surveyor')).payload.data as unknown as { avatar: string }
    ).toMatchObject({ avatar: '/api/experts/repo-surveyor/avatar' });

    // No auth header: an <img src> cannot send one, so this route must stay open.
    const image = await fetch(`${baseUrl}/api/experts/repo-surveyor/avatar`);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');

    await writeFile(manifestFile, JSON.stringify({ ...manifest, avatar: '../../escape.png' }), 'utf8');
    expect((await call('GET', '/api/experts/repo-surveyor')).status).toBe(403);
  });

  it('keeps bundled skills and the avatar when the expert is edited', async () => {
    const { call, expertsDir } = await createServer();
    await call('POST', '/api/experts', agentRequest({ own_skills: [{ name: 'dep-graph', content: SKILL_DOC }] }));

    const pkg = join(expertsDir, 'repo-surveyor');
    await mkdir(join(pkg, 'avatars'), { recursive: true });
    await writeFile(join(pkg, 'avatars', 'expert.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const manifestFile = join(pkg, '.aionui-expert', 'plugin.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>;
    await writeFile(manifestFile, JSON.stringify({ ...manifest, avatar: './avatars/expert.png' }), 'utf8');

    // The editor form carries neither own_skills nor an avatar; a save must not strip them.
    const updated = await call('PUT', '/api/experts/repo-surveyor', agentRequest({ output: '改过的交付物' }));

    expect(updated.status).toBe(200);
    expect(updated.payload.data as unknown as { own_skills: string[]; avatar: string }).toMatchObject({
      own_skills: ['dep-graph'],
      avatar: '/api/experts/repo-surveyor/avatar',
    });
  });

  it('deletes an expert package', async () => {
    const { call } = await createServer();
    await call('POST', '/api/experts', agentRequest());
    expect((await call('DELETE', '/api/experts/repo-surveyor')).status).toBe(200);
    expect((await call('GET', '/api/experts')).payload.data as unknown as unknown[]).toEqual([]);
  });

  it('gives an expert conversation its own runtime and stops injecting the persona in-band', async () => {
    const { call, prompts, runtimeKeys } = await createServer();
    const expert = await call('POST', '/api/experts', agentRequest());
    const revision = (expert.payload.data as unknown as { revision: string }).revision;

    const created = await call('POST', '/api/conversations', {
      assistant: { id: 'dsh:coding', conversation_overrides: { expert_id: 'repo-surveyor' } },
      extra: {},
    });
    expect(created.status).toBe(201);
    const conversationId = (created.payload.data as unknown as { id: string }).id;

    for (const [index, content] of ['first', 'second'].entries()) {
      // The turn completes after the POST returns, so wait for the prompt to actually land
      // rather than sleeping a fixed amount, which is flaky under a loaded test run.
      // eslint-disable-next-line no-await-in-loop
      await call('POST', `/api/conversations/${conversationId}/messages`, { content });
      // eslint-disable-next-line no-await-in-loop
      await vi.waitFor(() => expect(prompts.length).toBe(index + 1));
    }

    // The persona is the runtime's system prompt now, so no turn carries it as history.
    expect(prompts).toEqual(['first', 'second']);
    expect(runtimeKeys).toEqual([`coding:repo-surveyor:${revision}`]);
  });

  it('writes a read-only sandbox overlay for an expert with no write tools', async () => {
    const { call, dshHome } = await createServer();
    await call('POST', '/api/experts', agentRequest());
    const created = await call('POST', '/api/conversations', {
      assistant: { id: 'dsh:coding', conversation_overrides: { expert_id: 'repo-surveyor' } },
      extra: {},
    });
    const conversationId = (created.payload.data as unknown as { id: string }).id;
    await call('POST', `/api/conversations/${conversationId}/runtime/ensure`);

    const patch = await readFile(
      join(dshHome, 'expert-runtimes', 'coding', 'repo-surveyor', EXPERT_PATCH_FILE),
      'utf8'
    );
    expect(patch).toContain('- id: sandbox-policy');
    expect(patch).toContain('mode: read-only');
    // Shell and delegation are not in the tool allowlist, so their rows are switched off.
    expect(patch).toContain('- id: tool-subagent\n  disabled: true');
    // Approval must never be restated: that is the only way to stop asking about the lead.
    expect(patch).not.toContain('id: approval');
  });

  it('keeps a conversation without an expert on the shared work-mode runtime', async () => {
    const { call, runtimeKeys } = await createServer();
    const created = await call('POST', '/api/conversations', { assistant: { id: 'dsh:coding' }, extra: {} });
    const conversationId = (created.payload.data as unknown as { id: string }).id;
    await call('POST', `/api/conversations/${conversationId}/runtime/ensure`);

    expect(runtimeKeys).toEqual(['coding::']);
  });

  it('rejects an expert that belongs to another work mode', async () => {
    const { call } = await createServer();
    await call('POST', '/api/experts', agentRequest());
    const created = await call('POST', '/api/conversations', {
      assistant: { id: 'dsh:office', conversation_overrides: { expert_id: 'repo-surveyor' } },
      extra: {},
    });
    expect(created.status).toBe(409);
    expect(created.payload.code).toBe('EXPERT_MODE_MISMATCH');
  });

  it('mounts one delegation tool per team member when a team conversation starts', async () => {
    const { call, dshHome } = await createServer();
    await call('POST', '/api/experts', teamRequest());
    const created = await call('POST', '/api/conversations', {
      assistant: { id: 'dsh:coding', conversation_overrides: { expert_id: 'rd-team' } },
      extra: {},
    });
    expect(created.status).toBe(201);
    const conversationId = (created.payload.data as unknown as { id: string }).id;
    await call('POST', `/api/conversations/${conversationId}/runtime/ensure`);

    const patch = await readFile(join(dshHome, 'expert-runtimes', 'coding', 'rd-team', EXPERT_PATCH_FILE), 'utf8');
    expect(patch).toContain('- id: expert-member-rd-architect');
    expect(patch).toContain('toolName: expert__rd_architect');
    expect(patch).toContain('maxDepth: 1');
    // A read-only member gets an allowlist with no write tool in it.
    expect(patch).toContain('allow: [grep, read, read_image, skill, todo_write]');
    // The lead itself is not a delegation target.
    expect(patch).not.toContain('expert-member-rd-lead');
  });
});
