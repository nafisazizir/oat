import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from './ipc.ts';
import { type SafeStorageLike, TokenStore } from './token-store.ts';

/** Reversible stand-in for safeStorage (XOR), so tests can tell ciphertext from plaintext. */
function fakeSafeStorage(available = true): SafeStorageLike {
  const xor = (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a));
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => xor(Buffer.from(s, 'utf8')),
    decryptString: (b) => xor(b).toString('utf8'),
  };
}

const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const SESSION = { token: 'tok.sig', user: { id: 'u', email: 'a@b.c', name: null } };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oat-token-store-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('TokenStore', () => {
  it('saves encrypted (0600) and loads it back', async () => {
    const store = new TokenStore({
      file: join(dir, 'session.bin'),
      safeStorage: fakeSafeStorage(),
      log,
    });
    expect(await store.save(SESSION)).toBe(true);
    const raw = await readFile(store.file);
    expect(raw.toString('utf8')).not.toContain('tok.sig');
    expect((await stat(store.file)).mode & 0o777).toBe(0o600);
    expect(await store.load()).toEqual(SESSION);
  });

  it('never writes plaintext when OS encryption is unavailable', async () => {
    const store = new TokenStore({
      file: join(dir, 'session.bin'),
      safeStorage: fakeSafeStorage(false),
      log,
    });
    expect(await store.save(SESSION)).toBe(false);
    await expect(stat(store.file)).rejects.toThrow();
    expect(await store.load()).toBeNull();
  });

  it('a corrupt file is removed and treated as signed out', async () => {
    const store = new TokenStore({
      file: join(dir, 'session.bin'),
      safeStorage: fakeSafeStorage(),
      log,
    });
    await writeFile(store.file, 'garbage');
    expect(await store.load()).toBeNull();
    await expect(stat(store.file)).rejects.toThrow();
  });

  it('clear removes the file (and is fine when there is none)', async () => {
    const store = new TokenStore({
      file: join(dir, 'session.bin'),
      safeStorage: fakeSafeStorage(),
      log,
    });
    await store.save(SESSION);
    await store.clear();
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it('on Linux, the basic_text backend counts as no encryption (memory only)', async () => {
    const linux = (backend: string) =>
      new TokenStore({
        file: join(dir, 'session.bin'),
        safeStorage: { ...fakeSafeStorage(), getSelectedStorageBackend: () => backend },
        log,
        platform: 'linux',
      });
    expect(await linux('basic_text').save(SESSION)).toBe(false);
    await expect(stat(join(dir, 'session.bin'))).rejects.toThrow();
    expect(await linux('gnome_libsecret').save(SESSION)).toBe(true);
  });
});
