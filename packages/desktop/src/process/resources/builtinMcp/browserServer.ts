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
import { filterToolListFrame, JsonLineBuffer, suppressedToolCall, transformJsonLine } from './browserToolFilter';
import { BrowserToolTally } from './browserToolTally';

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
/**
 * stdin/stdout 走管道而不是 inherit，是为了在中间过一道工具过滤（见 browserToolFilter）。
 * stderr 仍然 inherit：诊断输出没有过滤的必要，转发它只会多一条可能丢日志的路径。
 *
 * stdin/stdout are piped rather than inherited so the tool filter (see browserToolFilter) can
 * sit in between. stderr stays inherited: diagnostics need no filtering, and relaying them would
 * only add one more way to lose a log line.
 */
const child = spawn(spawnPlan.command, spawnPlan.args, {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: {
    ...process.env,
    CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: 'true',
  },
  windowsHide: spawnPlan.windowsHide,
});

const writeFrame = (target: NodeJS.WritableStream, line: string): void => {
  target.write(`${line}\n`);
};

/**
 * 按工具名统计调用与失败。代理这一层是唯一同时看得见工具名和结果的地方。
 * Tallies calls and failures per tool. This proxy is the only place that sees both the tool name
 * and the outcome.
 */
const tally = new BrowserToolTally();

/**
 * 客户端 -> runtime。被抑制的工具调用在这里就地应答，不下穿。
 * Client -> runtime. Calls to suppressed tools are answered here and never forwarded.
 */
const requestBuffer = new JsonLineBuffer();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  for (const line of requestBuffer.push(chunk)) {
    let intercepted: ReturnType<typeof suppressedToolCall> = null;
    try {
      const frame: unknown = JSON.parse(line);
      tally.observeRequest(frame);
      intercepted = suppressedToolCall(frame);
    } catch {
      // 解析不了就原样转发：协议校验是上游的事。
      // Unparseable lines are forwarded untouched; validating the protocol is upstream's job.
    }
    if (intercepted) {
      // 就地应答的失败也要计入，否则「模型反复调一个已被摘掉的工具」永远看不见。
      // Locally answered failures count too, or "the model keeps calling a dropped tool" stays invisible.
      tally.observeResponse(intercepted.response);
      writeFrame(process.stdout, JSON.stringify(intercepted.response));
    } else writeFrame(child.stdin, line);
  }
});
process.stdin.on('end', () => child.stdin.end());

/**
 * runtime -> 客户端。只改 tools/list 的结果，其余原样。
 * Runtime -> client. Only tools/list results are rewritten; everything else passes through.
 */
const responseBuffer = new JsonLineBuffer();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk: string) => {
  for (const line of responseBuffer.push(chunk)) {
    writeFrame(
      process.stdout,
      transformJsonLine(line, (frame) => {
        tally.observeResponse(frame);
        return filterToolListFrame(frame);
      })
    );
  }
});

child.on('error', (error) => {
  logDiagnostic(`Failed to start bundled runtime: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

/**
 * 退出时把画像写进 stderr，汇入应用日志。
 *
 * 只在退出时写一次，而不是边跑边写：会话中途的计数没有决策价值，而每次调用都打一行会把
 * 真正的诊断信息淹掉。
 *
 * Emit the usage picture to stderr on exit, where it joins the application log. Written once at
 * exit rather than continuously: mid-session counts inform no decision, and a line per call would
 * drown the diagnostics that matter.
 */
const logToolUsage = (): void => {
  const summary = tally.formatSummary();
  if (summary) logDiagnostic(summary);
};

child.on('exit', (code, signal) => {
  logToolUsage();
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => child.kill(signal));
}
