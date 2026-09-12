import { describe, expect, it, vi } from 'vitest';
import {
  DshBridge,
  DshRuntimePool,
  modeRuntimeKey,
  normalizeDshWorkMode,
  personaForDshWorkMode,
  runtimeKeyId,
  type DshAgentPort,
} from '../../../packages/dsh-bridge/src';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function fakePort(overrides: Partial<DshAgentPort> = {}): DshAgentPort {
  return {
    initialize: vi.fn(async () => ({ protocolVersion: 1, capabilities: {} })),
    newSession: vi.fn(async () => ({ sessionId: 'session-1', configOptions: [] })),
    resumeSession: vi.fn(async () => ({ configOptions: [] })),
    closeSession: vi.fn(async () => {}),
    prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
    cancel: vi.fn(async () => {}),
    setConfigOption: vi.fn(async () => []),
    bindSession: vi.fn(),
    dispose: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('dsh bridge lifecycle', () => {
  it('creates a bound session and maps successful prompt settlement', async () => {
    const port = fakePort();
    const bridge = new DshBridge({ port });
    await bridge.start();
    const session = await bridge.createSession('conversation-1', 'D:/workspace');

    expect(session.sessionId).toBe('session-1');
    expect(port.bindSession).toHaveBeenCalledWith('session-1', 'conversation-1');
    await expect(bridge.prompt('conversation-1', 'hello', 'turn-1')).resolves.toBe('completed');
  });

  it('rejects concurrent prompts and routes cancellation to the active session', async () => {
    const active = deferred<{ stopReason: string }>();
    const port = fakePort({ prompt: vi.fn(() => active.promise) });
    const bridge = new DshBridge({ port });
    await bridge.start();
    await bridge.createSession('conversation-1', 'D:/workspace');
    const first = bridge.prompt('conversation-1', 'first', 'turn-1');

    await expect(bridge.prompt('conversation-1', 'second', 'turn-2')).rejects.toThrow('active turn');
    await expect(bridge.cancel('conversation-1')).resolves.toBe(true);
    expect(port.cancel).toHaveBeenCalledWith('session-1');
    active.resolve({ stopReason: 'cancelled' });
    await first;
  });

  it('shares one session creation across concurrent callers', async () => {
    const created = deferred<{ sessionId: string; configOptions: [] }>();
    const newSession = vi.fn(() => created.promise);
    const bridge = new DshBridge({ port: fakePort({ newSession }) });
    await bridge.start();

    const first = bridge.createSession('conversation-1', 'D:/workspace');
    const second = bridge.createSession('conversation-1', 'D:/workspace');
    expect(newSession).toHaveBeenCalledTimes(1);

    created.resolve({ sessionId: 'shared-session', configOptions: [] });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ sessionId: 'shared-session' }),
      expect.objectContaining({ sessionId: 'shared-session' }),
    ]);
  });

  it('allows session creation to retry after a failed attempt', async () => {
    const newSession = vi
      .fn<DshAgentPort['newSession']>()
      .mockRejectedValueOnce(new Error('startup failed'))
      .mockResolvedValueOnce({ sessionId: 'retry-session', configOptions: [] });
    const bridge = new DshBridge({ port: fakePort({ newSession }) });
    await bridge.start();

    await expect(bridge.createSession('conversation-1', 'D:/workspace')).rejects.toThrow('startup failed');
    await expect(bridge.createSession('conversation-1', 'D:/workspace')).resolves.toMatchObject({
      sessionId: 'retry-session',
    });
  });

  it('rejects an incompatible ACP server before publishing sessions', async () => {
    const port = fakePort({ initialize: vi.fn(async () => ({ protocolVersion: 2, capabilities: {} })) });
    const bridge = new DshBridge({ port });

    await expect(bridge.start()).rejects.toThrow('Unsupported ACP protocol version');
    await expect(bridge.createSession('conversation-1', 'D:/workspace')).rejects.toThrow('has not started');
  });
});

