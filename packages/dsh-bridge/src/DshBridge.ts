import { randomUUID } from 'node:crypto';
import { mapStopReason } from './updateMapper';
import type { BridgeStopReason, DshBridgeOptions, DshMcpServer, DshSession } from './types';

export class DshBridge {
  readonly #port: DshBridgeOptions['port'];
  readonly #sessions = new Map<string, DshSession>();
  readonly #sessionStarts = new Map<string, Promise<DshSession>>();
  #started = false;
  #disposed = false;

  constructor(options: DshBridgeOptions) {
    this.#port = options.port;
  }

  async start(): Promise<void> {
    if (this.#disposed) throw new Error('The dsh bridge is disposed.');
    if (this.#started) return;
    const initialized = await this.#port.initialize();
    if (initialized.protocolVersion !== 1) {
      throw new Error(`Unsupported ACP protocol version: ${initialized.protocolVersion}`);
    }
    this.#started = true;
  }

  async createSession(conversationId: string, cwd: string, mcpServers?: readonly DshMcpServer[]): Promise<DshSession> {
    this.#assertReady();
<<<<<<< HEAD
    return await this.#startSession(conversationId, cwd, async () => {
      const created = await this.#port.newSession(cwd, mcpServers);
      return { sessionId: created.sessionId, configOptions: created.configOptions ?? [] };
    });
=======
    if (this.#sessions.has(conversationId))
      throw new Error(`Conversation already has a dsh session: ${conversationId}`);
    const created = await this.#port.newSession(cwd, mcpServers);
    const session: DshSession = {
      conversationId,
      sessionId: created.sessionId,
      cwd,
      configOptions: created.configOptions ?? [],
    };
    this.#sessions.set(conversationId, session);
    this.#port.bindSession(session.sessionId, conversationId);
    return session;
>>>>>>> bc237b88135c02f5fff8c017bcef5645267a5591
  }

  async resumeSession(
    conversationId: string,
    sessionId: string,
    cwd: string,
    mcpServers?: readonly DshMcpServer[]
  ): Promise<DshSession> {
    this.#assertReady();
<<<<<<< HEAD
    return await this.#startSession(conversationId, cwd, async () => {
      const resumed = await this.#port.resumeSession(sessionId, cwd, mcpServers);
      return { sessionId, configOptions: resumed.configOptions ?? [] };
    });
=======
    if (this.#sessions.has(conversationId))
      throw new Error(`Conversation already has a dsh session: ${conversationId}`);
    const resumed = await this.#port.resumeSession(sessionId, cwd, mcpServers);
    const session: DshSession = {
      conversationId,
      sessionId,
      cwd,
      configOptions: resumed.configOptions ?? [],
    };
    this.#sessions.set(conversationId, session);
    this.#port.bindSession(session.sessionId, conversationId);
    return session;
>>>>>>> bc237b88135c02f5fff8c017bcef5645267a5591
  }

  getSession(conversationId: string): DshSession | undefined {
    return this.#sessions.get(conversationId);
  }

  async prompt(conversationId: string, text: string, turnId: string = randomUUID()): Promise<BridgeStopReason> {
    const session = this.#requireSession(conversationId);
    if (session.activeTurnId) throw new Error(`Conversation already has an active turn: ${conversationId}`);
    session.activeTurnId = turnId;
    try {
      const result = await this.#port.prompt(session.sessionId, [{ type: 'text', text }]);
      return mapStopReason(result.stopReason);
    } finally {
      delete session.activeTurnId;
    }
  }

  async cancel(conversationId: string): Promise<boolean> {
    const session = this.#requireSession(conversationId);
    if (!session.activeTurnId) return false;
    await this.#port.cancel(session.sessionId);
    return true;
  }

  async setConfigOption(conversationId: string, configId: string, value: string): Promise<DshSession> {
    const session = this.#requireSession(conversationId);
    if (session.activeTurnId) throw new Error('Cannot change dsh session configuration during an active turn.');
    session.configOptions = await this.#port.setConfigOption(session.sessionId, configId, value);
    return session;
  }

  async closeSession(conversationId: string): Promise<void> {
    await this.#sessionStarts.get(conversationId)?.catch((): undefined => undefined);
    const session = this.#requireSession(conversationId);
    if (session.activeTurnId) await this.#port.cancel(session.sessionId);
    await this.#port.closeSession(session.sessionId);
    this.#sessions.delete(conversationId);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await Promise.allSettled(this.#sessionStarts.values());
    this.#sessionStarts.clear();
    this.#sessions.clear();
    await this.#port.dispose();
  }

  async #startSession(
    conversationId: string,
    cwd: string,
    create: () => Promise<{ sessionId: string; configOptions: DshSession['configOptions'] }>
  ): Promise<DshSession> {
    if (this.#sessions.has(conversationId)) {
      throw new Error(`Conversation already has a dsh session: ${conversationId}`);
    }
    const pending = this.#sessionStarts.get(conversationId);
    if (pending) return await pending;

    const starting = (async () => {
      const created = await create();
      if (this.#disposed) {
        await this.#port.closeSession(created.sessionId).catch((): undefined => undefined);
        throw new Error('The dsh bridge is disposed.');
      }
      const session: DshSession = {
        conversationId,
        sessionId: created.sessionId,
        cwd,
        configOptions: created.configOptions,
      };
      this.#sessions.set(conversationId, session);
      this.#port.bindSession(session.sessionId, conversationId);
      return session;
    })().finally(() => this.#sessionStarts.delete(conversationId));
    this.#sessionStarts.set(conversationId, starting);
    return await starting;
  }

  #assertReady(): void {
    if (this.#disposed) throw new Error('The dsh bridge is disposed.');
    if (!this.#started) throw new Error('The dsh bridge has not started.');
  }

  #requireSession(conversationId: string): DshSession {
    this.#assertReady();
    const session = this.#sessions.get(conversationId);
    if (!session) throw new Error(`No dsh session for conversation: ${conversationId}`);
    return session;
  }
}
