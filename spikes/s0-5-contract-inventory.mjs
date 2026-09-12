import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const BRIDGE_FILE = join(ROOT, 'packages', 'desktop', 'src', 'common', 'adapter', 'ipcBridge.ts');
const SCHEMA_FILE = join(ROOT, 'packages', 'desktop', 'src', 'process', 'services', 'database', 'schema.ts');
const REPORT_BASE = join(HERE, '.tmp', 'reports', 's0-5-contract-inventory');

const tsPath = join(ROOT, 'node_modules', 'typescript', 'lib', 'typescript.js');
const ts = await import(pathToFileURL(tsPath).href);

const HIDDEN_NAMESPACES = new Set([
  'autoUpdate',
  'bedrock',
  'channel',
  'cron',
  'document',
  'excelPreview',
  'extensions',
  'google',
  'googleAuth',
  'hub',
  'openclawConversation',
  'pptPreview',
  'preview',
  'remoteAgent',
  'update',
  'webui',
  'wordPreview',
]);
const PERSISTED_NAMESPACES = new Set([
  'assistants',
  'database',
  'project',
  'sessionMention',
  'sidebar',
  'task',
  'team',
]);
const ACP_DIRECT = new Set([
  'acpConversation.sendMessage',
  'acpConversation.responseStream',
  'acpConversation.setConfigOption',
  'conversation.askSideQuestion',
  'conversation.confirmMessage',
  'conversation.responseStream',
  'conversation.sendMessage',
  'conversation.stop',
  'conversation.turnCompleted',
  'runtime.statusChanged',
]);

function classify(name) {
  const namespace = name.split('.')[0];
  if (HIDDEN_NAMESPACES.has(namespace)) return '隐藏入口';
  if (ACP_DIRECT.has(name)) return 'ACP 直接满足';
  if (PERSISTED_NAMESPACES.has(namespace)) return 'bridge 持久化';
  return 'bridge 领域逻辑';
}

function transport(text) {
  const http = text.match(/http(Get|Post|Put|Patch|Delete)\s*</);
  if (http) return `HTTP ${http[1].toUpperCase()}`;
  if (/ws(?:Mapped)?Emitter\s*</.test(text)) return 'WS event';
  if (/bridge\.buildProvider/.test(text)) return 'native IPC';
  if (/^[\w.]+$/.test(text.trim())) return 'alias';
  return 'custom';
}

function routesIn(node) {
  const routes = new Set();
  function visit(current) {
    if (ts.isStringLiteralLike(current) && (current.text.startsWith('/api/') || current.text.includes('.'))) {
      routes.add(current.text);
    } else if (ts.isTemplateExpression(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
      const text = current.getText().slice(1, -1);
      if (text.startsWith('/api/')) routes.add(text);
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return [...routes].filter((route) => route.startsWith('/api/') || /^[a-z][\w-]+\.[\w.-]+$/.test(route));
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  return node.getText();
}

function collectObject(namespace, object, sourceFile, result, prefix = '') {
  for (const property of object.properties) {
    if (
      !ts.isPropertyAssignment(property) &&
      !ts.isShorthandPropertyAssignment(property) &&
      !ts.isMethodDeclaration(property)
    ) {
      continue;
    }
    const key = propertyName(property.name);
    const path = `${namespace}.${prefix}${key}`;
    const initializer = ts.isPropertyAssignment(property) ? property.initializer : undefined;
    if (initializer && ts.isObjectLiteralExpression(initializer)) {
      collectObject(namespace, initializer, sourceFile, result, `${prefix}${key}.`);
      continue;
    }
    const text = (initializer ?? property).getText(sourceFile);
    result.push({
      name: path,
      classification: classify(path),
      transport: transport(text),
      routes: routesIn(initializer ?? property),
    });
  }
}

function scanBridge() {
  const text = readFileSync(BRIDGE_FILE, 'utf8');
  const source = ts.createSourceFile(BRIDGE_FILE, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const entries = [];
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer ||
        !ts.isObjectLiteralExpression(declaration.initializer)
      )
        continue;
      collectObject(declaration.name.text, declaration.initializer, source, entries);
    }
  }
  return entries.toSorted((a, b) => a.name.localeCompare(b.name));
}

function scanSchema() {
  const text = readFileSync(SCHEMA_FILE, 'utf8');
  const tables = [...text.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)/g)].map((match) => match[1]);
  const version = Number(text.match(/CURRENT_DB_VERSION\s*=\s*(\d+)/)?.[1]);
  return { tables: [...new Set(tables)].toSorted(), version };
}

