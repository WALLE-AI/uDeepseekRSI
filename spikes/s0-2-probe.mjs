/**
 * S0-2 inner probe — runs under whichever runtime the outer script launches
 * (plain Node, or Electron with ELECTRON_RUN_AS_NODE=1) and reports, as one
 * JSON line on stdout, whether dsh's koffi-backed packages actually load and
 * work there.
 *
 * Six dsh packages depend on koffi (FFI):
 *   fs/fs-local, host/directory-picker-native, sandbox/sandbox-windows-acl,
 *   session/session-persistence-jsonl, subprocess/subprocess-local,
 *   subprocess/win32-process
 * Between them they own the Windows sandbox, session persistence and subprocess
 * management — i.e. if koffi cannot load, dsh cannot run inside the packaged app
 * at all. Loading is not enough, so this also makes a real Win32 call.
 *
 * Printed as `__SPIKE_RESULT__ {json}` so the outer script can parse it past
 * any runtime banner noise.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const result = {
  runtime: {
    execPath: process.execPath,
    node: process.versions.node,
    v8: process.versions.v8,
    // The number that decides native-module compatibility.
    modules: process.versions.modules,
    electron: process.versions.electron ?? null,
    runAsNode: process.env.ELECTRON_RUN_AS_NODE === '1',
    arch: process.arch,
    platform: process.platform,
  },
  koffi: { loaded: false },
  win32Call: { ok: false },
  dshPackages: {},
};

// --- 1. does koffi itself load? ----------------------------------------------
try {
  const koffi = require('koffi');
  result.koffi = {
    loaded: true,
    version: koffi.version ?? null,
    // koffi resolves a prebuilt binary per runtime; record which one it picked.
    // A mismatch here is the failure mode this whole spike exists to catch.
    path: (() => {
      try {
        return require.resolve('koffi');
      } catch {
        return null;
      }
    })(),
  };

  // --- 2. a real Win32 FFI call, not just a load ------------------------------
  // Mirrors the shape dsh's sandbox uses: load a system DLL, declare a function,
  // call it, read the result back. A koffi that loads but cannot marshal is
  // just as fatal as one that will not load.
  if (process.platform === 'win32') {
    try {
      const kernel32 = koffi.load('kernel32.dll');
      const GetCurrentProcessId = kernel32.func('uint32 GetCurrentProcessId()');
      const pid = GetCurrentProcessId();
      // A struct-out call exercises marshalling, which the trivial call does not.
      const GetSystemInfo = kernel32.func('void GetSystemInfo(_Out_ void *lpSystemInfo)');
      const buf = Buffer.alloc(48);
      GetSystemInfo(buf);
      result.win32Call = {
        ok: pid === process.pid && buf.some((b) => b !== 0),
        pidMatched: pid === process.pid,
        structMarshalled: buf.some((b) => b !== 0),
      };
    } catch (error) {
      result.win32Call = { ok: false, error: String(error?.message ?? error) };
    }
  } else {
    result.win32Call = { ok: null, skipped: `not win32 (${process.platform})` };
  }
} catch (error) {
  result.koffi = { loaded: false, error: String(error?.message ?? error) };
}

// --- 3. do dsh's koffi-backed packages import? --------------------------------
// Importing the real packages catches problems koffi alone would not: a package
// that probes the ABI at module scope, or pulls a second native dependency.
const PACKAGES = [
  '@deepseek-ai/dsh-win32-process',
  '@deepseek-ai/dsh-sandbox-windows-acl',
  '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-fs-local',
  '@deepseek-ai/dsh-host-directory-picker-native',
];

for (const name of PACKAGES) {
  try {
    const mod = await import(name);
    result.dshPackages[name] = { ok: true, exports: Object.keys(mod).slice(0, 12) };
  } catch (error) {
    const message = String(error?.message ?? error);
    result.dshPackages[name] = {
      ok: false,
      // The outer gate treats both a missing package and a broken import as fatal.
      notInstalled: /Cannot find (package|module)/i.test(message),
      error: message.split('\n')[0],
    };
  }
}

console.log(`__SPIKE_RESULT__ ${JSON.stringify(result)}`);
