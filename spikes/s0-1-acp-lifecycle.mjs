/**
 * S0-1 (BLOCKING) — Can `dsh --profile acp` carry an interactive desktop chat client on Windows?
 *
 * This is the single check that decides whether the whole AionUi-shell plan is
 * viable. The plan's original phase 2 selected the SDK JSON-RPC channel
 * (`packages/sdk/protocol`), whose entire surface is `initialize`,
 * `session/prompt`, `shutdown` — no cancel, no permission requests, no session
 * management, and provider/model/cwd frozen process-wide at initialize. ACP is
 * the only public dsh channel that claims all four. This spike proves or
 * disproves that claim on the real target platform.
 *
 * Every check answers a question the bridge design depends on:
 *
 *   spawn / initialize     — does the profile boot at all, and what does it advertise?
 *   session/new            — is cwd really per-session? (decides process-pool vs single process)
 *   prompt streaming       — WHICH session/update kinds actually arrive?
 *                            (decides how much of AionUi's renderer can be fed)
 *   session/cancel         — is there a working stop button?
 *   session/request_permission — can the approval dialog be wired?
 *   set_config_option      — can the model be switched without a restart?
 *   list / resume / close  — who owns conversation persistence?
 *   multi-session          — can one connection carry N teammates? (decides Team design)
 *
 * Usage:
 *   cd spikes && npm install
 *   set DEEPSEEK_API_KEY=...        (PowerShell: $env:DEEPSEEK_API_KEY="...")
 *   node s0-1-acp-lifecycle.mjs
 *
 * Optional env:
 *   DSH_BIN            explicit path to dsh's lib/bin.js (default: resolved from node_modules)
 *   SPIKE_MODEL        model for session A            (default deepseek-v4-flash)
 *   SPIKE_MODEL_ALT    model to switch to in the config-option check
 *   SPIKE_KEEP_HOME    set to 1 to keep the throwaway DSH_HOME for inspection
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { client as createAcpClient, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { Report, withTimeout } from './lib/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = join(HERE, '.tmp', 's0-1');
const DSH_HOME = join(TMP, 'dsh-home');
const WS_A = join(TMP, 'workspace-a');
const WS_B = join(TMP, 'workspace-b');
const PATCH = join(TMP, 'spike.cordis.patch.yml');
const PERMISSION_REJECT_TARGET = join(TMP, 'permission-reject.txt');
const PERMISSION_ALLOW_TARGET = join(TMP, 'permission-allow.txt');

const CUSTOM_GATEWAY = Boolean(process.env.DEEPSEEK_URL || process.env.DEEPSEEK_BASE_URL);
const PROVIDER = CUSTOM_GATEWAY ? 'spike-gateway' : 'deepseek-official';
const MODEL = process.env.SPIKE_MODEL ?? (CUSTOM_GATEWAY ? 'deepseek-ai/DeepSeek-V4-Flash' : 'deepseek-v4-flash');
const MODEL_ALT = process.env.SPIKE_MODEL_ALT ?? (CUSTOM_GATEWAY ? 'deepseek-ai/DeepSeek-V3.2' : 'deepseek-v4-pro');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function selectOptions(option) {
  if (!option || option.type !== 'select' || !Array.isArray(option.options)) return [];
  return option.options.flatMap((item) => (Array.isArray(item.options) ? item.options : [item]));
}

const report = new Report(
  'S0-1',
  "Does `dsh --profile acp` expose enough of a contract to back AionUi's chat, stop button, permission dialog, model switcher and Team panel on Windows?"
);

// ---------------------------------------------------------------- environment

function resolveDshBin() {
  if (process.env.DSH_BIN) return resolve(process.env.DSH_BIN);
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('@deepseek-ai/dsh/package.json');
  const manifest = require('@deepseek-ai/dsh/package.json');
  const bin = typeof manifest.bin === 'object' ? manifest.bin.dsh : manifest.bin;
  if (!bin) throw new Error('@deepseek-ai/dsh declares no `dsh` bin — is the install complete?');
  return resolve(dirname(manifestPath), bin);
}

function prepare() {
  rmSync(TMP, { recursive: true, force: true });
  for (const dir of [TMP, DSH_HOME, WS_A, WS_B]) mkdirSync(dir, { recursive: true });
  // Seed both workspaces so the agent has something real to read, and so a
  // write-tool call has a plausible target inside the sandbox boundary.
  writeFileSync(join(WS_A, 'NOTES.md'), '# workspace A\n\nthe magic number is 4172\n');
  writeFileSync(join(WS_B, 'NOTES.md'), '# workspace B\n\nthe magic number is 9931\n');
  // Pin the route explicitly rather than trusting the bundle default, so a
  // model/provider change upstream cannot silently invalidate the spike.
  const gateway = CUSTOM_GATEWAY
    ? `- id: llm-pi-ai\n` +
      `  config:\n` +
      `    providers:\n` +
      `      spike-gateway:\n` +
      `        displayName: Spike Gateway\n` +
      `        apiKeyEnv: DEEPSEEK_API_KEY\n` +
      `        api: openai-completions\n` +
      `        baseURL: !!js process.env.DEEPSEEK_BASE_URL\n` +
      `        compat:\n` +
      `          thinkingFormat: deepseek\n` +
      `          supportsDeveloperRole: false\n` +
      `        models:\n` +
      `          - id: ${MODEL}\n` +
      `            name: ${MODEL}\n` +
      `            contextWindow: 65536\n` +
      `            maxTokens: 8192\n` +
      `          - id: ${MODEL_ALT}\n` +
      `            name: ${MODEL_ALT}\n` +
      `            contextWindow: 65536\n` +
      `            maxTokens: 8192\n`
    : '';
  writeFileSync(
    PATCH,
    `# S0-1 spike overlay: pin the ACP route so the probe is reproducible.\n` +
      gateway +
      `- id: acp\n` +
      `  config:\n` +
      `    provider: ${PROVIDER}\n` +
      `    model: ${MODEL}\n`
  );
}

function childEnv() {
  return {
    ...process.env,
    ...(!process.env.DEEPSEEK_BASE_URL && process.env.DEEPSEEK_URL
      ? { DEEPSEEK_BASE_URL: process.env.DEEPSEEK_URL }
      : {}),
    DSH_HOME,
    // dsh writes diagnostics to stderr; stdout is the ACP wire and must stay clean.
    NO_COLOR: '1',
  };
}

// -------------------------------------------------------------- acp connection

/**
 * Spawn `dsh --profile acp` and wrap its stdio in an ACP client connection.
 * Returns the agent proxy plus the observation sinks the checks read from.
 */
