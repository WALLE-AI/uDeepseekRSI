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

/**
 * 告诉模型它有一个浏览器，以及怎么用。
 *
 * 在这之前，三段 work-mode persona 里没有一个字提到应用内浏览器 —— research 模式甚至
 * 要求「优先一手、权威、当期来源」，却没说它能打开真实网页。模型只能从工具列表里推断
 * 这些工具是干什么的，于是出现两种典型退化：该开浏览器的时候用 web_fetch 硬啃，以及
 * 每一步都截图（截图 token 按尺寸算，比 take_snapshot 贵一个量级）。
 *
 * 只在浏览器 MCP 真的挂上时才拼接：讲一个不存在的工具比不讲更糟。
 *
 * Tell the model it has a browser and how to use it. Until now not one of the three work-mode
 * personas mentioned the in-app browser — research mode even demands primary, authoritative,
 * current sources without saying it can open a real page. The model had to infer the tools'
 * purpose from the tool list, which degrades two predictable ways: grinding through web_fetch
 * where a browser was needed, and screenshotting every step (screenshot tokens scale with
 * dimensions and cost an order of magnitude more than take_snapshot).
 *
 * Only appended when the browser MCP is actually mounted: describing a tool that is not there
 * is worse than saying nothing.
 *
 * 约束：`dsh-system-prompt` 对 persona 做严格变量插值，除 `{{cwd}}` 外出现任何 `{{…}}`
 * 都会让整个 runtime 启动失败，所以这段文本里不能有花括号。
 *
 * Constraint: `dsh-system-prompt` interpolates the persona strictly, so any `{{…}}` other than
 * `{{cwd}}` fails the whole runtime at boot — this text must contain no braces.
 */
export function browserPersonaSection(mode: DshWorkMode): string {
  const lines = [
    'You can drive a real browser through the aionui-browser tools, and its tabs are the ones the user sees on screen.',
    'Use it when the page needs a signed-in session, interaction such as search boxes, pagination, or forms, or when you must read the page as it actually renders; prefer web_fetch for plain static pages because it is faster and cheaper.',
    'The normal loop is list_pages, then navigate_page, then take_snapshot to get element uids, then click or fill using those uids.',
    'Do not screenshot by default: take_snapshot is far cheaper and is what uids come from. Reach for take_screenshot only when the answer depends on what something looks like, such as a chart, a layout problem, or locating a visual element.',
    'Tool errors start with an upper-case code that tells you what to do. CHALLENGE_REQUIRED or AUTHENTICATION_REQUIRED means you must stop and ask the user to complete it in the Browser tab. USER_TOOK_CONTROL means the user has taken over, so wait instead of competing. RATE_LIMITED means back off until the stated time rather than retrying with a reshaped URL. CAPABILITY_BLOCKED, SENSITIVE_READ_BLOCKED, ACCESS_DENIED and NAVIGATION_BLOCKED are permanent, so never retry them.',
    'The user is watching these tabs and you are acting inside their signed-in session, so browse only what the task requires and say what you are about to do before acting on their account.',
  ];
  if (mode === 'research') {
    lines.push(
      'When a claim matters, open the original source in the browser and read it there rather than relying on a search snippet.'
    );
  }
  return lines.join(' ');
}

/**
 * 内置浏览器 MCP 是否真的挂上了。
 *
 * 名字和 `mcpServers` 都对上才算数。只看其中一个都会说谎：宿主可能给了名字却因为 CDP
 * 被用户关掉而没注入 server（directBackendManager 正是这么写的），反过来也可能注入的是
 * 别的内置 MCP。
 *
 * 单独成函数是因为它错了不会报错 —— 只是 persona 里少一段，或者多讲一个不存在的工具，
 * 两种都要跑起来才看得见。
 *
 * Whether the built-in browser MCP is actually mounted. The name and `mcpServers` must agree:
 * either alone would lie, since the host can supply the name yet inject nothing because the user
 * switched CDP off (exactly what directBackendManager does), and can equally inject a different
 * built-in MCP. Split out because getting it wrong raises no error — it silently drops a persona
 * section or describes a tool that is not there, and both only show up at runtime.
 */
export function browserToolsMounted(
  mcpServers: readonly DshMcpServer[] | undefined,
  name: string | undefined
): boolean {
  if (!name) return false;
  return (mcpServers ?? []).some((server) => server.name === name);
}

/**
 * Identity of one isolated dsh process.
 *
 * The expert revision is part of the key but never of the `DSH_HOME` path: editing an
 * expert has to swap the process (so the new persona takes effect) while keeping the home
 * (so conversations created against the old definition can still be resumed).
 */
export type DshRuntimeKey = {
  mode: DshWorkMode;
  expertName?: string;
  expertRevision?: string;
};

export function runtimeKeyId(key: DshRuntimeKey): string {
  return `${key.mode}:${key.expertName ?? ''}:${key.expertRevision ?? ''}`;
}

