import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

export type OfficeDocumentType = 'word' | 'excel' | 'ppt';
export type OfficePreviewStatus = {
  state: 'starting' | 'installing' | 'ready' | 'error';
  message?: string;
};

export interface OfficePreviewPort {
  start(filePath: string, documentType: OfficeDocumentType): Promise<{ url: string }>;
  stop(filePath: string): Promise<void>;
  dispose(): Promise<void>;
}

export class OfficePreviewError extends Error {
  constructor(
    readonly code:
      | 'OFFICECLI_NOT_FOUND'
      | 'OFFICECLI_INSTALL_FAILED'
      | 'OFFICECLI_PORT_TIMEOUT'
      | 'OFFICECLI_START_FAILED',
    message: string
  ) {
    super(message);
    this.name = 'OfficePreviewError';
  }
}

type OfficeSession = { child: ChildProcess; url: string };

export type OfficePreviewServiceOptions = {
  env?: NodeJS.ProcessEnv;
  readyTimeoutMs?: number;
  installTimeoutMs?: number;
  emitStatus?: (documentType: OfficeDocumentType, status: OfficePreviewStatus) => void;
};

const outputLimit = 8_192;

function appendOutput(current: string, chunk: unknown): string {
  const next = `${current}${Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)}`;
  return next.length <= outputLimit ? next : next.slice(-outputLimit);
}

function runCommand(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number }
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => (stdout = appendOutput(stdout, chunk)));
    child.stderr?.on('data', (chunk) => (stderr = appendOutput(stderr, chunk)));
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function firstExecutable(candidates: Array<string | undefined>): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await access(candidate);
      return candidate;
    } catch {
      // Try the next deterministic location.
    }
  }
  return undefined;
}

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not reserve an OfficeCLI preview port.'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

export class OfficePreviewService implements OfficePreviewPort {
  readonly #env: NodeJS.ProcessEnv;
  readonly #readyTimeoutMs: number;
  readonly #installTimeoutMs: number;
  readonly #emitStatus?: OfficePreviewServiceOptions['emitStatus'];
  readonly #sessions = new Map<string, OfficeSession>();
  readonly #starting = new Map<string, Promise<{ url: string }>>();
  #installing: Promise<string> | null = null;

  constructor(options: OfficePreviewServiceOptions = {}) {
    this.#env = { ...process.env, ...options.env };
    this.#readyTimeoutMs = options.readyTimeoutMs ?? 45_000;
    this.#installTimeoutMs = options.installTimeoutMs ?? 5 * 60_000;
    this.#emitStatus = options.emitStatus;
  }

  async start(filePath: string, documentType: OfficeDocumentType): Promise<{ url: string }> {
    const active = this.#sessions.get(filePath);
    if (active && active.child.exitCode === null) return { url: active.url };
    const pending = this.#starting.get(filePath);
    if (pending) return await pending;

    const start = this.#start(filePath, documentType).finally(() => this.#starting.delete(filePath));
    this.#starting.set(filePath, start);
    return await start;
  }