function connectAcp(dshBin) {
  const child = spawn(process.execPath, [dshBin, '--profile', 'acp', '--patch', PATCH], {
    cwd: WS_A,
    env: childEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  /** Every session/update seen, in order — the raw material for the renderer mapping. */
  const updates = [];
  /** Per-session accumulated assistant text. */
  const text = new Map();
  /** Every session/request_permission seen. */
  const permissions = [];
  /** How each permission request should be answered; set per check. */
  let permissionPolicy = { mode: 'reject' };
  const stderr = [];

  child.stderr.on('data', (chunk) => {
    stderr.push(chunk.toString());
    if (stderr.length > 400) stderr.splice(0, stderr.length - 400);
  });

  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });

  const app = createAcpClient({ name: 'udeepseekrsi-spike-s0-1' })
    .onNotification(methods.client.session.update, ({ params }) => {
      const kind = params.update?.sessionUpdate ?? 'unknown';
      updates.push({ at: Date.now(), sessionId: params.sessionId, kind, update: params.update });
      if (kind === 'agent_message_chunk' && params.update.content?.type === 'text') {
        text.set(params.sessionId, (text.get(params.sessionId) ?? '') + params.update.content.text);
      }
      return Promise.resolve();
    })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      permissions.push({
        at: Date.now(),
        sessionId: params.sessionId,
        toolCall: params.toolCall,
        options: params.options,
      });
      if (permissionPolicy.mode === 'allow') {
        const allow = params.options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always');
        if (allow) return Promise.resolve({ outcome: { outcome: 'selected', optionId: allow.optionId } });
      }
      if (permissionPolicy.mode === 'reject') {
        const reject = params.options.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always');
        if (reject) return Promise.resolve({ outcome: { outcome: 'selected', optionId: reject.optionId } });
      }
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    });

  const connection = app.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));

  return {
    child,
    agent: connection.agent,
    updates,
    text,
    permissions,
    stderr,
    get exited() {
      return exited;
    },
    setPermissionPolicy(mode) {
      permissionPolicy = { mode };
    },
    /** Cooperative teardown: stdin EOF, then SIGTERM, then SIGKILL. */
    async dispose() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.end();
      const exit = new Promise((r) => child.once('exit', r));
      const won = await Promise.race([exit.then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))]);
      if (won) return;
      child.kill('SIGTERM');
      const won2 = await Promise.race([exit.then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))]);
      if (won2) return;
      child.kill('SIGKILL');
      await exit;
    },
  };
}

