/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^encrypted:/, ''),
  },
}));

import { ManagedBrowserCredentialStore } from '@process/services/browser-control/managedCredentialStore';

const temporaryDirectories: string[] = [];

const createStore = async (): Promise<{ filePath: string; store: ManagedBrowserCredentialStore }> => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aionui-browser-credential-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, 'credentials.json');
  return { filePath, store: new ManagedBrowserCredentialStore(filePath) };
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })));
});

describe('ManagedBrowserCredentialStore', () => {
  it('encrypts secrets at rest and returns headers only for the exact HTTPS origin', async () => {
    const { filePath, store } = await createStore();
    await store.save({
      origin: 'HTTPS://APP.EXAMPLE.COM/',
      clientId: 'client-id',
      clientSecret: 'plain-secret',
    });

    expect(await store.list()).toEqual([
      expect.objectContaining({ origin: 'https://app.example.com', clientId: 'client-id' }),
    ]);
    expect(await fs.readFile(filePath, 'utf8')).not.toContain('plain-secret');
    expect(await store.headersFor('https://app.example.com/path')).toEqual({
      'CF-Access-Client-Id': 'client-id',
      'CF-Access-Client-Secret': 'plain-secret',
    });
    expect(await store.headersFor('https://sub.app.example.com/path')).toBeNull();
    expect(await store.headersFor('http://app.example.com/path')).toBeNull();
  });

  it('replaces a credential for the same origin and removes it without returning the secret', async () => {
    const { store } = await createStore();
    await store.save({ origin: 'https://app.example.com', clientId: 'old', clientSecret: 'old-secret' });
    const id = await store.save({ origin: 'https://app.example.com', clientId: 'new', clientSecret: 'new-secret' });

    expect(await store.list()).toEqual([{ id, origin: 'https://app.example.com', clientId: 'new' }]);
    await store.remove(id);
    expect(await store.list()).toEqual([]);
  });

  it('rejects non-origin URLs and incomplete credentials', async () => {
    const { store } = await createStore();
    await expect(
      store.save({ origin: 'https://app.example.com/path', clientId: 'id', clientSecret: 'secret' })
    ).rejects.toThrow('exact HTTPS origin');
    await expect(
      store.save({ origin: 'http://app.example.com', clientId: 'id', clientSecret: 'secret' })
    ).rejects.toThrow('exact HTTPS origin');
    await expect(
      store.save({ origin: 'https://app.example.com', clientId: '', clientSecret: 'secret' })
    ).rejects.toThrow('required');
  });
});
