import { describe, expect, it, vi } from 'vitest';
import { DshBridge, type DshAgentPort } from '../../../packages/dsh-bridge/src';

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