/** Distinct `session/update` kinds observed for a session (optionally since an index). */
function kindsSeen(conn, sessionId, since = 0) {
  const counts = {};
  for (const u of conn.updates.slice(since)) {
    if (sessionId && u.sessionId !== sessionId) continue;
    counts[u.kind] = (counts[u.kind] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------- main

async function main() {
  console.log(`\n${report.id} — ${report.question}\n`);

  if (!process.env.DEEPSEEK_API_KEY) {
    console.error('DEEPSEEK_API_KEY is not set. Every prompt-driven check would fail for the wrong reason.');
    console.error('Set it and re-run:  set DEEPSEEK_API_KEY=sk-...');
    process.exit(2);
  }

  let dshBin;
  try {
    dshBin = resolveDshBin();
  } catch (error) {
    console.error(`Could not resolve the dsh binary: ${error.message}`);
    console.error('Run `npm install` in spikes/ first, or set DSH_BIN.');
    process.exit(2);
  }

  prepare();
  report.fact('dshBin', dshBin);
  report.fact('dshVersion', createRequire(import.meta.url)('@deepseek-ai/dsh/package.json').version);
  report.fact('acpSdkProtocolVersion', PROTOCOL_VERSION);
  report.fact('dshHome', DSH_HOME);
  report.fact('workspaceA', WS_A);
  report.fact('workspaceB', WS_B);
  report.fact('model', MODEL);
  report.fact('provider', PROVIDER);

  // --- preflight: does the profile even compose on this machine? -------------
  // Cheaper and far more diagnosable than discovering a broken profile through
  // a silent stdio hang.
  await report.check('preflight: `dsh --profile acp --dump-config` composes', { blocking: true }, async () => {
    const out = await new Promise((res, rej) => {
      const p = spawn(process.execPath, [dshBin, '--profile', 'acp', '--patch', PATCH, '--dump-config'], {
        cwd: WS_A,
        env: childEnv(),
      });
      let stdout = '',
        stderr = '';
      p.stdout.on('data', (d) => {
        stdout += d;
      });
      p.stderr.on('data', (d) => {
        stderr += d;
      });
      p.on('error', rej);
      p.on('exit', (code) => (code === 0 ? res(stdout) : rej(new Error(`exit ${code}\n${stderr.slice(-3000)}`))));
      setTimeout(() => {
        p.kill('SIGKILL');
        rej(new Error('dump-config timed out after 90s'));
      }, 90_000);
    });
    // Record which plugins the acp profile actually mounts. The permission
    // preset named here determines whether request_permission can ever fire.
    const mounted = [...out.matchAll(/name:\s*'?(@deepseek-ai\/[a-z0-9-]+)'?/g)].map((m) => m[1]);
    return {
      mountedPluginCount: mounted.length,
      permissionRelated: mounted.filter((n) => /permission|approval|guard|sandbox|ask/.test(n)),
      subagentProviders: mounted.filter((n) => n.includes('subagent')),
      configBytes: out.length,
    };
  });

  const conn = connectAcp(dshBin);
  let sessionA, sessionB;
  let agentCapabilities;

  try {
    // --- 1. initialize -------------------------------------------------------
    agentCapabilities = await report.check('initialize → advertised capabilities', { blocking: true }, async () => {
      const res = await withTimeout(
        conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
        60_000,
        'ACP initialize'
      );
      const caps = res.agentCapabilities ?? {};
      const session = caps.sessionCapabilities ?? caps.session ?? {};
      const detail = {
        protocolVersion: res.protocolVersion,
        promptCapabilities: caps.promptCapabilities ?? null,
        mcpCapabilities: caps.mcpCapabilities ?? null,
        // These four decide who owns conversation persistence in the bridge.
        supportsSessionList: 'list' in session,
        supportsSessionResume: 'resume' in session,
        supportsSessionClose: 'close' in session,
        supportsSessionFork: 'fork' in session,
        raw: res,
      };
      assert(
        res.protocolVersion === PROTOCOL_VERSION,
        `protocol mismatch: client=${PROTOCOL_VERSION}, server=${res.protocolVersion}`
      );
      assert(detail.supportsSessionList, 'session/list was not advertised');
      assert(detail.supportsSessionResume, 'session/resume was not advertised');
      assert(detail.supportsSessionClose, 'session/close was not advertised');
      return detail;
    });

    // --- 2. session/new with an explicit cwd ---------------------------------
    // If this works, the bridge is ONE dsh process for N conversations.
    // If cwd is ignored, it is one process per workspace — a different design.
    sessionA = await report.check('session/new honours a per-session cwd', { blocking: true }, async () => {
      const res = await withTimeout(
        conn.agent.request(methods.agent.session.new, { cwd: WS_A, mcpServers: [] }),
        60_000,
        'session/new'
      );
      if (typeof res.sessionId !== 'string') throw new Error('no sessionId in session/new result');
      return {
        sessionId: res.sessionId,
        // The advertised config options ARE the model switcher's data source.
        configOptions: res.configOptions ?? res.modes ?? null,
        raw: res,
      };
    });

    // --- 3. prompt streaming: what can the renderer actually show? -----------
    // The most consequential check in the spike. AionUi renders assistant text,
    // reasoning, tool cards and a Plan panel. dsh's ACP README says plans are
    // NOT emitted. This measures the real gap rather than trusting the doc.
    await report.check('session/prompt streams updates (renderer coverage)', { blocking: true }, async () => {
      if (!sessionA) throw new Error('no session');
      const since = conn.updates.length;
      conn.setPermissionPolicy('allow');
      const res = await withTimeout(
        conn.agent.request(methods.agent.session.prompt, {
          sessionId: sessionA.sessionId,
          prompt: [
            {
              type: 'text',
              text: 'Read NOTES.md in the working directory and tell me the magic number. Use your file-reading tool.',
            },
          ],
        }),
        180_000,
        'session/prompt'
      );
      const kinds = kindsSeen(conn, sessionA.sessionId, since);
      const answer = conn.text.get(sessionA.sessionId) ?? '';
      const detail = {
        stopReason: res.stopReason,
        updateKinds: kinds,
        // Explicit verdicts on the four renderer surfaces AionUi needs.
        rendererCoverage: {
          assistantText: (kinds.agent_message_chunk ?? 0) > 0,
          reasoning: (kinds.agent_thought_chunk ?? 0) > 0,
          toolCards: (kinds.tool_call ?? 0) + (kinds.tool_call_update ?? 0) > 0,
          planPanel: (kinds.plan ?? 0) > 0,
        },
        sawWorkspaceContent: answer.includes('4172'),
        answerPreview: answer.slice(0, 400),
      };
      assert(detail.rendererCoverage.assistantText, 'no assistant text updates reached the client');
      assert(detail.rendererCoverage.toolCards, 'no tool lifecycle updates reached the client');
      assert(detail.sawWorkspaceContent, 'the response did not prove that session A used its configured cwd');
      return detail;
    });

    // --- 4. cancel: the stop button ------------------------------------------
    // The SDK channel cannot do this at all. Verify ACP can, AND that the
    // runtime survives it — a cancel that kills the process is not a stop button.
    await report.check('session/cancel stops a turn and leaves the runtime alive', { blocking: true }, async () => {
      if (!sessionA) throw new Error('no session');
      const since = conn.updates.length;
      const prompt = conn.agent.request(methods.agent.session.prompt, {
        sessionId: sessionA.sessionId,
        prompt: [
          {
            type: 'text',
            text: 'Use the pwsh tool to run `Start-Sleep -Seconds 30; Write-Output CANCEL_TEST_DONE` in the foreground. Do not use another tool and do not answer before it finishes.',
          },
        ],
      });
      // Cancel only after the turn has demonstrably started, so this measures
      // mid-turn cancellation rather than a pre-start no-op.
      const t0 = Date.now();
      while (
        !conn.updates.slice(since).some((u) => u.sessionId === sessionA.sessionId && u.kind === 'tool_call') &&
        Date.now() - t0 < 60_000
      )
        await new Promise((r) => setTimeout(r, 100));
      if (!conn.updates.slice(since).some((u) => u.sessionId === sessionA.sessionId && u.kind === 'tool_call')) {
        throw new Error('turn produced no tool_call within 60s; nothing deterministic to cancel');
      }
      await new Promise((r) => setTimeout(r, 250));
      await conn.agent.notify(methods.agent.session.cancel, { sessionId: sessionA.sessionId });
      const res = await withTimeout(prompt, 60_000, 'prompt settlement after cancel');
      await new Promise((r) => setTimeout(r, 500));
      const detail = {
        stopReason: res.stopReason,
        cancelledCleanly: res.stopReason === 'cancelled',
        runtimeStillAlive: conn.exited === null,
        cancelLatencyMs: Date.now() - t0,
        exited: conn.exited,
      };
      assert(detail.cancelledCleanly, `cancelled prompt settled with ${res.stopReason}`);
      assert(detail.runtimeStillAlive, `dsh exited during cancellation: ${JSON.stringify(conn.exited)}`);
      return detail;
    });

    // --- 5. permission requests: the approval dialog -------------------------
    await report.check('session/request_permission supports reject and allow', { blocking: true }, async () => {
      if (!sessionA) throw new Error('no session');
      const rejectBefore = conn.permissions.length;
      conn.setPermissionPolicy('reject');
      const rejectedCommand = `Set-Content -LiteralPath '${PERMISSION_REJECT_TARGET.replaceAll("'", "''")}' -Value permission-test`;
      const rejected = await withTimeout(
        conn.agent.request(methods.agent.session.prompt, {
          sessionId: sessionA.sessionId,
          prompt: [
            {
              type: 'text',
              text: `Use the pwsh tool to run exactly \`${rejectedCommand}\`. First attempt it normally. After the sandbox denies it, retry that exact command once with sandbox_permissions set to danger-full-access and a one-sentence justification. Do not use another tool or an alternate command.`,
            },
          ],
        }),
        180_000,
        'permission-triggering prompt'
      );
      const rejectedRequests = conn.permissions.slice(rejectBefore);
      assert(rejectedRequests.length > 0, 'the reject turn produced no permission request');

      const allowBefore = conn.permissions.length;
      conn.setPermissionPolicy('allow');
      const allowedCommand = `Set-Content -LiteralPath '${PERMISSION_ALLOW_TARGET.replaceAll("'", "''")}' -Value permission-test`;
      const allowed = await withTimeout(
        conn.agent.request(methods.agent.session.prompt, {
          sessionId: sessionA.sessionId,
          prompt: [
            {
              type: 'text',
              text: `Use the pwsh tool to run exactly \`${allowedCommand}\`. First attempt it normally. After the sandbox denies it, retry that exact command once with sandbox_permissions set to danger-full-access and a one-sentence justification. Do not use another tool or an alternate command.`,
            },
          ],
        }),
        180_000,
        'allowed permission prompt'
      );
      const allowedRequests = conn.permissions.slice(allowBefore);
      assert(allowedRequests.length > 0, 'the allow turn produced no permission request');
      const first = rejectedRequests[0];
      const kinds = first.options.map((o) => o.kind);
      assert(kinds.includes('allow_once'), 'permission request did not offer allow_once');
      assert(kinds.includes('reject_once'), 'permission request did not offer reject_once');
      assert(!existsSync(PERMISSION_REJECT_TARGET), 'rejected escalation still wrote the target file');
      assert(existsSync(PERMISSION_ALLOW_TARGET), 'allowed escalation did not write the target file');
      return {
        stopReasons: [rejected.stopReason, allowed.stopReason],
        requestCounts: { reject: rejectedRequests.length, allow: allowedRequests.length },
        firstRequest: {
          toolKind: first.toolCall?.kind,
          title: first.toolCall?.title,
          optionKinds: kinds,
        },
      };
    });

    // --- 6. runtime model switching ------------------------------------------
    await report.check('session/set_config_option switches model without restart', { blocking: true }, async () => {
      if (!sessionA) throw new Error('no session');
      const options = sessionA.configOptions;
      assert(Array.isArray(options), 'session/new advertised no config options');
      const list = Array.isArray(options) ? options : Object.values(options);
      const modelOption = list.find((o) => o?.id === 'model');
      assert(modelOption, `no \`model\` config option; advertised: ${JSON.stringify(list.map((o) => o?.id))}`);
      const values = selectOptions(modelOption);
      const target = MODEL_ALT
        ? values.find((v) => v.value === MODEL_ALT || v.name === MODEL_ALT)
        : values.find((v) => v.value !== modelOption.currentValue);
      assert(
        target,
        `no alternative model among ${JSON.stringify(values.map((v) => ({ name: v.name, value: v.value })))}`
      );
      const res = await withTimeout(
        conn.agent.request(methods.agent.session.setConfigOption ?? 'session/set_config_option', {
          sessionId: sessionA.sessionId,
          configId: modelOption.id,
          value: target.value,
        }),
        60_000,
        'set_config_option'
      );
      const resultingModel = res.configOptions?.find((option) => option.id === 'model');
      assert(
        resultingModel?.currentValue === target.value,
        'set_config_option did not return the selected model as current'
      );
      const followup = await withTimeout(
        conn.agent.request(methods.agent.session.prompt, {
          sessionId: sessionA.sessionId,
          prompt: [{ type: 'text', text: 'Reply with exactly: MODEL_SWITCH_OK' }],
        }),
        180_000,
        'post-switch prompt'
      );
      assert(conn.exited === null, 'dsh exited after changing the model');
      return { switchedTo: target.value, resultingState: res, followupStopReason: followup.stopReason };
    });

    // --- 7. Team: N concurrent sessions on ONE connection --------------------
    // If this passes, phase 3 "route B" (own the orchestration, stream every
    // teammate's activity live) costs one process, not N — which inverts the
    // plan's cost comparison between route A and route B.
    await report.check('two concurrent sessions, distinct cwds, one connection', { blocking: true }, async () => {
      if (!sessionA) throw new Error('no session A');
      const res = await withTimeout(
        conn.agent.request(methods.agent.session.new, { cwd: WS_B, mcpServers: [] }),
        60_000,
        'session/new (B)'
      );
      sessionB = { sessionId: res.sessionId };
      const sinceA = conn.updates.length;
      const [ra, rb] = await withTimeout(
        Promise.all([
          conn.agent.request(methods.agent.session.prompt, {
            sessionId: sessionA.sessionId,
            prompt: [{ type: 'text', text: 'Read NOTES.md here and reply with ONLY the magic number.' }],
          }),
          conn.agent.request(methods.agent.session.prompt, {
            sessionId: sessionB.sessionId,
            prompt: [{ type: 'text', text: 'Read NOTES.md here and reply with ONLY the magic number.' }],
          }),
        ]),
        240_000,
        'concurrent prompts'
      );
      const textA = conn.text.get(sessionA.sessionId) ?? '';
      const textB = conn.text.get(sessionB.sessionId) ?? '';
      const updatesA = conn.updates.slice(sinceA).filter((u) => u.sessionId === sessionA.sessionId).length;
      const updatesB = conn.updates.slice(sinceA).filter((u) => u.sessionId === sessionB.sessionId).length;
      const detail = {
        stopReasons: [ra.stopReason, rb.stopReason],
        // Correct per-session cwd isolation is what makes a Team panel possible.
        cwdIsolationHeld: textB.includes('9931') && !textB.includes('4172'),
        updatesRoutedPerSession: { a: updatesA, b: updatesB },
        bSawOwnWorkspace: textB.includes('9931'),
      };
      assert(detail.cwdIsolationHeld, 'session B did not remain isolated to workspace B');
      assert(updatesA > 0 && updatesB > 0, 'updates were not routed for both concurrent sessions');
      assert(
        ra.stopReason === 'end_turn' && rb.stopReason === 'end_turn',
        `concurrent prompts did not finish normally: ${JSON.stringify(detail.stopReasons)}`
      );
      return detail;
    });

    // --- 8. who owns conversation persistence? -------------------------------
    await report.check('session/list excludes active sessions', { blocking: true }, async () => {
      if (!agentCapabilities?.supportsSessionList) throw new Error('session/list not advertised');
      const res = await withTimeout(
        conn.agent.request(methods.agent.session.list ?? 'session/list', { cwd: WS_A }),
        60_000,
        'session/list'
      );
      const items = res.sessions ?? res.items ?? [];
      const detail = {
        count: items.length,
        includesSessionA: items.some((s) => s.sessionId === sessionA?.sessionId),
        // Whatever is NOT in this summary shape, the bridge must store itself.
        summaryShape: items[0] ? Object.keys(items[0]) : [],
      };
      assert(!detail.includesSessionA, 'session/list unexpectedly exposed active session A as resumable');
      return detail;
    });

    await report.check('session/close then session/resume restores the session', { blocking: true }, async () => {
      if (!sessionA) throw new Error('no session');
      if (!agentCapabilities?.supportsSessionResume) throw new Error('resume not advertised');
      await withTimeout(
        conn.agent.request(methods.agent.session.close ?? 'session/close', { sessionId: sessionA.sessionId }),
        60_000,
        'session/close'
      );
      const listed = await withTimeout(
        conn.agent.request(methods.agent.session.list ?? 'session/list', { cwd: WS_A }),
        60_000,
        'session/list after close'
      );
      const listedItems = listed.sessions ?? listed.items ?? [];
      assert(
        listedItems.some((s) => s.sessionId === sessionA.sessionId),
        'closed session A was not listed as resumable'
      );
      const since = conn.updates.length;
      const res = await withTimeout(
        conn.agent.request(methods.agent.session.resume ?? 'session/resume', {
          sessionId: sessionA.sessionId,
          cwd: WS_A,
          mcpServers: [],
        }),
        60_000,
        'session/resume'
      );
      await new Promise((r) => setTimeout(r, 1500));
      const replayed = conn.updates.length - since;
      // dsh's README says resume does NOT replay history. Confirming that here
      // is what forces the bridge to own its own message store.
      const detail = {
        resumed: true,
        listedAfterClose: true,
        updatesReplayedOnResume: replayed,
        historyReplayed: replayed > 0,
        result: res,
      };
      assert(
        !detail.historyReplayed,
        `resume unexpectedly replayed ${replayed} updates; persistence assumptions changed`
      );
      return detail;
    });

    // --- 9. the recovered turn still works ------------------------------------
    await report.check('resumed session still accepts a prompt with prior context', { blocking: true }, async () => {
      if (!sessionA) throw new Error('no session');
      const before = (conn.text.get(sessionA.sessionId) ?? '').length;
      const res = await withTimeout(
        conn.agent.request(methods.agent.session.prompt, {
          sessionId: sessionA.sessionId,
          prompt: [{ type: 'text', text: 'What magic number did you find earlier? Answer with only the number.' }],
        }),
        180_000,
        'post-resume prompt'
      );
      const answer = (conn.text.get(sessionA.sessionId) ?? '').slice(before);
      const detail = {
        stopReason: res.stopReason,
        // Context surviving resume decides whether the bridge must re-send history.
        contextSurvivedResume: answer.includes('4172'),
        tail: answer.slice(-300),
      };
      assert(detail.contextSurvivedResume, 'resumed session did not retain prior model context');
      return detail;
    });
  } finally {
    await report.check('teardown: stdin EOF reaps the process on Windows', { blocking: true }, async () => {
      const t0 = Date.now();
      await conn.dispose();
      const detail = {
        ms: Date.now() - t0,
        exited: conn.exited,
        // A clean EOF exit means Electron can shut the engine down without SIGKILL.
        cleanEofExit: Date.now() - t0 < 3000 && conn.exited?.signal === null,
        stderrTail: conn.stderr.join('').slice(-1500),
      };
      assert(detail.cleanEofExit, `stdin EOF did not produce a clean exit: ${JSON.stringify(conn.exited)}`);
      return detail;
    });
  }

  const code = report.finish(join(TMP, '..', 'reports', 's0-1-acp-lifecycle'));
  if (!process.env.SPIKE_KEEP_HOME) rmSync(DSH_HOME, { recursive: true, force: true });
  process.exit(code);
}

main().catch((error) => {
  console.error('\nspike crashed outside a check:', error);
  process.exit(3);
});