  async #start(filePath: string, documentType: OfficeDocumentType): Promise<{ url: string }> {
    this.#emitStatus?.(documentType, { state: 'starting' });
    try {
      const executable = await this.#ensureOfficeCli(documentType);
      const port = await reservePort();
      const url = `http://127.0.0.1:${port}`;
      const child = spawn(executable, ['watch', filePath, '--port', String(port)], {
        cwd: dirname(filePath),
        env: { ...this.#env, BROWSER: 'none' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout?.on('data', (chunk) => (output = appendOutput(output, chunk)));
      child.stderr?.on('data', (chunk) => (output = appendOutput(output, chunk)));
      this.#sessions.set(filePath, { child, url });
      child.once('exit', () => {
        if (this.#sessions.get(filePath)?.child === child) this.#sessions.delete(filePath);
      });

      await this.#waitUntilReady(child, url, () => output);
      this.#emitStatus?.(documentType, { state: 'ready' });
      return { url };
    } catch (error) {
      const normalized =
        error instanceof OfficePreviewError
          ? error
          : new OfficePreviewError('OFFICECLI_START_FAILED', error instanceof Error ? error.message : String(error));
      this.#emitStatus?.(documentType, { state: 'error', message: normalized.code });
      throw normalized;
    }
  }

  async stop(filePath: string): Promise<void> {
    await this.#starting.get(filePath)?.catch((): undefined => undefined);
    const session = this.#sessions.get(filePath);
    if (!session) return;
    this.#sessions.delete(filePath);
    session.child.kill();
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(this.#starting.values());
    for (const session of this.#sessions.values()) session.child.kill();
    this.#sessions.clear();
  }

  async #ensureOfficeCli(documentType: OfficeDocumentType): Promise<string> {
    const existing = await this.#findOfficeCli();
    if (existing) return existing;
    this.#emitStatus?.(documentType, { state: 'installing' });
    this.#installing ??= this.#installOfficeCli().finally(() => (this.#installing = null));
    return await this.#installing;
  }

  async #findOfficeCli(): Promise<string | undefined> {
    const configured = this.#env.OFFICECLI_PATH?.trim();
    const localAppData = this.#env.LOCALAPPDATA?.trim();
    const home = this.#env.USERPROFILE?.trim() || this.#env.HOME?.trim() || homedir();
    const deterministic = await firstExecutable([
      configured,
      process.platform === 'win32' && localAppData ? join(localAppData, 'OfficeCLI', 'officecli.exe') : undefined,
      process.platform !== 'win32' ? join(home, '.local', 'bin', 'officecli') : undefined,
    ]);
    if (deterministic) return deterministic;

    const lookup = await runCommand(process.platform === 'win32' ? 'where.exe' : 'which', ['officecli'], {
      env: this.#env,
      timeoutMs: 5_000,
    }).catch((): undefined => undefined);
    return lookup?.code === 0 ? lookup.stdout.split(/\r?\n/u).find(Boolean)?.trim() : undefined;
  }

  async #installOfficeCli(): Promise<string> {
    const command =
      process.platform === 'win32'
        ? {
            executable: 'powershell.exe',
            args: [
              '-NoProfile',
              '-NonInteractive',
              '-ExecutionPolicy',
              'Bypass',
              '-Command',
              'Invoke-RestMethod https://d.officecli.ai/install.ps1 | Invoke-Expression',
            ],
          }
        : {
            executable: '/bin/sh',
            args: ['-c', 'curl -fsSL https://d.officecli.ai/install.sh | sh'],
          };
    let result: { code: number; stdout: string; stderr: string };
    try {
      result = await runCommand(command.executable, command.args, {
        env: this.#env,
        timeoutMs: this.#installTimeoutMs,
      });
    } catch (error) {
      throw new OfficePreviewError(
        'OFFICECLI_INSTALL_FAILED',
        `OfficeCLI automatic installation failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (result.code !== 0) {
      throw new OfficePreviewError(
        'OFFICECLI_INSTALL_FAILED',
        `OfficeCLI automatic installation failed (${result.code}): ${(result.stderr || result.stdout).trim()}`
      );
    }
    const installed = await this.#findOfficeCli();
    if (!installed) {
      throw new OfficePreviewError('OFFICECLI_NOT_FOUND', 'OfficeCLI installation completed but no binary was found.');
    }
    return installed;
  }

  async #waitUntilReady(child: ChildProcess, url: string, output: () => string): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < this.#readyTimeoutMs) {
      if (child.exitCode !== null) {
        this.#sessions.forEach((session, path) => {
          if (session.child === child) this.#sessions.delete(path);
        });
        throw new OfficePreviewError(
          'OFFICECLI_START_FAILED',
          `OfficeCLI exited before preview was ready (${child.exitCode}): ${output().trim()}`
        );
      }
      try {
        // Sequential polling is intentional: each request observes the server's latest state.
        // eslint-disable-next-line no-await-in-loop
        const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
        if (response.status < 500) return;
      } catch {
        // The listener can exist a little before the first document render is ready.
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    child.kill();
    throw new OfficePreviewError('OFFICECLI_PORT_TIMEOUT', `OfficeCLI did not become ready at ${url}.`);
  }
}
