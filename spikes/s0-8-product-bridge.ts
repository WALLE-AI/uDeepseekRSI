import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DshBridge, createDshConnection, type BridgeUpdate } from '../packages/dsh-bridge/src/index';

const here = dirname(fileURLToPath(import.meta.url));
const temporaryRoot = join(here, '.tmp', 's0-8');
const workspace = join(temporaryRoot, 'workspace');
const dshHome = join(temporaryRoot, 'dsh-home');
const patchPath = join(temporaryRoot, 'product-bridge.cordis.patch.yml');
const reportPath = join(here, '.tmp', 'reports', 's0-8-product-bridge.md');
const baseUrl = process.env.DEEPSEEK_BASE_URL ?? process.env.DEEPSEEK_URL;
const model = process.env.SPIKE_MODEL ?? 'deepseek-ai/DeepSeek-V4-Flash';

if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is required.');
if (!baseUrl) throw new Error('DEEPSEEK_URL or DEEPSEEK_BASE_URL is required.');

rmSync(temporaryRoot, { recursive: true, force: true });
mkdirSync(workspace, { recursive: true });
mkdirSync(dshHome, { recursive: true });
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(join(workspace, 'PROBE.txt'), 'product bridge marker: 7319\n');
writeFileSync(
  patchPath,
  `- id: llm-pi-ai\n` +
    `  config:\n` +
    `    providers:\n` +
    `      product-bridge-gateway:\n` +
    `        displayName: Product Bridge Gateway\n` +
    `        apiKeyEnv: DEEPSEEK_API_KEY\n` +
    `        api: openai-completions\n` +
    `        baseURL: !!js process.env.DEEPSEEK_BASE_URL\n` +
    `        compat:\n` +
    `          thinkingFormat: deepseek\n` +
    `          supportsDeveloperRole: false\n` +
    `        models:\n` +
    `          - id: ${model}\n` +
    `            name: ${model}\n` +
    `            contextWindow: 65536\n` +
    `            maxTokens: 8192\n` +
    `- id: acp\n` +
    `  config:\n` +
    `    provider: product-bridge-gateway\n` +
    `    model: ${model}\n`
);

const updates: BridgeUpdate[] = [];
const port = createDshConnection({
  cwd: workspace,
  dshHome,
  patchPaths: [patchPath],
  env: { DEEPSEEK_BASE_URL: baseUrl },
  onUpdate: (update) => updates.push(update),
  onPermissionRequest: async () => ({ cancelled: true }),
});
const bridge = new DshBridge({ port });
let verdict = 'NO-GO';
let detail = '';

try {
  await bridge.start();
  const session = await bridge.createSession('smoke-conversation', workspace);
  const stopReason = await bridge.prompt(
    'smoke-conversation',
    'Use the file-reading tool to read PROBE.txt, then reply with only the numeric marker.',
    'smoke-turn'
  );
  const kinds = new Set(updates.map((update) => update.kind));
  if (stopReason !== 'completed') throw new Error(`unexpected stop reason: ${stopReason}`);
  if (!kinds.has('assistant-text')) throw new Error('no assistant text update was mapped');
  if (!kinds.has('tool-start') || !kinds.has('tool-update')) throw new Error('tool lifecycle updates were not mapped');
  if (updates.some((update) => update.conversationId !== 'smoke-conversation')) {
    throw new Error('an update was not bound to the expected conversation');
  }
  await bridge.closeSession('smoke-conversation');
  if (bridge.getSession('smoke-conversation')) throw new Error('closed session remained published');
  verdict = 'GO';
  detail = `Mapped ${updates.length} updates across: ${[...kinds].toSorted().join(', ')}.`;
  console.log(`S0-8 verdict: ${verdict}`);
  console.log(detail);
  console.log(`session id assigned: ${Boolean(session.sessionId)}`);
} catch (error) {
  detail = error instanceof Error ? error.message : String(error);
  console.error(`S0-8 verdict: ${verdict}`);
  console.error(detail);
  process.exitCode = 1;
} finally {
  await bridge.dispose();
  writeFileSync(
    reportPath,
    `# S0-8 product bridge smoke - ${verdict}\n\n` +
      `The production bridge package was exercised against the pinned dsh ACP process and configured gateway.\n\n` +
      `- Result: ${detail}\n` +
      `- API response text and credentials were intentionally not recorded.\n`
  );
  if (verdict === 'GO' && existsSync(temporaryRoot)) rmSync(temporaryRoot, { recursive: true, force: true });
}
