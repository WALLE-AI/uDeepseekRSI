import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { client as createAcpClient, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { mapUpdateKind } from './updateMapper';
import type {
  BridgePermissionDecision,
  BridgePermissionRequest,
  BridgeUpdate,
  DshAgentPort,
  DshMcpServer,
  DshSessionConfigOption,
} from './types';

export type CreateDshConnectionOptions = {
  cwd: string;
  dshHome: string;
  patchPaths?: string[];
  env?: NodeJS.ProcessEnv;
  mcpServers?: readonly DshMcpServer[];
  onUpdate?: (update: BridgeUpdate) => void;
  onPermissionRequest: (request: BridgePermissionRequest) => Promise<BridgePermissionDecision>;
};

type AcpResult = Record<string, unknown>;
type ProcessDshAgentPort = DshAgentPort & {
  isAlive(): boolean;
  diagnostics(): string;
};

function resolveDshBin(): string {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('@deepseek-ai/dsh/package.json');
  const manifest = require('@deepseek-ai/dsh/package.json') as { bin?: string | Record<string, string> };
  const bin = typeof manifest.bin === 'object' ? manifest.bin.dsh : manifest.bin;
  if (!bin) throw new Error('@deepseek-ai/dsh does not expose a dsh executable.');
  return resolve(dirname(manifestPath), bin);
}

function asConfigOptions(value: unknown): DshSessionConfigOption[] {
  return Array.isArray(value) ? (value as DshSessionConfigOption[]) : [];
}

function createProcessDshConnection(options: CreateDshConnectionOptions): ProcessDshAgentPort {
  const args = [resolveDshBin(), '--profile', 'acp'];
  for (const patchPath of options.patchPaths ?? []) args.push('--patch', patchPath);
  const child = spawn(process.execPath, args, {
    cwd: options.cwd,
    windowsHide: process.platform === 'win32',
    env: {
      ...process.env,
      ...options.env,
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      DSH_HOME: options.dshHome,
      NO_COLOR: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const sessionToConversation = new Map<string, string>();
  const sequenceBySession = new Map<string, number>();
  let stderr = '';
  let disposing = false;
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-8_192);
  });
  child.once('exit', (code, signal) => {
    if (disposing) return;
    const detail = stderr.trim() || 'no stderr output';
    console.error(`[dsh-bridge] dsh ACP process exited unexpectedly (code=${code}, signal=${signal}): ${detail}`);
  });

  const app = createAcpClient({ name: 'udeepseekrsi-dsh-bridge' })
    .onNotification(methods.client.session.update, ({ params }) => {
      const update = params.update as { sessionUpdate?: string };
      const sequence = (sequenceBySession.get(params.sessionId) ?? 0) + 1;
      sequenceBySession.set(params.sessionId, sequence);
      options.onUpdate?.({
        conversationId: sessionToConversation.get(params.sessionId) ?? '',
        sessionId: params.sessionId,
        sequence,
        kind: mapUpdateKind(update.sessionUpdate ?? 'unknown'),
        payload: params.update,
      });
      return Promise.resolve();
    })
    .onRequest(methods.client.session.requestPermission, async ({ params }) => {
      const decision = await options.onPermissionRequest({
        conversationId: sessionToConversation.get(params.sessionId),
        sessionId: params.sessionId,
        toolCall: params.toolCall,
        options: params.options,
      });
      return 'cancelled' in decision
        ? { outcome: { outcome: 'cancelled' as const } }
        : { outcome: { outcome: 'selected' as const, optionId: decision.optionId } };
    });
  const output = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;
  const connection = app.connect(ndJsonStream(Writable.toWeb(child.stdin), output));
  void connection.closed.catch((error: unknown) => {
    if (!disposing) {
      console.error(`[dsh-bridge] ACP transport closed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  const request = async <T>(method: unknown, params: unknown): Promise<T> => {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `ACP connection closed: dsh process exited (code=${child.exitCode}, signal=${child.signalCode}).`
      );
    }
    try {
      return (await connection.agent.request(method as never, params as never)) as T;
    } catch (error) {
      // Child exit notification can trail stdout closure by one event-loop turn.
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      if (stderr.trim()) console.error(`[dsh-bridge] dsh stderr before ACP request failure: ${stderr.trim()}`);
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `ACP connection closed: dsh process exited (code=${child.exitCode}, signal=${child.signalCode}).`,
          { cause: error }
        );
      }
      throw error;
    }
  };

  return {
    async initialize() {
      const result = await request<AcpResult>(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      return { protocolVersion: result.protocolVersion as number, capabilities: result.agentCapabilities };
    },
    async newSession(cwd, mcpServers) {
      const result = await request<AcpResult>(methods.agent.session.new, {
        cwd,
        mcpServers: mcpServers ?? options.mcpServers ?? [],
      });
      const sessionId = result.sessionId as string;
      return { sessionId, configOptions: asConfigOptions(result.configOptions) };
    },
    async resumeSession(sessionId, cwd, mcpServers) {
      const result = await request<AcpResult>(methods.agent.session.resume, {
        sessionId,
        cwd,
        mcpServers: mcpServers ?? options.mcpServers ?? [],
      });
      return { configOptions: asConfigOptions(result.configOptions) };
    },
    async closeSession(sessionId) {
      await request(methods.agent.session.close, { sessionId });
      sessionToConversation.delete(sessionId);
    },
    async prompt(sessionId, prompt) {
      const result = await request<AcpResult>(methods.agent.session.prompt, { sessionId, prompt });
      return { stopReason: result.stopReason as string };
    },
    async cancel(sessionId) {
      await connection.agent.notify(methods.agent.session.cancel, { sessionId });
    },
    async setConfigOption(sessionId, configId, value) {
      const result = await request<AcpResult>(methods.agent.session.setConfigOption, { sessionId, configId, value });
      return asConfigOptions(result.configOptions);
    },
    bindSession(sessionId, conversationId) {
      sessionToConversation.set(sessionId, conversationId);
    },
    isAlive() {
      return child.exitCode === null && child.signalCode === null;
    },
    diagnostics() {
      return stderr.trim();
    },
    async dispose() {
      disposing = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.end();
      const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
      const clean = await Promise.race([
        exited.then(() => true),
        new Promise<false>((resolveWait) => setTimeout(() => resolveWait(false), 3_000)),
      ]);
      if (clean) return;
      child.kill('SIGTERM');
      const terminated = await Promise.race([
        exited.then(() => true),
        new Promise<false>((resolveWait) => setTimeout(() => resolveWait(false), 3_000)),
      ]);
      if (terminated) return;
      child.kill('SIGKILL');
      await exited;
      if (child.exitCode && stderr) throw new Error(`dsh exited with ${child.exitCode}: ${stderr}`);
    },
  };
}

type TrackedSession = { cwd: string; mcpServers?: readonly DshMcpServer[]; conversationId?: string };

/** Keeps the direct ACP backend usable when the dsh stdio process exits while idle. */
export function createDshConnection(options: CreateDshConnectionOptions): DshAgentPort {
  let processPort = createProcessDshConnection(options);
  let initialized = false;
  let disposed = false;
  let recovery: Promise<void> | null = null;
  const sessions = new Map<string, TrackedSession>();

  const recover = async (): Promise<void> => {
    if (processPort.isAlive()) return;
    recovery ??= (async () => {
      const diagnostics = processPort.diagnostics();
      console.warn(
        `[dsh-bridge] Restarting dsh ACP process after an unexpected exit${diagnostics ? `: ${diagnostics}` : '.'}`
      );
      await processPort.dispose().catch((): undefined => undefined);
      processPort = createProcessDshConnection(options);
      await processPort.initialize();
      for (const [sessionId, session] of sessions) {
        // Session persistence is owned by dsh, so the replacement process can resume it.
        // eslint-disable-next-line no-await-in-loop
        await processPort.resumeSession(sessionId, session.cwd, session.mcpServers);
        if (session.conversationId) processPort.bindSession(sessionId, session.conversationId);
      }
    })().finally(() => (recovery = null));
    await recovery;
  };

  const ensureAlive = async (): Promise<void> => {
    if (disposed) throw new Error('The dsh connection is disposed.');
    if (initialized && !processPort.isAlive()) await recover();
  };

  return {
    async initialize() {
      if (!processPort.isAlive()) processPort = createProcessDshConnection(options);
      const result = await processPort.initialize();
      initialized = true;
      return result;
    },
    async newSession(cwd, mcpServers) {
      await ensureAlive();
      const result = await processPort.newSession(cwd, mcpServers);
      sessions.set(result.sessionId, { cwd, mcpServers });
      return result;
    },
    async resumeSession(sessionId, cwd, mcpServers) {
      await ensureAlive();
      const result = await processPort.resumeSession(sessionId, cwd, mcpServers);
      sessions.set(sessionId, { cwd, mcpServers, conversationId: sessions.get(sessionId)?.conversationId });
      return result;
    },
    async closeSession(sessionId) {
      await ensureAlive();
      await processPort.closeSession(sessionId);
      sessions.delete(sessionId);
    },
    async prompt(sessionId, prompt) {
      await ensureAlive();
      return await processPort.prompt(sessionId, prompt);
    },
    async cancel(sessionId) {
      await ensureAlive();
      await processPort.cancel(sessionId);
    },
    async setConfigOption(sessionId, configId, value) {
      await ensureAlive();
      return await processPort.setConfigOption(sessionId, configId, value);
    },
    bindSession(sessionId, conversationId) {
      const tracked = sessions.get(sessionId);
      if (tracked) tracked.conversationId = conversationId;
      processPort.bindSession(sessionId, conversationId);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await recovery?.catch((): undefined => undefined);
      sessions.clear();
      await processPort.dispose();
    },
  };
}