/** The high-traffic key: every conversation opened from the home page lands here. */
export function modeRuntimeKey(mode: DshWorkMode): DshRuntimeKey {
  return { mode };
}

/** Fifteen minutes: long enough to survive a coffee break, short enough to bound memory. */
const DEFAULT_RUNTIME_IDLE_MS = 15 * 60 * 1000;

type DshRuntimePoolOptions = {
  createPort: (key: DshRuntimeKey) => DshAgentPort;
  /** Awaited before the port is created, for work a key needs on disk first. */
  prepare?: (key: DshRuntimeKey) => Promise<void>;
  /** Idle window before an unused runtime is disposed; `false` disables reclamation. */
  idleMs?: number | false;
  /** Key exempt from reclamation — the prewarmed one, which exists to stay warm. */
  pinnedKeyId?: string;
};

/**
 * Lazily owns one isolated DSH ACP runtime per key.
 *
 * Keying on the expert rather than only the work mode is what makes an expert's persona a
 * real system prompt: `system-prompt.persona` is process-level in the ACP profile, so two
 * experts sharing a process would share an identity.
 */
export class DshRuntimePool {
  readonly #createPort: DshRuntimePoolOptions['createPort'];
  readonly #prepare: DshRuntimePoolOptions['prepare'];
  readonly #idleMs: number | false;
  readonly #pinnedKeyId?: string;
  readonly #bridges = new Map<string, DshBridge>();
  readonly #starting = new Map<string, Promise<DshBridge>>();
  readonly #sessionStarts = new Map<string, { keyId: string; promise: Promise<DshSession> }>();
  readonly #conversationKeys = new Map<string, DshRuntimeKey>();
  readonly #lastActive = new Map<string, number>();
  #reclaimTimer: ReturnType<typeof setInterval> | null = null;
  #disposed = false;

  constructor(options: DshRuntimePoolOptions) {
    this.#createPort = options.createPort;
    this.#prepare = options.prepare;
    this.#idleMs = options.idleMs ?? DEFAULT_RUNTIME_IDLE_MS;
    if (options.pinnedKeyId !== undefined) this.#pinnedKeyId = options.pinnedKeyId;
  }

  getSession(conversationId: string): DshSession | undefined {
    const key = this.#conversationKeys.get(conversationId);
    return key ? this.#bridges.get(runtimeKeyId(key))?.getSession(conversationId) : undefined;
  }

  isWarm(key: DshRuntimeKey): boolean {
    return this.#bridges.has(runtimeKeyId(key));
  }

