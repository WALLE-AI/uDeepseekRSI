/**
 * S3 — What does "one dsh process per expert" actually cost?
 *
 * Phase 2 of EXPERT_DSH_ENGINE_INTEGRATION_EXECUTION_PLAN.md changes the
 * resident process count from "at most 3 work modes" to "active modes + active
 * experts". This spike measures the two numbers that decide the idle-reclaim
 * threshold: the cold-start latency a user eats when summoning an expert whose
 * runtime is not warm, and the resident memory each extra runtime adds.
 *
 * It deliberately does NOT reuse `packages/dsh-bridge` — a spike is a decision
 * artifact and must keep running independently of that code being refactored.
 *
 * Usage:
 *   cd spikes
 *   node --env-file-if-exists=../.env expert-runtime/footprint.mjs
 *
 * Flags:
 *   --experts N   how many expert runtimes to start alongside the no-expert one (default 3)
 *   --prompt      also send one real prompt per runtime — COSTS MONEY, off by default
 *
 * Env:
 *   DSH_BIN           explicit path to dsh's lib/bin.js (default: resolved from node_modules)
 *   SPIKE_MODEL       model id used when --prompt is given
 *   SPIKE_KEEP_HOME   set to 1 to keep the throwaway DSH_HOMEs for inspection
 */

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { client as createAcpClient, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { Report } from '../lib/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPIKES = resolve(HERE, '..');
const TMP = join(SPIKES, '.tmp', 'expert-runtime');
const REPO = resolve(SPIKES, '..');
const BASE_PATCH = join(REPO, '.aionui', 'dsh-aionui.patch.yml');

const ARGS = process.argv.slice(2);
const EXPERT_COUNT = Number(ARGS[ARGS.indexOf('--experts') + 1]) || 3;
const SEND_PROMPT = ARGS.includes('--prompt');
const CUSTOM_GATEWAY = Boolean(process.env.DEEPSEEK_URL || process.env.DEEPSEEK_BASE_URL);
const MODEL = process.env.SPIKE_MODEL ?? (CUSTOM_GATEWAY ? 'deepseek-ai/DeepSeek-V4-Flash' : 'deepseek-v4-flash');

const report = new Report(
  'S3',
  'What do cold start and resident memory cost when each expert gets its own dsh ACP process?'
);

function resolveDshBin() {
  if (process.env.DSH_BIN) return resolve(process.env.DSH_BIN);
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('@deepseek-ai/dsh/package.json');
  const manifest = require('@deepseek-ai/dsh/package.json');
  const bin = typeof manifest.bin === 'object' ? manifest.bin.dsh : manifest.bin;
  if (!bin) throw new Error('@deepseek-ai/dsh does not expose a dsh executable.');
  return resolve(dirname(manifestPath), bin);
}

/**
 * The same shape `DshApiServer` generates per expert runtime: a read-only
 * sandbox row plus a delegation tool carrying a scoped persona and tool filter.
 * Kept as a literal so the spike measures the production-sized patch even if
 * the generator changes.
 */
function expertPatch(index) {
  return [
    '- id: sandbox-policy',
    '  config:',
    '    mode: read-only',
    `    workspaceRoot: ${JSON.stringify(join(TMP, `workspace-${index}`))}`,
    '',
    '- insert:',
    `    - id: expert-member-probe-${index}`,
    "      name: '@deepseek-ai/dsh-tool-subagent'",
    '      config:',
    '        provider: spawn',
    `        toolName: expert__probe_${index}`,
    '        backgroundMode: one-shot',
    '        enableRunInBackground: false',
    '        maxDepth: 1',
    `        persona: ${JSON.stringify(`You are probe expert #${index}. Your working directory is {{cwd}}.`)}`,
    '        toolFilter:',
    '          allow: [read, glob, grep]',
    '',
  ].join('\n');
}

/** Start one dsh ACP runtime the way the bridge does, and time its handshake. */
async function startRuntime(label, { dshHome, patchPaths, workspace, persona }) {
  mkdirSync(dshHome, { recursive: true });
  mkdirSync(workspace, { recursive: true });

  const spawnedAt = Date.now();
  const args = [resolveDshBin(), '--profile', 'acp'];
  for (const patchPath of patchPaths) args.push('--patch', patchPath);
  const child = spawn(process.execPath, args, {
    cwd: workspace,
    windowsHide: process.platform === 'win32',
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      NO_COLOR: '1',
      AIONUI_DSH_PERSONA: persona,
      AIONUI_SKILLS_DIRS_JSON: '[]',
      AIONUI_DEEPSEEK_MODELS_JSON: JSON.stringify([MODEL]),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-4096);
  });
  const processSpawnedMs = Date.now() - spawnedAt;

  const app = createAcpClient({ name: 'udeepseekrsi-spike-expert-runtime' })
    .onNotification(methods.client.session.update, () => Promise.resolve())
    .onRequest(methods.client.session.requestPermission, () => Promise.resolve({ outcome: { outcome: 'cancelled' } }));
  const output = Readable.toWeb(child.stdout);
  const connection = app.connect(ndJsonStream(Writable.toWeb(child.stdin), output));
  void connection.closed.catch(() => undefined);

  const initializedAt = Date.now();
  await connection.agent.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  });
  const acpInitializedMs = Date.now() - initializedAt;

  const sessionAt = Date.now();
  const session = await connection.agent.request(methods.agent.session.new, { cwd: workspace, mcpServers: [] });
  const sessionNewMs = Date.now() - sessionAt;

  return {
    label,
    pid: child.pid,
    child,
    connection,
    sessionId: session.sessionId,
    timings: {
      processSpawnedMs,
      acpInitializedMs,
      sessionNewMs,
      coldStartMs: Date.now() - spawnedAt,
    },
    diagnostics: () => stderr.trim(),
    async dispose() {
      child.stdin.end();
      const exited = new Promise((resolveExit) => child.once('exit', () => resolveExit()));
      const clean = await Promise.race([
        exited.then(() => true),
        new Promise((r) => setTimeout(() => r(false), 3_000)),
      ]);
      if (clean) return;
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3_000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    },
  };
}

