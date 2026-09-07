import { DshBridge } from './DshBridge';
import type { BridgeStopReason, DshAgentPort, DshSession } from './types';

export const DSH_OFFICE_ASSISTANT_ID = 'dsh:office';
export const DSH_CODING_ASSISTANT_ID = 'dsh:coding';
export const LEGACY_DSH_ASSISTANT_ID = 'dsh:deepseek-harness';

export type DshWorkMode = 'office' | 'coding';

export const DSH_WORK_MODES: readonly DshWorkMode[] = ['office', 'coding'];

export function workModeFromAssistantId(assistantId: string): DshWorkMode | undefined {
  if (assistantId === DSH_OFFICE_ASSISTANT_ID) return 'office';
  if (assistantId === DSH_CODING_ASSISTANT_ID || assistantId === LEGACY_DSH_ASSISTANT_ID) return 'coding';
  return undefined;
}

export function assistantIdForWorkMode(mode: DshWorkMode): string {
  return mode === 'office' ? DSH_OFFICE_ASSISTANT_ID : DSH_CODING_ASSISTANT_ID;
}

export function normalizeDshWorkMode(value: unknown, assistantId?: string): DshWorkMode {
  if (value === 'office' || value === 'coding') return value;
  return workModeFromAssistantId(assistantId ?? '') ?? 'coding';
}

export function personaForDshWorkMode(mode: DshWorkMode): string {
  if (mode === 'office') {
    return [
      'You are an office productivity agent. Your working directory is {{cwd}}.',
      'Prioritize clear business writing, document preparation, spreadsheets, presentations, PDFs, research, and data organization.',
      'You may use scripts when they materially improve the result, but optimize the final deliverable for practical office use rather than software engineering detail.',
      'Confirm the target, format, and overwrite scope before making ambiguous or destructive file changes.',
    ].join(' ');
  }
  return [
    'You are a coding agent. Your working directory is {{cwd}}.',
    'Understand repository conventions before editing, keep changes scoped, and use the available tools to inspect, implement, and verify the work.',
    'Run checks proportional to the change and report the result, verification status, and remaining risks clearly.',
  ].join(' ');
}

type DshRuntimePoolOptions = {
  createPort: (mode: DshWorkMode) => DshAgentPort;
};

/** Lazily owns one isolated DSH ACP runtime per work mode. */
export class DshRuntimePool {
  readonly #createPort: DshRuntimePoolOptions['createPort'];
  readonly #bridges = new Map<DshWorkMode, DshBridge>();
  readonly #starting = new Map<DshWorkMode, Promise<DshBridge>>();
  readonly #conversationModes = new Map<string, DshWorkMode>();
  #disposed = false;

  constructor(options: DshRuntimePoolOptions) {
    this.#createPort = options.createPort;
  }

  getSession(conversationId: string): DshSession | undefined {
    const mode = this.#conversationModes.get(conversationId);
    return mode ? this.#bridges.get(mode)?.getSession(conversationId) : undefined;
  }

  async createSession(conversationId: string, cwd: string, mode: DshWorkMode): Promise<DshSession> {
    const bridge = await this.#bridge(mode);
    const session = await bridge.createSession(conversationId, cwd);
    this.#conversationModes.set(conversationId, mode);
    return session;
  }

  async resumeSession(conversationId: string, sessionId: string, cwd: string, mode: DshWorkMode): Promise<DshSession> {
    const bridge = await this.#bridge(mode);
    const session = await bridge.resumeSession(conversationId, sessionId, cwd);
    this.#conversationModes.set(conversationId, mode);
    return session;
  }

  async prompt(conversationId: string, text: string, turnId?: string): Promise<BridgeStopReason> {
    return await this.#conversationBridge(conversationId).prompt(conversationId, text, turnId);
  }

  async cancel(conversationId: string): Promise<boolean> {
    return await this.#conversationBridge(conversationId).cancel(conversationId);
  }

  async setConfigOption(conversationId: string, configId: string, value: string): Promise<DshSession> {
    return await this.#conversationBridge(conversationId).setConfigOption(conversationId, configId, value);
  }

  async closeSession(conversationId: string): Promise<void> {
    const bridge = this.#conversationBridge(conversationId);
    await bridge.closeSession(conversationId);
    this.#conversationModes.delete(conversationId);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await Promise.allSettled(this.#starting.values());
    const bridges = [...this.#bridges.values()];
    this.#bridges.clear();
    this.#starting.clear();
    this.#conversationModes.clear();
    await Promise.all(bridges.map((bridge) => bridge.dispose()));
  }

  async #bridge(mode: DshWorkMode): Promise<DshBridge> {
    if (this.#disposed) throw new Error('The dsh runtime pool is disposed.');
    const existing = this.#bridges.get(mode);
    if (existing) return existing;

    const pending = this.#starting.get(mode);
    if (pending) return await pending;

    const starting = (async () => {
      const bridge = new DshBridge({ port: this.#createPort(mode) });
      try {
        await bridge.start();
      } catch (error) {
        await bridge.dispose().catch((): undefined => undefined);
        throw error;
      }
      if (this.#disposed) {
        await bridge.dispose();
        throw new Error('The dsh runtime pool is disposed.');
      }
      this.#bridges.set(mode, bridge);
      return bridge;
    })().finally(() => this.#starting.delete(mode));
    this.#starting.set(mode, starting);
    return await starting;
  }

  #conversationBridge(conversationId: string): DshBridge {
    const mode = this.#conversationModes.get(conversationId);
    const bridge = mode ? this.#bridges.get(mode) : undefined;
    if (!bridge) throw new Error(`No dsh runtime for conversation: ${conversationId}`);
    return bridge;
  }
}
