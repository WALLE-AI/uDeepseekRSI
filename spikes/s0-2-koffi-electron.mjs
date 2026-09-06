/**
 * S0-2 (BLOCKING) — Can dsh's koffi-backed native layer run inside Electron?
 *
 * The plan's phase 4 proposes launching dsh through Electron's own Node runtime
 * (`ELECTRON_RUN_AS_NODE=1`) to avoid shipping a second Node. That only works if
 * koffi resolves a prebuild for Electron's ABI, not Node's — and six dsh
 * packages depend on koffi, including the Windows sandbox, session persistence
 * and subprocess management. If this fails, phase 4 must ship a real Node
 * runtime in `resources/`, which changes the installer and phase 6 entirely.
 *
 * The check is comparative: run the same probe under plain Node and under
 * Electron, then diff. A pass under Node and a fail under Electron is exactly
 * the failure this spike exists to find before phase 6.
 *
 * Usage:
 *   cd spikes && npm install
 *   node s0-2-koffi-electron.mjs
 *
 * Optional env:
 *   ELECTRON_BIN   path to electron.exe
 *                  (default: probed from ../opensource/AionUi/node_modules/electron)
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Report, skip } from './lib/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = join(HERE, 's0-2-probe.mjs');
const AIONUI = resolve(HERE, '..', 'opensource', 'AionUi');

const report = new Report(
  'S0-2',
  "Do dsh's koffi-backed packages (Windows sandbox, session persistence, subprocess) load and work under Electron's runtime, so phase 4 can use ELECTRON_RUN_AS_NODE instead of shipping a second Node?"
);

/** Locate an Electron executable: explicit env, then AionUi's own install. */
function resolveElectron() {
  if (process.env.ELECTRON_BIN) {
    const p = resolve(process.env.ELECTRON_BIN);
    return existsSync(p) ? p : null;
  }
  const dist = join(AIONUI, 'node_modules', 'electron');
  const localDist = join(HERE, 'node_modules', 'electron');
  const electronHome = existsSync(dist) ? dist : localDist;
  if (!existsSync(electronHome)) return null;
  // electron's postinstall writes the executable's name relative to dist/.
  const pathTxt = join(electronHome, 'path.txt');
  if (existsSync(pathTxt)) {
    const p = join(electronHome, 'dist', readFileSync(pathTxt, 'utf8').trim());
    if (existsSync(p)) return p;
  }
  for (const candidate of ['dist/electron.exe', 'dist/electron', 'dist/Electron.app/Contents/MacOS/Electron']) {
    const p = join(electronHome, candidate);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Run the probe under one runtime and parse its single JSON result line. */
function runProbe(command, { env = {}, label }) {
  return new Promise((res, rej) => {
    const child = spawn(command, [PROBE], {
      cwd: HERE,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (e) => rej(new Error(`could not spawn ${label}: ${e.message}`)));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rej(new Error(`${label} probe timed out after 60s`));
    }, 60_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      const marker = stdout.indexOf('__SPIKE_RESULT__');
      if (marker === -1) {
        rej(
          new Error(
            `${label} probe produced no result (exit ${code})\nstdout: ${stdout.slice(-1200)}\nstderr: ${stderr.slice(-1200)}`
          )
        );
        return;
      }
      try {
        res(
          JSON.parse(
            stdout
              .slice(marker + '__SPIKE_RESULT__'.length)
              .trim()
              .split('\n')[0]
          )
        );
      } catch (e) {
        rej(new Error(`${label} probe result was not JSON: ${e.message}`));
      }
    });
  });
}

/** Summarize a probe result down to the facts the decision turns on. */
function summarize(r) {
  const pkgs = Object.entries(r.dshPackages);
  return {
    runtime: r.runtime,
    koffiLoaded: r.koffi.loaded,
    koffiError: r.koffi.error ?? null,
    win32CallOk: r.win32Call.ok,
    win32CallError: r.win32Call.error ?? null,
    packagesOk: pkgs.filter(([, v]) => v.ok).map(([k]) => k),
    packagesBroken: pkgs.filter(([, v]) => !v.ok && !v.notInstalled).map(([k, v]) => `${k}: ${v.error}`),
    packagesNotInstalled: pkgs.filter(([, v]) => v.notInstalled).map(([k]) => k),
  };
}

function satisfiesDshEngines(version) {
  const [major, minor] = version.split('.').map(Number);
  return (major === 22 && minor >= 19) || major >= 24;
}

