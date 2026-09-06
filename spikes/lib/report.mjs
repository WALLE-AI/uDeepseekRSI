/**
 * Shared check-recording + report-writing helper for the phase-0 spikes.
 *
 * A spike is a decision artifact, not a test: every check records what was
 * actually observed (including on failure), and the run always writes a report
 * even when a blocking check fails. Nothing here throws on a failed check.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** @typedef {'PASS'|'FAIL'|'SKIP'|'INFO'} Status */

export class Report {
  /**
   * @param {string} id - spike id, e.g. `S0-1`.
   * @param {string} question - the one decision this spike answers.
   */
  constructor(id, question) {
    this.id = id;
    this.question = question;
    this.startedAt = new Date().toISOString();
    /** @type {{name: string, status: Status, blocking: boolean, detail: unknown, ms: number}[]} */
    this.checks = [];
    /** @type {Record<string, unknown>} */
    this.facts = {};
  }

  /** Record an environment fact that is not itself a pass/fail check. */
  fact(key, value) {
    this.facts[key] = value;
    console.log(`  · ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }

  /**
   * Run one check. Never throws: a thrown error becomes a FAIL with its message.
   * @param {string} name
   * @param {{blocking?: boolean}} opts - blocking checks decide the spike verdict.
   * @param {() => Promise<unknown>} fn - resolve with detail, or throw to fail.
   */
  async check(name, opts, fn) {
    const blocking = opts.blocking ?? false;
    const t0 = Date.now();
    process.stdout.write(`  [${blocking ? 'BLOCKING' : 'info    '}] ${name} ... `);
    try {
      const detail = await fn();
      const ms = Date.now() - t0;
      if (detail === SKIP || (detail && detail.__skip)) {
        const reason = detail === SKIP ? 'skipped' : detail.reason;
        this.checks.push({ name, status: 'SKIP', blocking, detail: reason, ms });
        console.log(`SKIP (${reason})`);
        return undefined;
      }
      this.checks.push({ name, status: 'PASS', blocking, detail: detail ?? null, ms });
      console.log(`PASS (${ms}ms)`);
      return detail;
    } catch (error) {
      const ms = Date.now() - t0;
      const detail = {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      };
      this.checks.push({ name, status: 'FAIL', blocking, detail, ms });
      console.log(`FAIL (${ms}ms)\n           ${detail.message.split('\n').join('\n           ')}`);
      return undefined;
    }
  }

  /** `PASS` only when every blocking check passed. */
  verdict() {
    const blocking = this.checks.filter((c) => c.blocking);
    const failed = blocking.filter((c) => c.status !== 'PASS');
    return { ok: failed.length === 0, blockingTotal: blocking.length, blockingFailed: failed.map((c) => c.name) };
  }

  /**
   * Write `<out>.json` and `<out>.md`, print a summary, and return the exit code.
   * @param {string} outBase - path without extension.
   */
  finish(outBase) {
    const verdict = this.verdict();
    const payload = {
      id: this.id,
      question: this.question,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      platform: { os: process.platform, arch: process.arch, node: process.version },
      verdict,
      facts: this.facts,
      checks: this.checks,
    };
    const base = resolve(outBase);
    mkdirSync(dirname(base), { recursive: true });
    writeFileSync(`${base}.json`, `${JSON.stringify(payload, null, 2)}\n`);
    writeFileSync(`${base}.md`, this.#markdown(payload));

    console.log(`\n${'='.repeat(72)}`);
    console.log(`${this.id} verdict: ${verdict.ok ? 'GO' : 'NO-GO'}`);
    if (!verdict.ok) console.log(`  failed blocking checks: ${verdict.blockingFailed.join(', ')}`);
    console.log(`report: ${base}.md`);
    console.log('='.repeat(72));
    return verdict.ok ? 0 : 1;
  }

  #markdown(p) {
    const icon = { PASS: '✅', FAIL: '❌', SKIP: '⏭️', INFO: 'ℹ️' };
    const rows = p.checks
      .map((c) => `| ${icon[c.status]} ${c.status} | ${c.blocking ? '**blocking**' : 'info'} | ${c.name} | ${c.ms}ms |`)
      .join('\n');
    const facts = Object.entries(p.facts)
      .map(([k, v]) => `- **${k}**: \`${typeof v === 'string' ? v : JSON.stringify(v)}\``)
      .join('\n');
    const details = p.checks
      .filter((c) => c.detail !== null && c.detail !== undefined)
      .map((c) => `### ${c.name} — ${c.status}\n\n\`\`\`json\n${JSON.stringify(c.detail, null, 2)}\n\`\`\`\n`)
      .join('\n');
    return `# ${p.id} — ${p.verdict.ok ? 'GO' : 'NO-GO'}

> ${p.question}

- Ran: ${p.startedAt} → ${p.finishedAt}
- Platform: ${p.platform.os}/${p.platform.arch}, Node ${p.platform.node}
- Blocking checks: ${p.verdict.blockingTotal - p.verdict.blockingFailed.length}/${p.verdict.blockingTotal} passed
${p.verdict.blockingFailed.length ? `- **Failed:** ${p.verdict.blockingFailed.join(', ')}` : ''}

## Environment

${facts || '_none_'}

## Checks

| Result | Kind | Check | Time |
|---|---|---|---|
${rows}

## Detail

${details || '_none_'}
`;
  }
}

/** Sentinel: return this from a check body to record SKIP instead of PASS. */
export const SKIP = Symbol('skip');

/** Return `skip('reason')` from a check body to record a SKIP with a reason. */
export const skip = (reason) => ({ __skip: true, reason });

/** Reject after `ms` unless `promise` settles first. */
export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
