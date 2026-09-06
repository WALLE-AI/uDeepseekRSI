import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backupDatabaseBeforeV27 } from '@/process/services/database/backupDatabase';
import { getMigrationsToRun } from '@/process/services/database/migrations';
import { CURRENT_DB_VERSION } from '@/process/services/database/schema';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('dsh bridge database migration', () => {
  it('adds the durable turn and idempotent update tables at v27', () => {
    const migration = getMigrationsToRun(26, 27)[0];
    const exec = vi.fn();
    migration.up({ exec } as never);
    const sql = exec.mock.calls.flat().join('\n');

    expect(CURRENT_DB_VERSION).toBe(27);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS dsh_turns');
    expect(sql).toContain('UNIQUE(turn_id, sequence)');
  });

  it('backs up the database and WAL siblings once with hashes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aionui-v27-'));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, 'aionui.db');
    writeFileSync(dbPath, 'database');
    writeFileSync(`${dbPath}-wal`, 'wal');
    writeFileSync(`${dbPath}-shm`, 'shm');

    const first = backupDatabaseBeforeV27(dbPath);
    const second = backupDatabaseBeforeV27(dbPath);

    expect(first.files).toHaveLength(3);
    expect(second.reused).toBe(true);
    expect(readFileSync(join(first.directory, 'aionui.db'), 'utf8')).toBe('database');
  });

  it('refuses to create an empty backup for a missing database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aionui-v27-missing-'));
    temporaryDirectories.push(directory);

    expect(() => backupDatabaseBeforeV27(join(directory, 'aionui.db'))).toThrow('missing database');
  });
});