function assertCompletePackages(summary, label) {
  if (summary.packagesNotInstalled.length) {
    throw new Error(`${label} is missing required dsh native packages: ${summary.packagesNotInstalled.join(', ')}`);
  }
  if (summary.packagesBroken.length) {
    throw new Error(`${label} could not import dsh native packages: ${summary.packagesBroken.join(' | ')}`);
  }
  if (summary.packagesOk.length !== 6) {
    throw new Error(`${label} imported ${summary.packagesOk.length}/6 required dsh native packages`);
  }
}

async function main() {
  console.log(`\n${report.id} — ${report.question}\n`);

  const require = createRequire(import.meta.url);
  let dshVersion = null;
  try {
    dshVersion = require('@deepseek-ai/dsh/package.json').version;
  } catch {
    /* not installed */
  }
  report.fact('dshVersion', dshVersion ?? '(not installed — run npm install)');
  report.fact('hostNode', process.version);

  const electronBin = resolveElectron();
  report.fact('electronBin', electronBin ?? '(not found)');
  if (electronBin) {
    try {
      const manifest = existsSync(join(AIONUI, 'node_modules', 'electron', 'package.json'))
        ? join(AIONUI, 'node_modules', 'electron', 'package.json')
        : join(HERE, 'node_modules', 'electron', 'package.json');
      const v = require(manifest).version;
      report.fact('electronVersion', v);
    } catch {
      /* fine */
    }
  }

  // --- baseline: plain Node ---------------------------------------------------
  // Establishes that the probe and the install are sound, so a later Electron
  // failure can only be an Electron-runtime problem.
  const nodeResult = await report.check(
    'baseline: koffi + dsh native packages under plain Node',
    { blocking: true },
    async () => {
      const r = await runProbe(process.execPath, { label: 'node' });
      const s = summarize(r);
      if (!s.koffiLoaded) throw new Error(`koffi did not load under plain Node: ${s.koffiError}`);
      if (process.platform === 'win32' && !s.win32CallOk)
        throw new Error(`Win32 FFI call failed under plain Node: ${s.win32CallError}`);
      assertCompletePackages(s, 'plain Node');
      return s;
    }
  );

  // --- the actual question: Electron as Node ----------------------------------
  const electronResult = await report.check(
    'ELECTRON_RUN_AS_NODE: koffi + dsh native packages under Electron',
    { blocking: true },
    async () => {
      if (!electronBin) {
        return skip(
          'no Electron binary found — run `npm install` (or `bun install`) in opensource/AionUi, or set ELECTRON_BIN'
        );
      }
      const r = await runProbe(electronBin, { env: { ELECTRON_RUN_AS_NODE: '1' }, label: 'electron' });
      const s = summarize(r);
      if (!s.koffiLoaded) {
        throw new Error(
          `koffi did not load under ELECTRON_RUN_AS_NODE (${s.koffiError}). ` +
            `Electron NODE_MODULE_VERSION=${r.runtime.modules}. ` +
            'Phase 4 cannot use Electron as the dsh runtime as written — plan on shipping a Node runtime in resources/.'
        );
      }
      if (process.platform === 'win32' && !s.win32CallOk) {
        throw new Error(
          `koffi loaded but the Win32 call failed under Electron: ${s.win32CallError} — the Windows sandbox will not work in the packaged app.`
        );
      }
      assertCompletePackages(s, 'Electron');
      if (!satisfiesDshEngines(r.runtime.node)) {
        throw new Error(`Electron bundles Node ${r.runtime.node}, which does not satisfy dsh engines ^22.19.0 || >=24`);
      }
      return s;
    }
  );

  // --- the diff is the finding ------------------------------------------------
  await report.check('ABI comparison Node vs Electron', { blocking: false }, async () => {
    if (!nodeResult || !electronResult) return skip('one of the runtimes did not report');
    return {
      nodeModulesAbi: nodeResult.runtime.modules,
      electronModulesAbi: electronResult.runtime.modules,
      abiDiffers: nodeResult.runtime.modules !== electronResult.runtime.modules,
      nodeVersionUnderElectron: electronResult.runtime.node,
      electronVersion: electronResult.runtime.electron,
      // dsh declares engines ^22.19.0 || >=24; Electron 37 ships Node 22.x.
      // A too-old bundled Node is a separate blocker from the ABI question.
      satisfiesDshEngines: satisfiesDshEngines(electronResult.runtime.node),
      packagesOkUnderBoth: nodeResult.packagesOk.filter((p) => electronResult.packagesOk.includes(p)),
      packagesRegressedUnderElectron: nodeResult.packagesOk.filter((p) => !electronResult.packagesOk.includes(p)),
    };
  });

  process.exit(report.finish(join(HERE, '.tmp', 'reports', 's0-2-koffi-electron')));
}

main().catch((error) => {
  console.error('\nspike crashed outside a check:', error);
  process.exit(3);
});
