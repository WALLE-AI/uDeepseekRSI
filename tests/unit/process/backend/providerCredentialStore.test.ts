import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeStorageProviderCredentialStore } from '../../../../packages/desktop/src/process/backend/providerCredentialStore';

const mocks = vi.hoisted(() => ({
  decryptString: vi.fn((value: Buffer) => Buffer.from(value.toString(), 'base64').toString('utf8')),
  encryptString: vi.fn((value: string) => Buffer.from(Buffer.from(value).toString('base64'))),
  isEncryptionAvailable: vi.fn(() => true),
}));

vi.mock('electron', () => ({ safeStorage: mocks }));

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  vi.clearAllMocks();
});

describe('SafeStorageProviderCredentialStore', () => {
  it('round-trips a provider key without writing the plaintext value', async () => {
    const root = await mkdtemp(join(tmpdir(), 'provider-credentials-'));
    cleanups.push(root);
    const filePath = join(root, 'credentials.json');
    const store = new SafeStorageProviderCredentialStore(filePath);

    await store.set('provider-1', 'secret-api-key');

    expect(await store.get('provider-1')).toBe('secret-api-key');
    expect(await readFile(filePath, 'utf8')).not.toContain('secret-api-key');
  });

  it('fails closed when operating-system encryption is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'provider-credentials-'));
    cleanups.push(root);
    mocks.isEncryptionAvailable.mockReturnValueOnce(false);
    const store = new SafeStorageProviderCredentialStore(join(root, 'credentials.json'));

    await expect(store.set('provider-1', 'secret-api-key')).rejects.toThrow('Secure credential storage is unavailable');
  });
});
