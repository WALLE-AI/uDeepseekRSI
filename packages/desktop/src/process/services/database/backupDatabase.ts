import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  fsyncSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

export type DatabaseBackup = {
  directory: string;
  files: Array<{ name: string; sha256: string }>;
  reused: boolean;
};

function durableCopy(source: string, destination: string): void {
  copyFileSync(source, destination);
  const descriptor = openSync(destination, 'r+');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Copy the closed legacy database and its WAL siblings before the v27 writer opens.
 * A manifest makes the operation one-shot and gives recovery an integrity check.
 */
export function backupDatabaseBeforeV27(dbPath: string): DatabaseBackup {
  const directory = join(dirname(dbPath), 'migration-backups', 'pre-v27');
  const manifestPath = join(directory, 'manifest.json');
  if (existsSync(manifestPath)) {
    const existing = JSON.parse(readFileSync(manifestPath, 'utf8')) as Omit<DatabaseBackup, 'reused'>;
    return { ...existing, reused: true };
  }

  mkdirSync(directory, { recursive: true });
  const files: DatabaseBackup['files'] = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${dbPath}${suffix}`;
    if (!existsSync(source)) continue;
    const name = `${basename(dbPath)}${suffix}`;
    const destination = join(directory, name);
    durableCopy(source, destination);
    files.push({ name, sha256: sha256(destination) });
  }
  if (files.length === 0) throw new Error(`Cannot back up missing database: ${dbPath}`);

  const manifest = { directory, files };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  const descriptor = openSync(manifestPath, 'r+');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return { ...manifest, reused: false };
}
