import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = join(HERE, '.tmp', 's0-3');
const REPORT_BASE = join(HERE, '.tmp', 'reports', 's0-3-crash-consistency');
const TURN_ID = 'turn-001';
const CRASH_EXIT = 97;

const CRASH_POINTS = [
  'prompt_before_commit',
  'prompt_after_commit',
  'acp_send_before',
  'acp_send_after',
  'update_first_before_commit',
  'update_first_after_commit',
  'update_middle_before_commit',
  'update_middle_after_commit',
  'update_final_before_commit',
  'update_final_after_commit',
  'settlement_before',
  'settlement_after',
  'bridge_commit_before',
  'bridge_commit_after',
  'ui_complete_after',
];

function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      acp_session_id TEXT,
      completion_acknowledged INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      UNIQUE(turn_id, role)
    );
    CREATE TABLE IF NOT EXISTS updates (
      event_id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      chunk TEXT NOT NULL,
      UNIQUE(turn_id, sequence)
    );
  `);
  return db;
}

function crashAt(point, selected) {
  if (point === selected) process.exit(CRASH_EXIT);
}

function transaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    operation();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function appendUpdate(db, sequence, chunk) {
  transaction(db, () => {
    const inserted = db
      .prepare('INSERT OR IGNORE INTO updates(event_id, turn_id, sequence, chunk) VALUES (?, ?, ?, ?)')
      .run(`${TURN_ID}:${sequence}`, TURN_ID, sequence, chunk);
    if (inserted.changes === 0) return;
    const current = db.prepare("SELECT content FROM messages WHERE turn_id = ? AND role = 'assistant'").get(TURN_ID);
    db.prepare(`
      INSERT INTO messages(id, turn_id, role, content, status)
      VALUES (?, ?, 'assistant', ?, 'pending')
      ON CONFLICT(turn_id, role) DO UPDATE SET content = excluded.content
    `).run(`${TURN_ID}:assistant`, TURN_ID, `${current?.content ?? ''}${chunk}`);
  });
}

function runWorker(dbPath, ackPath, selected) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);

  crashAt('prompt_before_commit', selected);
  transaction(db, () => {
    db.prepare("INSERT OR IGNORE INTO turns(id, state) VALUES (?, 'queued')").run(TURN_ID);
    db.prepare(`
      INSERT OR IGNORE INTO messages(id, turn_id, role, content, status)
      VALUES (?, ?, 'user', 'hello', 'finish')
    `).run(`${TURN_ID}:user`, TURN_ID);
  });
  crashAt('prompt_after_commit', selected);

  crashAt('acp_send_before', selected);
  db.prepare("UPDATE turns SET state = 'running', acp_session_id = 'dsh-session-1' WHERE id = ?").run(TURN_ID);
  crashAt('acp_send_after', selected);

  const updates = [
    ['first', 1, 'alpha '],
    ['middle', 2, 'beta '],
    ['final', 3, 'omega'],
  ];
  for (const [name, sequence, chunk] of updates) {
    crashAt(`update_${name}_before_commit`, selected);
    appendUpdate(db, sequence, chunk);
    crashAt(`update_${name}_after_commit`, selected);
  }

  crashAt('settlement_before', selected);
  db.prepare("UPDATE turns SET state = 'settling' WHERE id = ?").run(TURN_ID);
  crashAt('settlement_after', selected);

  crashAt('bridge_commit_before', selected);
  transaction(db, () => {
    db.prepare("UPDATE messages SET status = 'finish' WHERE turn_id = ? AND role = 'assistant'").run(TURN_ID);
    db.prepare("UPDATE turns SET state = 'completed' WHERE id = ?").run(TURN_ID);
  });
  crashAt('bridge_commit_after', selected);

  appendFileSync(ackPath, `${TURN_ID}\n`);
  db.prepare('UPDATE turns SET completion_acknowledged = 1 WHERE id = ?').run(TURN_ID);
  crashAt('ui_complete_after', selected);
  db.close();
}

function readFileSafe(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function recover(dbPath, ackPath) {
  const db = openDb(dbPath);
  transaction(db, () => {
    db.prepare(`
      UPDATE turns
      SET state = 'interrupted', acp_session_id = NULL
      WHERE state IN ('queued', 'running', 'settling')
    `).run();
    db.prepare(`
      UPDATE messages SET status = 'error'
      WHERE role = 'assistant' AND status = 'pending'
        AND turn_id IN (SELECT id FROM turns WHERE state = 'interrupted')
    `).run();
  });
  const turn = db.prepare('SELECT * FROM turns WHERE id = ?').get(TURN_ID);
  const messages = db.prepare('SELECT * FROM messages WHERE turn_id = ? ORDER BY role').all(TURN_ID);
  const updates = db.prepare('SELECT * FROM updates WHERE turn_id = ? ORDER BY sequence').all(TURN_ID);
  const acks = readFileSafe(ackPath).trim().split(/\r?\n/).filter(Boolean);
  const assistant = messages.find((message) => message.role === 'assistant');
  const result = {
    state: turn?.state ?? 'not-created',
    acknowledged: acks.includes(TURN_ID),
    finalCount: messages.filter((message) => message.role === 'assistant' && message.status === 'finish').length,
    assistantContent: assistant?.content ?? '',
    updateCount: updates.length,
    permanentRunning: ['queued', 'running', 'settling'].includes(turn?.state),
    dshRecoveryAction: turn?.state === 'completed' ? 'resume' : turn ? 'replace-session' : 'none',
  };
  db.close();
  return result;
}

async function spawnWorker(dbPath, ackPath, crashPoint) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', dbPath, ackPath, crashPoint], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  if (exitCode !== CRASH_EXIT)
    throw new Error(`${crashPoint}: expected exit ${CRASH_EXIT}, got ${exitCode}: ${stderr}`);
}

async function main() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const rows = [];

  for (const crashPoint of CRASH_POINTS) {
    const caseDir = join(TMP, crashPoint);
    const dbPath = join(caseDir, 'bridge.sqlite');
    const ackPath = join(caseDir, 'ui-completion.log');
    mkdirSync(caseDir, { recursive: true });
    await spawnWorker(dbPath, ackPath, crashPoint);
    const recovered = recover(dbPath, ackPath);
    const pass =
      !recovered.permanentRunning &&
      recovered.finalCount <= 1 &&
      (!recovered.acknowledged || (recovered.state === 'completed' && recovered.finalCount === 1)) &&
      (recovered.state === 'completed' || recovered.dshRecoveryAction !== 'resume');
    rows.push({ crashPoint, pass, ...recovered });
  }

  const idempotencyDir = join(TMP, 'idempotency');
  const idempotencyDb = join(idempotencyDir, 'bridge.sqlite');
  const idempotencyAck = join(idempotencyDir, 'ui-completion.log');
  runWorker(idempotencyDb, idempotencyAck, 'never');
  const db = openDb(idempotencyDb);
  appendUpdate(db, 3, 'omega');
  const duplicateCount = db
    .prepare('SELECT COUNT(*) AS count FROM updates WHERE turn_id = ? AND sequence = 3')
    .get(TURN_ID).count;
  const content = db
    .prepare("SELECT content FROM messages WHERE turn_id = ? AND role = 'assistant'")
    .get(TURN_ID).content;
  db.close();
  const idempotencyPass = duplicateCount === 1 && content === 'alpha beta omega';

  const passed = rows.every((row) => row.pass) && idempotencyPass;
  const report = {
    id: 'S0-3',
    verdict: passed ? 'GO' : 'NO-GO',
    guarantee:
      'A terminal completion is emitted only after the final assistant message and completed turn state commit durably.',
    recoveryRule: 'Any non-completed turn becomes interrupted and its dsh session is replaced, never resumed.',
    idempotencyKey: 'turn_id + ACP update sequence',
    cases: rows,
    idempotency: { pass: idempotencyPass, duplicateCount, content },
  };
  mkdirSync(dirname(REPORT_BASE), { recursive: true });
  writeFileSync(`${REPORT_BASE}.json`, `${JSON.stringify(report, null, 2)}\n`);
  const markdown = [
    `# S0-3 - ${report.verdict}`,
    '',
    `> ${report.guarantee}`,
    '',
    `- Recovery: ${report.recoveryRule}`,
    `- Idempotency key: \`${report.idempotencyKey}\``,
    `- Fault boundaries: ${rows.length}`,
    `- Idempotency replay: ${idempotencyPass ? 'PASS' : 'FAIL'}`,
    '',
    '| Boundary | Result | Recovered state | UI acknowledged | Final messages | dsh action |',
    '|---|---|---|---:|---:|---|',
    ...rows.map(
      (row) =>
        `| \`${row.crashPoint}\` | ${row.pass ? 'PASS' : 'FAIL'} | ${row.state} | ${row.acknowledged} | ${row.finalCount} | ${row.dshRecoveryAction} |`
    ),
    '',
    'The probe deliberately does not resume a dsh session for an interrupted turn. Public ACP can resume model context but cannot replay its transcript; resuming after an uncertain crash would let model context diverge from the durable UI history.',
    '',
  ].join('\n');
  writeFileSync(`${REPORT_BASE}.md`, markdown);
  console.log(`S0-3 verdict: ${report.verdict}`);
  console.log(`fault boundaries: ${rows.filter((row) => row.pass).length}/${rows.length} passed`);
  console.log(`report: ${REPORT_BASE}.md`);
  process.exitCode = passed ? 0 : 1;
}

if (process.argv[2] === '--worker') {
  runWorker(process.argv[3], process.argv[4], process.argv[5]);
} else {
  await main();
}
