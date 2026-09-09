import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { safeStorage } from 'electron';
import type { ProviderCredentialStore } from '@udeepseekrsi/dsh-bridge';

type StoredCredentials = Record<string, string>;

/** Stores provider secrets encrypted for the current OS user. */
export class SafeStorageProviderCredentialStore implements ProviderCredentialStore {
  readonly #filePath: string;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  async get(providerId: string): Promise<string | undefined> {
    const credentials = await this.#read();
    const encrypted = credentials[providerId];
    if (!encrypted) return undefined;
    this.#assertAvailable();
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  }

  async set(providerId: string, apiKey: string): Promise<void> {
    this.#assertAvailable();
    const encrypted = safeStorage.encryptString(apiKey).toString('base64');
    await this.#update((credentials) => ({ ...credentials, [providerId]: encrypted }));
  }

  async delete(providerId: string): Promise<void> {
    await this.#update((credentials) => {
      const next = { ...credentials };
      delete next[providerId];
      return next;
    });
  }

  async #read(): Promise<StoredCredentials> {
    try {
      const parsed = JSON.parse(await readFile(this.#filePath, 'utf8')) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as StoredCredentials) : {};
    } catch {
      return {};
    }
  }

  async #update(update: (credentials: StoredCredentials) => StoredCredentials): Promise<void> {
    const write = async (): Promise<void> => {
      const next = update(await this.#read());
      await mkdir(dirname(this.#filePath), { recursive: true });
      const temporary = `${this.#filePath}.tmp`;
      await writeFile(temporary, JSON.stringify(next, null, 2), 'utf8');
      await rename(temporary, this.#filePath);
    };
    const pending = this.#writeQueue.catch((): undefined => undefined).then(write);
    this.#writeQueue = pending;
    await pending;
  }

  #assertAvailable(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure credential storage is unavailable on this system.');
    }
  }
}