/**
 * Resident set size in MB for a pid and its descendants.
 *
 * dsh spawns worker threads inside one process, so the pid's own RSS is the
 * number that matters; child helper processes (sandbox runners) are transient
 * and deliberately not chased.
 */
async function residentMb(pid) {
  const command =
    process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`]]
      : ['ps', ['-o', 'rss=', '-p', String(pid)]];
  return await new Promise((resolveRss) => {
    const probe = spawn(command[0], command[1], { windowsHide: true });
    let out = '';
    probe.stdout.on('data', (chunk) => (out += chunk.toString()));
    probe.once('error', () => resolveRss(null));
    probe.once('exit', () => {
      const value = Number(out.trim().split(/\s+/)[0]);
      if (!Number.isFinite(value) || value <= 0) return resolveRss(null);
      // win32 reports bytes, ps reports kilobytes.
      resolveRss(process.platform === 'win32' ? value / 1024 / 1024 : value / 1024);
    });
  });
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).toSorted((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

async function main() {
  if (!SEND_PROMPT) {
    console.log('  (no --prompt: initialize + session/new only, no model calls, no API cost)\n');
  }
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });

  report.fact('base_patch', BASE_PATCH);
  report.fact('expert_runtimes', EXPERT_COUNT);
  report.fact('sends_prompt', SEND_PROMPT);
  report.fact('model', SEND_PROMPT ? MODEL : '(unused)');

  const runtimes = [];

  await report.check('no-expert runtime starts (the prewarm key)', { blocking: true }, async () => {
    const runtime = await startRuntime('office::', {
      dshHome: join(TMP, 'home-no-expert'),
      patchPaths: [BASE_PATCH],
      workspace: join(TMP, 'workspace-no-expert'),
      persona: 'You are an office productivity agent. Your working directory is {{cwd}}.',
    });
    runtimes.push(runtime);
    return runtime.timings;
  });

  for (let index = 0; index < EXPERT_COUNT; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    await report.check(`expert runtime #${index} starts`, { blocking: index === 0 }, async () => {
      const patchPath = join(TMP, `expert-${index}.patch.yml`);
      writeFileSync(patchPath, expertPatch(index));
      const runtime = await startRuntime(`office:probe-${index}:rev`, {
        dshHome: join(TMP, `home-expert-${index}`),
        patchPaths: [BASE_PATCH, patchPath],
        workspace: join(TMP, `workspace-${index}`),
        persona: `You are probe expert #${index}. Your working directory is {{cwd}}.`,
      });
      runtimes.push(runtime);
      return runtime.timings;
    });
  }

  if (SEND_PROMPT) {
    await report.check('each runtime answers one prompt', { blocking: false }, async () => {
      const results = [];
      for (const runtime of runtimes) {
        const startedAt = Date.now();
        // eslint-disable-next-line no-await-in-loop
        const result = await runtime.connection.agent.request(methods.agent.session.prompt, {
          sessionId: runtime.sessionId,
          prompt: [{ type: 'text', text: 'Reply with the single word: ok' }],
        });
        results.push({ label: runtime.label, stopReason: result.stopReason, ms: Date.now() - startedAt });
      }
      return results;
    });
  }

  await report.check('resident memory after warm-up', { blocking: false }, async () => {
    // Give the runtimes a moment to settle before sampling.
    await new Promise((r) => setTimeout(r, 2_000));
    const samples = [];
    for (const runtime of runtimes) {
      // eslint-disable-next-line no-await-in-loop
      samples.push({ label: runtime.label, pid: runtime.pid, rssMb: await residentMb(runtime.pid) });
    }
    const expertSamples = samples.slice(1).map((sample) => sample.rssMb);
    const total = samples.reduce((sum, sample) => sum + (sample.rssMb ?? 0), 0);
    return {
      samples,
      rssPerRuntimeMb: median(expertSamples),
      totalRssMb: Number(total.toFixed(1)),
      note: samples.some((s) => s.rssMb === null) ? 'some RSS probes failed; see samples' : undefined,
    };
  });

  await report.check('cold-start summary', { blocking: false }, () => {
    const expertTimings = runtimes.slice(1).map((runtime) => runtime.timings.coldStartMs);
    return {
      noExpertColdStartMs: runtimes[0]?.timings.coldStartMs ?? null,
      expertColdStartMsMedian: median(expertTimings),
      expertColdStartMs: expertTimings,
    };
  });

  for (const runtime of runtimes) {
    const diagnostics = runtime.diagnostics();
    if (diagnostics) report.fact(`stderr:${runtime.label}`, diagnostics.slice(0, 500));
    // eslint-disable-next-line no-await-in-loop
    await runtime.dispose();
  }
  if (process.env.SPIKE_KEEP_HOME !== '1') rmSync(TMP, { recursive: true, force: true });

  return report.finish(join(SPIKES, '.tmp', 'reports', 'expert-runtime-footprint'));
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
