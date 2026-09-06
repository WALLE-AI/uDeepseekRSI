import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DshApiServer } from '@udeepseekrsi/dsh-bridge';
import { BUILTIN_BROWSER_MCP_NAME } from '@/common/config/constants';
import { getBuiltinMcpScriptPath } from '../utils/initStorage';
import { createDesktopShell } from './desktopShell';

type DirectBackendStatus = 'stopped' | 'starting' | 'running' | 'error';

type StartCallbacks = {
  allowPendingOnHealthTimeout?: boolean;
  onHealthTimeout?: (error: Error) => Promise<void> | void;
  onPendingExit?: (error: Error) => Promise<void> | void;
  onReady?: (port: number) => Promise<void> | void;
};

/** Runs the DeepSeek Harness compatibility BFF inside Electron main. */
export class DirectBackendManager {
  #server: DshApiServer | null = null;
  #status: DirectBackendStatus = 'stopped';
  #port: number | null = null;

  get status(): DirectBackendStatus {
    return this.#status;
  }

  get port(): number | null {
    return this.#port;
  }

  async start(
    dataDir: string,
    _logDir?: string,
    _dirs?: unknown,
    callbacks?: StartCallbacks,
    _parentPid?: number,
    _flags?: unknown
  ): Promise<number> {
    if (this.#server && this.#port) return this.#port;
    this.#status = 'starting';
    const configuredPatch = process.env.DSH_PATCH_PATH?.trim();
    const patchCandidates = [
      configuredPatch,
      join(process.resourcesPath, 'dsh', 'dsh-aionui.patch.yml'),
      resolve(process.cwd(), '.aionui', 'dsh-aionui.patch.yml'),
    ];
    const selectedPatch = patchCandidates.find((path): path is string => Boolean(path && existsSync(path)));
    const patchPaths = selectedPatch ? [selectedPatch] : [];
    const browserMcpScript = getBuiltinMcpScriptPath('builtin-mcp-browser');
    const cdpPort = process.env.AIONUI_CDP_ACTIVE_PORT?.trim();
    const cdpToken = process.env.AIONUI_CDP_BRIDGE_TOKEN?.trim();
    const mcpServers =
      existsSync(browserMcpScript) && cdpPort && cdpToken
        ? [
            {
              name: BUILTIN_BROWSER_MCP_NAME,
              command: process.execPath,
              args: [browserMcpScript],
              env: [
                { name: 'AIONUI_CDP_ACTIVE_PORT', value: cdpPort },
                { name: 'AIONUI_CDP_BRIDGE_TOKEN', value: cdpToken },
                ...(process.versions.electron ? [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }] : []),
              ],
            },
          ]
        : [];
    const server = new DshApiServer({
      cwd: process.cwd(),
      dshHome: process.env.DSH_HOME?.trim() || join(dataDir, 'dsh'),
      dataFile: join(dataDir, 'dsh-bridge-state.json'),
      patchPaths,
      env: process.env,
      mcpServers,
      desktopShell: createDesktopShell(),
    });
    try {
      const port = await server.start();
      this.#server = server;
      this.#port = port;
      this.#status = 'running';
      await callbacks?.onReady?.(port);
      return port;
    } catch (error) {
      this.#status = 'error';
      await server.stop().catch((): undefined => undefined);
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    this.#port = null;
    this.#status = 'stopped';
    await server?.stop();
  }
}
