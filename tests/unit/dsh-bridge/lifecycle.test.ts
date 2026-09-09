import { describe, expect, it, vi } from 'vitest';
import {
  DshBridge,
  DshRuntimePool,
  normalizeDshWorkMode,
  personaForDshWorkMode,
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

  it('rejects an incompatible ACP server before publishing sessions', async () => {
    const port = fakePort({ initialize: vi.fn(async () => ({ protocolVersion: 2, capabilities: {} })) });
    const bridge = new DshBridge({ port });

    await expect(bridge.start()).rejects.toThrow('Unsupported ACP protocol version');
    await expect(bridge.createSession('conversation-1', 'D:/workspace')).rejects.toThrow('has not started');
  });
});

describe('dsh work mode runtime pool', () => {
  it('starts each mode lazily and keeps conversations on their selected runtime', async () => {
    const createdModes: string[] = [];
    const ports = new Map<string, DshAgentPort>();
    const pool = new DshRuntimePool({
      createPort: (mode) => {
        createdModes.push(mode);
        const port = fakePort({
          newSession: vi.fn(async () => ({ sessionId: `${mode}-session`, configOptions: [] })),
        });
        ports.set(mode, port);
        return port;
      },
    });

    expect(createdModes).toEqual([]);
    await pool.createSession('office-conversation', 'D:/office', 'office');
    await pool.createSession('coding-conversation', 'D:/code', 'coding');
    await pool.createSession('research-conversation', 'D:/research', 'research');

    expect(createdModes).toEqual(['office', 'coding', 'research']);
    expect(pool.getSession('office-conversation')?.sessionId).toBe('office-session');
    expect(pool.getSession('coding-conversation')?.sessionId).toBe('coding-session');
    expect(pool.getSession('research-conversation')?.sessionId).toBe('research-session');
    expect(ports.size).toBe(3);
    await pool.dispose();
  });

  it('keeps the coding runtime usable when office initialization fails', async () => {
    const pool = new DshRuntimePool({
      createPort: (mode) =>
        mode === 'office'
          ? fakePort({ initialize: vi.fn(async () => ({ protocolVersion: 2, capabilities: {} })) })
          : fakePort({ newSession: vi.fn(async () => ({ sessionId: 'coding-session', configOptions: [] })) }),
    });

    await expect(pool.createSession('office-conversation', 'D:/office', 'office')).rejects.toThrow(
      'Unsupported ACP protocol version'
    );
    await expect(pool.createSession('coding-conversation', 'D:/code', 'coding')).resolves.toMatchObject({
      sessionId: 'coding-session',
    });
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