describe('dsh work mode runtime pool', () => {
  it('shares an in-flight warmup and reuses the initialized runtime', async () => {
    const initialized = deferred<{ protocolVersion: number; capabilities: {} }>();
    const initialize = vi.fn(() => initialized.promise);
    const createPort = vi.fn(() => fakePort({ initialize }));
    const pool = new DshRuntimePool({ createPort });

    const first = pool.warm(modeRuntimeKey('coding'));
    const second = pool.warm(modeRuntimeKey('coding'));
    expect(pool.isWarm(modeRuntimeKey('coding'))).toBe(false);
    expect(createPort).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledTimes(1);

    initialized.resolve({ protocolVersion: 1, capabilities: {} });
    await Promise.all([first, second]);
    expect(pool.isWarm(modeRuntimeKey('coding'))).toBe(true);
    await pool.createSession('coding-conversation', 'D:/code', modeRuntimeKey('coding'));
    expect(initialize).toHaveBeenCalledTimes(1);
    await pool.dispose();
  });

  it('starts each mode lazily and keeps conversations on their selected runtime', async () => {
    const createdKeys: string[] = [];
    const ports = new Map<string, DshAgentPort>();
    const pool = new DshRuntimePool({
      createPort: (key) => {
        createdKeys.push(runtimeKeyId(key));
        const port = fakePort({
          newSession: vi.fn(async () => ({ sessionId: `${key.mode}-session`, configOptions: [] })),
        });
        ports.set(runtimeKeyId(key), port);
        return port;
      },
    });

    expect(createdKeys).toEqual([]);
    await pool.createSession('office-conversation', 'D:/office', modeRuntimeKey('office'));
    await pool.createSession('coding-conversation', 'D:/code', modeRuntimeKey('coding'));
    await pool.createSession('research-conversation', 'D:/research', modeRuntimeKey('research'));

    expect(createdKeys).toEqual(['office::', 'coding::', 'research::']);
    expect(pool.getSession('office-conversation')?.sessionId).toBe('office-session');
    expect(pool.getSession('coding-conversation')?.sessionId).toBe('coding-session');
    expect(pool.getSession('research-conversation')?.sessionId).toBe('research-session');
    expect(ports.size).toBe(3);
    await pool.dispose();
  });

  it('keeps the coding runtime usable when office initialization fails', async () => {
    const pool = new DshRuntimePool({
      createPort: (key) =>
        key.mode === 'office'
          ? fakePort({ initialize: vi.fn(async () => ({ protocolVersion: 2, capabilities: {} })) })
          : fakePort({ newSession: vi.fn(async () => ({ sessionId: 'coding-session', configOptions: [] })) }),
    });

    await expect(pool.createSession('office-conversation', 'D:/office', modeRuntimeKey('office'))).rejects.toThrow(
      'Unsupported ACP protocol version'
    );
    await expect(pool.createSession('coding-conversation', 'D:/code', modeRuntimeKey('coding'))).resolves.toMatchObject(
      {
        sessionId: 'coding-session',
      }
    );
    await pool.dispose();
  });

  it('gives two experts in one mode separate runtimes and shares one across revisions of none', async () => {
    const createdKeys: string[] = [];
    const pool = new DshRuntimePool({
      createPort: (key) => {
        createdKeys.push(runtimeKeyId(key));
        return fakePort();
      },
    });

    await pool.createSession('a', 'D:/office', { mode: 'office', expertName: 'scout', expertRevision: 'r1' });
    await pool.createSession('b', 'D:/office', { mode: 'office', expertName: 'editor', expertRevision: 'r1' });
    await pool.createSession('c', 'D:/office', modeRuntimeKey('office'));
    await pool.createSession('d', 'D:/office', modeRuntimeKey('office'));

    expect(createdKeys).toEqual(['office:scout:r1', 'office:editor:r1', 'office::']);
    await pool.dispose();
  });

  it('routes a conversation to a new runtime when the expert definition changes', async () => {
    const createdKeys: string[] = [];
    const pool = new DshRuntimePool({
      createPort: (key) => {
        createdKeys.push(runtimeKeyId(key));
        return fakePort();
      },
    });

    await pool.createSession('before', 'D:/office', { mode: 'office', expertName: 'scout', expertRevision: 'r1' });
    await pool.createSession('after', 'D:/office', { mode: 'office', expertName: 'scout', expertRevision: 'r2' });

    expect(createdKeys).toEqual(['office:scout:r1', 'office:scout:r2']);
    await pool.dispose();
  });

  it('prepares a runtime key on disk before its port is created', async () => {
    const order: string[] = [];
    const pool = new DshRuntimePool({
      prepare: async (key) => {
        order.push(`prepare:${runtimeKeyId(key)}`);
      },
      createPort: (key) => {
        order.push(`port:${runtimeKeyId(key)}`);
        return fakePort();
      },
    });

    await pool.warm({ mode: 'office', expertName: 'scout', expertRevision: 'r1' });

    expect(order).toEqual(['prepare:office:scout:r1', 'port:office:scout:r1']);
    await pool.dispose();
  });

  it('reclaims idle expert runtimes but never the pinned one', async () => {
    const disposed: string[] = [];
    const pool = new DshRuntimePool({
      idleMs: 1_000,
      pinnedKeyId: runtimeKeyId(modeRuntimeKey('office')),
      createPort: (key) => fakePort({ dispose: vi.fn(async () => void disposed.push(runtimeKeyId(key))) }),
    });
    await pool.warm(modeRuntimeKey('office'));
    await pool.warm({ mode: 'office', expertName: 'scout', expertRevision: 'r1' });

    expect(await pool.reclaimIdle(Date.now())).toEqual([]);
    expect(await pool.reclaimIdle(Date.now() + 2_000)).toEqual(['office:scout:r1']);
    expect(disposed).toEqual(['office:scout:r1']);
    expect(pool.warmKeyIds()).toEqual(['office::']);
    await pool.dispose();
  });

  it('cold starts a reclaimed runtime on the next session instead of failing', async () => {
    let ports = 0;
    const pool = new DshRuntimePool({
      idleMs: 1_000,
      createPort: () => {
        ports += 1;
        return fakePort();
      },
    });
    const key = { mode: 'office', expertName: 'scout', expertRevision: 'r1' } as const;
    await pool.createSession('conversation-1', 'D:/office', key);
    await pool.reclaimIdle(Date.now() + 2_000);

    expect(pool.getSession('conversation-1')).toBeUndefined();
    await pool.resumeSession('conversation-1', 'session-1', 'D:/office', key);

    expect(ports).toBe(2);
    expect(pool.getSession('conversation-1')?.sessionId).toBe('session-1');
    await pool.dispose();
  });

  it('maps legacy conversations to coding and gives each mode a distinct persona', () => {
    expect(normalizeDshWorkMode(undefined, 'dsh:deepseek-harness')).toBe('coding');
    expect(personaForDshWorkMode('office')).toContain('office productivity agent');
    expect(personaForDshWorkMode('coding')).toContain('coding agent');
    expect(personaForDshWorkMode('research')).toContain('deep research agent');
    expect(personaForDshWorkMode('research')).toContain('never invent citations');
  });
});
