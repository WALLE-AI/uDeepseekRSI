import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../../..');

describe('DeepSeek Harness Windows process visibility', () => {
  it('keeps the Harness process and its PowerShell subprocesses hidden', () => {
    const connectionSource = readFileSync(resolve(repoRoot, 'packages/dsh-bridge/src/createDshConnection.ts'), 'utf8');
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      patchedDependencies?: Record<string, string>;
    };
    const patchPath = manifest.patchedDependencies?.['@deepseek-ai/dsh-subprocess-local@0.1.2-rc.1'];
    const dshPatchPath = manifest.patchedDependencies?.['@deepseek-ai/dsh@0.1.2-rc.1'];
    const attachmentPatchPath = manifest.patchedDependencies?.['@deepseek-ai/dsh-attachment-local@0.1.2-rc.1'];
    const win32PatchPath = manifest.patchedDependencies?.['@deepseek-ai/dsh-win32-process@0.1.2-rc.1'];

    expect(connectionSource).toContain("windowsHide: process.platform === 'win32'");
    expect(manifest.dependencies?.['@deepseek-ai/cordis-plugin-group']).toBe('1.0.2');
    expect(patchPath).toBe('patches/@deepseek-ai%2Fdsh-subprocess-local@0.1.2-rc.1.patch');

    const dependencyPatch = readFileSync(resolve(repoRoot, patchPath!), 'utf8');
    expect(dependencyPatch).toContain('+\t\twindowsHide: platform === "win32"');
    expect(dependencyPatch.match(/windowsHide: true/g)).toHaveLength(2);

    expect(dshPatchPath).toBe('patches/@deepseek-ai%2Fdsh@0.1.2-rc.1.patch');
    expect(readFileSync(resolve(repoRoot, dshPatchPath!), 'utf8')).toContain('pathToFileURL(INSTALL_ANCHOR).href');

    expect(attachmentPatchPath).toBe('patches/@deepseek-ai%2Fdsh-attachment-local@0.1.2-rc.1.patch');
    const attachmentPatch = readFileSync(resolve(repoRoot, attachmentPatchPath!), 'utf8');
    expect(attachmentPatch).toContain('sharpModule ??= require("sharp")');

    expect(win32PatchPath).toBe('patches/@deepseek-ai%2Fdsh-win32-process@0.1.2-rc.1.patch');
    const win32Patch = readFileSync(resolve(repoRoot, win32PatchPath!), 'utf8');
    expect(win32Patch.match(/\+\t\t\tdwFlags: 257/g)).toHaveLength(2);
    expect(win32Patch.match(/\+\t\t\twShowWindow: 0/g)).toHaveLength(2);
  });

  it('includes dynamically discovered Harness plugins in packaged builds', () => {
    const builderConfig = readFileSync(resolve(repoRoot, 'packages/desktop/electron-builder.yml'), 'utf8');
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const dynamicRuntimeDependencies = [
      '@deepseek-ai/dsh-anonymous-user-id',
      '@deepseek-ai/dsh-attachment',
      '@deepseek-ai/dsh-compaction',
      '@deepseek-ai/dsh-fs',
      '@deepseek-ai/dsh-jobs',
      '@deepseek-ai/dsh-output-retention',
      '@deepseek-ai/dsh-sandbox',
      '@deepseek-ai/dsh-session-persistence',
      '@deepseek-ai/dsh-session-query',
      '@deepseek-ai/dsh-session-telemetry',
      '@deepseek-ai/dsh-settings',
      '@deepseek-ai/dsh-shell',
      '@deepseek-ai/dsh-spill',
      '@deepseek-ai/dsh-subagent-in-process-driver',
      '@deepseek-ai/dsh-util-time',
      '@deepseek-ai/dsh-workflow',
    ];

    expect(builderConfig).toContain('- node_modules/@deepseek-ai/**/*');
    expect(builderConfig).not.toContain('node_modules/{@img,@emnapi}');
    for (const dependency of dynamicRuntimeDependencies) {
      expect(manifest.dependencies?.[dependency]).toBe('0.1.2-rc.1');
    }
    expect(manifest.optionalDependencies?.['@img/colour']).toBe('1.1.0');
    expect(manifest.optionalDependencies?.['@img/sharp-win32-x64']).toBe('0.35.4');
  });
});