const entries = scanBridge();
const schema = scanSchema();
const namespaces = [...new Set(entries.map((entry) => entry.name.split('.')[0]))].toSorted();
const counts = Object.fromEntries(
  ['ACP 直接满足', 'bridge 领域逻辑', 'bridge 持久化', '隐藏入口'].map((kind) => [
    kind,
    entries.filter((entry) => entry.classification === kind).length,
  ])
);
const required = [
  'conversation.sendMessage',
  'conversation.stop',
  'conversation.responseStream',
  'conversation.turnCompleted',
  'acpConversation.setConfigOption',
  'database.getConversationMessages',
  'team.create',
  'team.sendMessage',
  'team.interruptAgent',
  'team.cancelRun',
];
const coreTables = ['conversations', 'messages', 'teams', 'mailbox', 'team_tasks', 'dsh_turns', 'dsh_updates'];
const errors = [
  ...required
    .filter((name) => !entries.some((entry) => entry.name === name))
    .map((name) => `missing bridge contract: ${name}`),
  ...coreTables.filter((name) => !schema.tables.includes(name)).map((name) => `missing schema table: ${name}`),
  ...(schema.version !== 27 ? [`expected schema v27, found v${schema.version}`] : []),
  ...(entries.length < 100 ? [`expected at least 100 bridge operations, found ${entries.length}`] : []),
];

const report = {
  id: 'S0-5',
  verdict: errors.length === 0 ? 'GO' : 'NO-GO',
  source: BRIDGE_FILE,
  operationCount: entries.length,
  namespaceCount: namespaces.length,
  namespaces,
  counts,
  schema,
  migration: {
    sourceVersion: 'SQLite PRAGMA user_version 0..26',
    targetVersion: 27,
    backup:
      'Copy aionui.db plus -wal/-shm siblings before opening the v27 writer; fsync and retain until first successful launch.',
    handoff:
      'Reuse runLegacyDatabaseMigrations and repairLegacyHandoffSchema, then add dsh bridge tables in migration v27.',
    rollback:
      'Before first v27 write, restore the trio from backup. After v27 writes, export user-visible history; do not run destructive SQL downgrade.',
  },
  errors,
  entries,
};

mkdirSync(dirname(REPORT_BASE), { recursive: true });
writeFileSync(`${REPORT_BASE}.json`, `${JSON.stringify(report, null, 2)}\n`);
const rows = entries.map((entry) => {
  const routes = entry.routes.length
    ? entry.routes.map((route) => `\`${route.replaceAll('|', '\\|')}\``).join('<br>')
    : '-';
  return `| \`${entry.name}\` | ${entry.classification} | ${entry.transport} | ${routes} |`;
});
const markdown = [
  `# S0-5 - ${report.verdict}`,
  '',
  `Scanned ${entries.length} operations in ${namespaces.length} exported \`ipcBridge\` namespaces. SQLite baseline is v${schema.version}.`,
  '',
  '## Migration decision',
  '',
  `- Backup: ${report.migration.backup}`,
  `- Handoff: ${report.migration.handoff}`,
  `- Rollback: ${report.migration.rollback}`,
  '- Credentials are excluded from SQLite migration and remain credential-store references.',
  '',
  '## Classification totals',
  '',
  '| Classification | Count |',
  '|---|---:|',
  ...Object.entries(counts).map(([kind, count]) => `| ${kind} | ${count} |`),
  '',
  '## Contract inventory',
  '',
  '| Facade operation | Owner | Transport today | Endpoint/event |',
  '|---|---|---|---|',
  ...rows,
  '',
  '## SQLite baseline',
  '',
  `- Schema version: ${schema.version}`,
  `- Tables: ${schema.tables.map((table) => `\`${table}\``).join(', ')}`,
  '',
  ...(errors.length ? ['## Blocking errors', '', ...errors.map((error) => `- ${error}`), ''] : []),
].join('\n');
writeFileSync(`${REPORT_BASE}.md`, markdown);
console.log(`S0-5 verdict: ${report.verdict}`);
console.log(`ipcBridge operations: ${entries.length}`);
console.log(`SQLite schema: v${schema.version}, ${schema.tables.length} tables`);
console.log(`report: ${REPORT_BASE}.md`);
process.exitCode = errors.length === 0 ? 0 : 1;
