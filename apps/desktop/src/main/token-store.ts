/**
 * Persists the desktop session (bearer token + the user it belongs to) encrypted with Electron's
 * `safeStorage` (macOS: a key in the login Keychain), in a file in userData. Main process only; the
 * renderer never sees the token.
 *
 * If OS encryption isn't available the session is **not** written (never plaintext); it then lasts only
 * until the app quits.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { desktopUserSchema } from '@oat/core/bridge';
import { z } from 'zod';

import type { Logger } from './ipc.ts';

/** The parts of Electron's `safeStorage` we use. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  /** Linux only in Electron: `basic_text` means a hard-coded key, i.e. no real protection. */
  getSelectedStorageBackend?(): string;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

const storedSessionSchema = z.object({
  v: z.literal(1),
  token: z.string().min(1),
  user: desktopUserSchema,
});
export type StoredSession = Omit<z.infer<typeof storedSessionSchema>, 'v'>;

export class TokenStore {
  readonly file: string;
  readonly #safeStorage: SafeStorageLike;
  readonly #log: Logger;

  readonly #platform: NodeJS.Platform;

  constructor({
    file,
    safeStorage,
    log,
    platform = process.platform,
  }: {
    file: string;
    safeStorage: SafeStorageLike;
    log: Logger;
    platform?: NodeJS.Platform;
  }) {
    this.file = file;
    this.#safeStorage = safeStorage;
    this.#log = log;
    this.#platform = platform;
  }

  /** OS-backed encryption only: on Linux the `basic_text` fallback (hard-coded key) doesn't count. */
  #encryptionAvailable(): boolean {
    if (!this.#safeStorage.isEncryptionAvailable()) return false;
    if (this.#platform !== 'linux') return true;
    return this.#safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
  }

  /** Writes atomically (temp file + rename, mode 0600). Returns `false` when encryption is unavailable. */
  async save(session: StoredSession): Promise<boolean> {
    if (!this.#encryptionAvailable()) {
      this.#log.warn('auth: OS encryption unavailable; the session is kept in memory only');
      return false;
    }
    const encrypted = this.#safeStorage.encryptString(JSON.stringify({ v: 1, ...session }));
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temp, encrypted, { mode: 0o600 });
    await rename(temp, this.file);
    return true;
  }

  /** The stored session, or `null` (none, unreadable or undecryptable; a bad file is removed). */
  async load(): Promise<StoredSession | null> {
    let encrypted: Buffer;
    try {
      encrypted = await readFile(this.file);
    } catch {
      return null;
    }
    try {
      if (!this.#encryptionAvailable()) return null;
      const parsed = storedSessionSchema.parse(
        JSON.parse(this.#safeStorage.decryptString(encrypted)),
      );
      return { token: parsed.token, user: parsed.user };
    } catch (error) {
      this.#log.error('auth: stored session unreadable; removing it', error);
      await this.clear();
      return null;
    }
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true });
  }
}
