import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts: Record<string, string>;
};
const buildScript = readFileSync('scripts/build-with-builder.js', 'utf8');
const reusableBuildWorkflow = readFileSync('.github/workflows/_build-reusable.yml', 'utf8');
const manualBuildWorkflow = readFileSync('.github/workflows/build-manual.yml', 'utf8');

describe('Build scripts', () => {
  it('provides an x64 fast installer build that lowers compression and skips executable editing', () => {
    const script = packageJson.scripts['build-win:x64:fast'];

    expect(script).toBeTypeOf('string');
    expect(script).toContain('ELECTRON_BUILDER_COMPRESSION_LEVEL=1');
    expect(script).toContain('node scripts/build-with-builder.js x64 --win --x64');
    expect(script).toContain('--config.win.signAndEditExecutable=false');
  });

  it('supports a temporary build-time auto-update version override', () => {
    expect(buildScript).toContain("DEBUG_AUTO_UPDATE_CURRENT_VERSION_ENV = 'AIONUI_DEBUG_AUTO_UPDATE_CURRENT_VERSION'");
    expect(buildScript).toContain('applyDebugAutoUpdateVersionOverride(packageJsonPath)');
    expect(buildScript).toContain('const originalPackageJsonText = fs.readFileSync(packageJsonPath,');
    expect(buildScript).toContain('packageJson.version = debugAutoUpdateCurrentVersion');
    expect(buildScript).toContain('fs.writeFileSync(packageJsonPath, originalPackageJsonText)');
    expect(buildScript).toMatch(/finally\s*{[\s\S]*restorePackageVersionOverride\(\);[\s\S]*}/);
  });

  it('does not prepare the retired AionCore backend in release or manual builds', () => {
    expect(reusableBuildWorkflow).not.toMatch(/aioncore/i);
    expect(manualBuildWorkflow).not.toMatch(/aioncore/i);
  });
});
