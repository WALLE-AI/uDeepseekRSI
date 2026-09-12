/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import { mayInjectManagedCredential } from './actionPolicy';

export type ManagedBrowserCredentialSummary = { id: string; origin: string; clientId: string };
type StoredCredential = ManagedBrowserCredentialSummary & { encryptedSecret: string };

export class ManagedBrowserCredentialStore {
  readonly #filePath: string;
  #cache: StoredCredential[] | null = null;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  async list(): Promise<ManagedBrowserCredentialSummary[]> {
    return (await this.#read()).map(({ id, origin, clientId }) => ({ id, origin, clientId }));
  }

  async save(input: { id?: string; origin: string; clientId: string; clientSecret: string }): Promise<string> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable.');
    const parsed = new URL(input.origin.trim());
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('A managed Browser credential requires an exact HTTPS origin.');
    }
    if (!input.clientId.trim() || !input.clientSecret) throw new Error('Client ID and secret are required.');
    const id = input.id ?? randomUUID();
    const credentials = (await this.#read()).filter(
      (credential) => credential.id !== id && credential.origin !== parsed.origin
    );
    credentials.push({
      id,
      origin: parsed.origin,
      clientId: input.clientId.trim(),
      encryptedSecret: safeStorage.encryptString(input.clientSecret).toString('base64'),
    });
    await this.#write(credentials);
    return id;
  }

  async remove(id: string): Promise<void> {
    await this.#write((await this.#read()).filter((credential) => credential.id !== id));
  }

  async headersFor(requestUrl: string): Promise<Record<string, string> | null> {
    const credential = (await this.#read()).find((candidate) =>
      mayInjectManagedCredential(requestUrl, candidate.origin)
    );
    if (!credential) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    return {
      'CF-Access-Client-Id': credential.clientId,
      'CF-Access-Client-Secret': safeStorage.decryptString(Buffer.from(credential.encryptedSecret, 'base64')),
    };
  }

  async #read(): Promise<StoredCredential[]> {
    if (this.#cache) return this.#cache;
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.#filePath, 'utf8'));
      if (!Array.isArray(parsed)) {
        this.#cache = [];
        return this.#cache;
      }
      this.#cache = parsed.filter(
        (value): value is StoredCredential =>
          typeof value === 'object' &&
          value !== null &&
          typeof (value as StoredCredential).id === 'string' &&
          typeof (value as StoredCredential).origin === 'string' &&
          typeof (value as StoredCredential).clientId === 'string' &&
          typeof (value as StoredCredential).encryptedSecret === 'string'
      );
      return this.#cache;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#cache = [];
        return this.#cache;
      }
      throw error;
    }
  }

  async #write(credentials: StoredCredential[]): Promise<void> {
    await fs.mkdir(path.dirname(this.#filePath), { recursive: true });
    const temporary = `${this.#filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, this.#filePath);
    this.#cache = credentials;
  }
}

let store: ManagedBrowserCredentialStore | null = null;

export const getManagedBrowserCredentialStore = (): ManagedBrowserCredentialStore => {
  store ??= new ManagedBrowserCredentialStore(path.join(app.getPath('userData'), 'browser-access-credentials.json'));
  return store;
};
