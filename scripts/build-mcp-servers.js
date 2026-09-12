#!/usr/bin/env node
/**
 * Build builtin MCP server scripts as fully self-contained CJS bundles.
 *
 * electron-vite's externalizeDepsPlugin leaves all npm packages as require()
 * calls, which works for Electron's main process (ASAR virtual FS patches
 * require()) but fails when an external `node` process runs the script from
 * app.asar.unpacked — there is no ASAR support there.
 *
 * This script uses esbuild's programmatic API (instead of CLI flags) to avoid
 * shell-quoting issues with special characters in --define values.
 */

const esbuild = require('esbuild');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const SHARED_OPTIONS = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  tsconfig: path.join(ROOT, 'tsconfig.json'),
  loader: { '.wasm': 'empty' },
};

async function main() {
  await Promise.all([
    esbuild.build({
      ...SHARED_OPTIONS,
      entryPoints: [path.join(ROOT, 'packages/desktop/src/process/resources/builtinMcp/imageGenServer.ts')],
      outfile: path.join(ROOT, 'out/main/builtin-mcp-image-gen.js'),
    }),
    esbuild.build({
      ...SHARED_OPTIONS,
      entryPoints: [path.join(ROOT, 'packages/desktop/src/process/resources/builtinMcp/browserServer.ts')],
      outfile: path.join(ROOT, 'out/main/builtin-mcp-browser.js'),
    }),
  ]);

  const runtimeSource = path.join(ROOT, 'node_modules/chrome-devtools-mcp/build/src');
  const runtimeDestination = path.join(ROOT, 'out/main/chrome-devtools-mcp');
  fs.rmSync(runtimeDestination, { recursive: true, force: true });
  fs.cpSync(runtimeSource, runtimeDestination, {
    recursive: true,
    filter: (source) => !source.endsWith('.map'),
  });
  fs.copyFileSync(
    path.join(ROOT, 'node_modules/chrome-devtools-mcp/package.json'),
    path.join(runtimeDestination, 'package.json')
  );
  const runtimePackage = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'node_modules/chrome-devtools-mcp/package.json'), 'utf8')
  );
  const runtimeEntry = path.join(runtimeDestination, 'bin', 'chrome-devtools-mcp.js');
  const fileCount = fs
    .readdirSync(runtimeDestination, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile()).length;
  fs.writeFileSync(
    path.join(runtimeDestination, 'runtime-manifest.json'),
    `${JSON.stringify(
      {
        version: runtimePackage.version,
        entrySha256: crypto.createHash('sha256').update(fs.readFileSync(runtimeEntry)).digest('hex'),
        fileCount,
      },
      null,
      2
    )}\n`
  );
}

main().catch((err) => {
  console.error('MCP server build failed:', err);
  process.exit(1);
});