  /** Keys with a live runtime right now — the number this pool is judged on. */
  warmKeyIds(): string[] {
    return [...this.#bridges.keys()];
  }

  async warm(key: DshRuntimeKey): Promise<void> {
    await this.#bridge(key);
  }

  async createSession(
    conversationId: string,
    cwd: string,
    key: DshRuntimeKey,
    mcpServers?: readonly DshMcpServer[]
  ): Promise<DshSession> {
    return await this.#startSession(conversationId, key, async () => {
      const bridge = await this.#bridge(key);
      return await bridge.createSession(conversationId, cwd, mcpServers);
    });
  }

  async resumeSession(
    conversationId: string,
    sessionId: string,
    cwd: string,
    key: DshRuntimeKey,
    mcpServers?: readonly DshMcpServer[]
  ): Promise<DshSession> {
    return await this.#startSession(conversationId, key, async () => {
      const bridge = await this.#bridge(key);
      return await bridge.resumeSession(conversationId, sessionId, cwd, mcpServers);
    });
  }

  async prompt(conversationId: string, text: string, turnId?: string): Promise<BridgeStopReason> {
    const bridge = this.#conversationBridge(conversationId);
    this.#touch(conversationId);
    return await bridge.prompt(conversationId, text, turnId);
  }

  async cancel(conversationId: string): Promise<boolean> {
    const bridge = this.#conversationBridge(conversationId);
    this.#touch(conversationId);
    return await bridge.cancel(conversationId);
  }

  async setConfigOption(conversationId: string, configId: string, value: string): Promise<DshSession> {
    const bridge = this.#conversationBridge(conversationId);
    this.#touch(conversationId);
    return await bridge.setConfigOption(conversationId, configId, value);
  }

  async closeSession(conversationId: string): Promise<void> {
    await this.#sessionStarts.get(conversationId)?.promise.catch((): undefined => undefined);
    const key = this.#conversationKeys.get(conversationId);
    this.#conversationKeys.delete(conversationId);
    // A reclaimed runtime has already closed everything it owned; nothing left to close.
    const bridge = key ? this.#bridges.get(runtimeKeyId(key)) : undefined;
    if (!bridge) return;
    await bridge.closeSession(conversationId);
  }

  /**
   * Disposes one runtime by key.
   *
   * Needed when a setting changes the composition a process was booted with: DSH reads its
   * patch stack once at startup, so the only way a new composition takes effect is a new
   * process. Sessions are persisted by dsh, so the next prompt resumes them.
   */
  async disposeRuntime(key: DshRuntimeKey): Promise<boolean> {
    const keyId = runtimeKeyId(key);
    const bridge = this.#bridges.get(keyId);
    if (!bridge) return false;
    this.#bridges.delete(keyId);
    this.#lastActive.delete(keyId);
    await bridge.dispose().catch((): undefined => undefined);
    return true;
  }

  /**
   * Disposes runtimes idle for longer than the configured window.
   *
   * Safe because dsh owns session persistence: the next prompt resumes the stored session
   * in a fresh process, paying one cold start instead of holding a process per expert for
   * the lifetime of the app.
   */
  async reclaimIdle(now = Date.now()): Promise<string[]> {
    if (this.#disposed || this.#idleMs === false) return [];
    const idleMs = this.#idleMs;
    const reclaimed: string[] = [];
    // Deleting the current entry mid-iteration is safe for a Map, and a runtime created
    // during an await below carries a fresh timestamp, so it fails the idle check anyway.
    for (const [keyId, bridge] of this.#bridges) {
      if (keyId === this.#pinnedKeyId) continue;
      if (this.#starting.has(keyId)) continue;
      if (now - (this.#lastActive.get(keyId) ?? now) < idleMs) continue;
      this.#bridges.delete(keyId);
      this.#lastActive.delete(keyId);
      reclaimed.push(keyId);
      // eslint-disable-next-line no-await-in-loop
      await bridge.dispose().catch((): undefined => undefined);
    }
    return reclaimed;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#reclaimTimer) clearInterval(this.#reclaimTimer);
    this.#reclaimTimer = null;
    await Promise.allSettled(this.#starting.values());
    await Promise.allSettled([...this.#sessionStarts.values()].map(({ promise }) => promise));
    const bridges = [...this.#bridges.values()];
    this.#bridges.clear();
    this.#starting.clear();
    this.#sessionStarts.clear();
    this.#conversationKeys.clear();
    this.#lastActive.clear();
    await Promise.all(bridges.map((bridge) => bridge.dispose()));
  }

  #touch(conversationId: string): void {
    const key = this.#conversationKeys.get(conversationId);
    if (key) this.#lastActive.set(runtimeKeyId(key), Date.now());
  }

  async #startSession(
    conversationId: string,
    key: DshRuntimeKey,
    create: () => Promise<DshSession>
  ): Promise<DshSession> {
    const existing = this.getSession(conversationId);
    if (existing) return existing;
    const keyId = runtimeKeyId(key);
    const pending = this.#sessionStarts.get(conversationId);
    if (pending) {
      if (pending.keyId !== keyId) {
        throw new Error(`Conversation runtime key changed during startup: ${conversationId}`);
      }
      return await pending.promise;
    }

    const promise = create()
      .then((session) => {
        if (this.#disposed) throw new Error('The dsh runtime pool is disposed.');
        this.#conversationKeys.set(conversationId, key);
        this.#lastActive.set(keyId, Date.now());
        return session;
      })
      .finally(() => this.#sessionStarts.delete(conversationId));
    this.#sessionStarts.set(conversationId, { keyId, promise });
    return await promise;
  }

  async #bridge(key: DshRuntimeKey): Promise<DshBridge> {
    if (this.#disposed) throw new Error('The dsh runtime pool is disposed.');
    const keyId = runtimeKeyId(key);
    const existing = this.#bridges.get(keyId);
    if (existing) {
      this.#lastActive.set(keyId, Date.now());
      return existing;
    }

    const pending = this.#starting.get(keyId);
    if (pending) return await pending;

    const starting = (async () => {
      // Guarded rather than `await this.#prepare?.()`: an unconditional await would push
      // port creation past a microtask for the no-expert key, which has nothing to prepare.
      if (this.#prepare) await this.#prepare(key);
      const bridge = new DshBridge({ port: this.#createPort(key) });
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
      this.#bridges.set(keyId, bridge);
      this.#lastActive.set(keyId, Date.now());
      this.#scheduleReclaim();
      return bridge;
    })().finally(() => this.#starting.delete(keyId));
    this.#starting.set(keyId, starting);
    return await starting;
  }

  /** One unref'd interval for the whole pool, started with the first runtime. */
  #scheduleReclaim(): void {
    if (this.#reclaimTimer || this.#idleMs === false) return;
    const period = Math.max(30_000, Math.floor(this.#idleMs / 3));
    this.#reclaimTimer = setInterval(() => void this.reclaimIdle(), period);
    this.#reclaimTimer.unref?.();
  }

  #conversationBridge(conversationId: string): DshBridge {
    const key = this.#conversationKeys.get(conversationId);
    const bridge = key ? this.#bridges.get(runtimeKeyId(key)) : undefined;
    if (!bridge) throw new Error(`No dsh runtime for conversation: ${conversationId}`);
    return bridge;
  }
}
