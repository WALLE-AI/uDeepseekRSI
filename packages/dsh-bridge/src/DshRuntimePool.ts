import { DshBridge } from './DshBridge';
import type { BridgeStopReason, DshAgentPort, DshMcpServer, DshSession } from './types';

export const DSH_OFFICE_ASSISTANT_ID = 'dsh:office';
export const DSH_CODING_ASSISTANT_ID = 'dsh:coding';
export const DSH_RESEARCH_ASSISTANT_ID = 'dsh:research';
export const LEGACY_DSH_ASSISTANT_ID = 'dsh:deepseek-harness';

export type DshWorkMode = 'office' | 'coding' | 'research';

export const DSH_WORK_MODES: readonly DshWorkMode[] = ['office', 'coding', 'research'];

export function workModeFromAssistantId(assistantId: string): DshWorkMode | undefined {
  if (assistantId === DSH_OFFICE_ASSISTANT_ID) return 'office';
  if (assistantId === DSH_CODING_ASSISTANT_ID || assistantId === LEGACY_DSH_ASSISTANT_ID) return 'coding';
  if (assistantId === DSH_RESEARCH_ASSISTANT_ID) return 'research';
  return undefined;
}

export function assistantIdForWorkMode(mode: DshWorkMode): string {
  if (mode === 'office') return DSH_OFFICE_ASSISTANT_ID;
  if (mode === 'research') return DSH_RESEARCH_ASSISTANT_ID;
  return DSH_CODING_ASSISTANT_ID;
}

export function normalizeDshWorkMode(value: unknown, assistantId?: string): DshWorkMode {
  if (value === 'office' || value === 'coding' || value === 'research') return value;
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
  if (mode === 'research') {
    return [
      'You are a deep research agent. Your working directory is {{cwd}}.',
      'Handle rigorous research across academic science, business and finance, policy and law, and high-consideration personal decisions.',
      'Clarify the question and decision criteria, create a research plan, search broadly, and prioritize primary, current, and authoritative sources.',
      'Cross-check material claims, preserve source dates and context, cite evidence at the point of use, and never invent citations or unsupported facts.',
      'Clearly separate sourced facts, analysis, assumptions, and uncertainty; surface conflicting evidence, limitations, and information gaps.',
      'Produce a structured synthesis tailored to the requested outcome, such as a literature review, research question, experiment design, market or competitor analysis, investment due diligence, policy or legal comparison, compliance review, or personalized purchase recommendation.',
      'For legal, financial, safety, and other high-stakes topics, avoid overclaiming, identify jurisdiction or applicability limits, and recommend qualified review when appropriate.',
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
  readonly #sessionStarts = new Map<string, { mode: DshWorkMode; promise: Promise<DshSession> }>();
  readonly #conversationModes = new Map<string, DshWorkMode>();
  #disposed = false;

  constructor(options: DshRuntimePoolOptions) {
    this.#createPort = options.createPort;
  }

  getSession(conversationId: string): DshSession | undefined {
    const mode = this.#conversationModes.get(conversationId);
    return mode ? this.#bridges.get(mode)?.getSession(conversationId) : undefined;
  }

<<<<<<< HEAD
  isWarm(mode: DshWorkMode): boolean {
    return this.#bridges.has(mode);
  }

  async warm(mode: DshWorkMode): Promise<void> {
    await this.#bridge(mode);
  }

  async createSession(
    conversationId: string,
    cwd: string,
    mode: DshWorkMode,
    mcpServers?: readonly DshMcpServer[]
  ): Promise<DshSession> {
    return await this.#startSession(conversationId, mode, async () => {
      const bridge = await this.#bridge(mode);
      return await bridge.createSession(conversationId, cwd, mcpServers);
    });
  }

=======
  async createSession(
    conversationId: string,
    cwd: string,
    mode: DshWorkMode,
    mcpServers?: readonly DshMcpServer[]
  ): Promise<DshSession> {
    const bridge = await this.#bridge(mode);
    const session = await bridge.createSession(conversationId, cwd, mcpServers);
    this.#conversationModes.set(conversationId, mode);
    return session;
  }

>>>>>>> bc237b88135c02f5fff8c017bcef5645267a5591
  async resumeSession(
    conversationId: string,
    sessionId: string,
    cwd: string,
    mode: DshWorkMode,
    mcpServers?: readonly DshMcpServer[]
  ): Promise<DshSession> {
<<<<<<< HEAD
    return await this.#startSession(conversationId, mode, async () => {
      const bridge = await this.#bridge(mode);
      return await bridge.resumeSession(conversationId, sessionId, cwd, mcpServers);
    });
=======
    const bridge = await this.#bridge(mode);
    const session = await bridge.resumeSession(conversationId, sessionId, cwd, mcpServers);
    this.#conversationModes.set(conversationId, mode);
    return session;
>>>>>>> bc237b88135c02f5fff8c017bcef5645267a5591
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
    await this.#sessionStarts.get(conversationId)?.promise.catch((): undefined => undefined);
    const bridge = this.#conversationBridge(conversationId);
    await bridge.closeSession(conversationId);
    this.#conversationModes.delete(conversationId);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await Promise.allSettled(this.#starting.values());
    await Promise.allSettled([...this.#sessionStarts.values()].map(({ promise }) => promise));
    const bridges = [...this.#bridges.values()];
    this.#bridges.clear();
    this.#starting.clear();
    this.#sessionStarts.clear();
    this.#conversationModes.clear();
    await Promise.all(bridges.map((bridge) => bridge.dispose()));
  }

  async #startSession(
    conversationId: string,
    mode: DshWorkMode,
    create: () => Promise<DshSession>
  ): Promise<DshSession> {
    const existing = this.getSession(conversationId);
    if (existing) return existing;
    const pending = this.#sessionStarts.get(conversationId);
    if (pending) {
      if (pending.mode !== mode) throw new Error(`Conversation runtime mode changed during startup: ${conversationId}`);
      return await pending.promise;
    }

    const promise = create()
      .then((session) => {
        if (this.#disposed) throw new Error('The dsh runtime pool is disposed.');
        this.#conversationModes.set(conversationId, mode);
        return session;
      })
      .finally(() => this.#sessionStarts.delete(conversationId));
    this.#sessionStarts.set(conversationId, { mode, promise });
    return await promise;
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
