#!/usr/bin/env node
/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMcpSpawnCommand, resolveBrowserWsEndpoint } from './browserServerPort';

const logDiagnostic = (message: string): void => {
  process.stderr.write(`[builtin-mcp-browser] ${message}\n`);
};

const wsEndpoint = resolveBrowserWsEndpoint({ env: process.env });
if (!wsEndpoint) {
  logDiagnostic('CDP bridge endpoint is unavailable; refusing to launch a hidden browser.');
  process.exit(1);
}

/**
 * build-mcp-servers.js copies the pinned upstream runtime beside this launcher.
 * Both paths are unpacked for packaged builds because this process is plain Node,
 * which cannot execute files from Electron's ASAR virtual filesystem.
 */
const runtimeEntry = join(__dirname, 'chrome-devtools-mcp', 'bin', 'chrome-devtools-mcp.js');
if (!existsSync(runtimeEntry)) {
  logDiagnostic(`Bundled Chrome DevTools MCP runtime is missing: ${runtimeEntry}`);
  process.exit(1);
}
const runtimeManifestPath = join(__dirname, 'chrome-devtools-mcp', 'runtime-manifest.json');
try {
  const manifest = JSON.parse(readFileSync(runtimeManifestPath, 'utf8')) as { entrySha256?: string };
  const actual = createHash('sha256').update(readFileSync(runtimeEntry)).digest('hex');
  if (!manifest.entrySha256 || manifest.entrySha256 !== actual) throw new Error('entry checksum mismatch');
} catch (error) {
  logDiagnostic(`Bundled runtime validation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const spawnPlan = buildMcpSpawnCommand({
  platform: process.platform,
  runtimeExecutable: process.execPath,
  runtimeEntry,
  wsEndpoint,
});

logDiagnostic('Starting the bundled Chrome DevTools MCP runtime.');
const child = spawn(spawnPlan.command, spawnPlan.args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: 'true',
  },
  windowsHide: spawnPlan.windowsHide,
});

child.on('error', (error) => {
  logDiagnostic(`Failed to start bundled runtime: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => child.kill(signal));
}
