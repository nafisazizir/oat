import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SCHEMA_VERSION } from './migrations.ts';
import { isCorruption, isTransient, LocalStoreUnavailableError, openDatabase } from './open.ts';
import { LocalStore } from './store.ts';

let dir: string;
let file: string;
const log = { warn: () => {}, error: () => {} };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oat-local-store-'));
  file = join(dir, 'oat.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const version = (db: DatabaseSync) =>
  (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

function seedWorkspace(path: string) {
  const store = new LocalStore({ path, log });
  store.transaction(() => {
    store.setState('marker', 'kept');
  });
  store.close();
}

describe('openDatabase', () => {
  it('creates and migrates a new file in WAL mode with foreign keys on', () => {
    const { db, wiped, fromVersion } = openDatabase(file, log);
    expect(wiped).toBeNull();
    expect(fromVersion).toBe(0);
    expect(version(db)).toBe(SCHEMA_VERSION);
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    db.close();
  });

  it('reopens an up-to-date file as is', () => {
    seedWorkspace(file);
    const store = new LocalStore({ path: file, log });
    expect(store.wiped).toBeNull();
    expect(store.getState('marker')).toBe('kept');
    store.close();
  });

  it('wipes a file written by a newer app (schema too new)', () => {
    seedWorkspace(file);
    const raw = new DatabaseSync(file);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
    raw.close();
    const store = new LocalStore({ path: file, log });
    expect(store.wiped).toBe('too_new');
    expect(store.getState('marker')).toBeNull();
    store.close();
  });

  it('wipes a corrupt file', () => {
    writeFileSync(file, Buffer.alloc(8192, 0x5a));
    const store = new LocalStore({ path: file, log });
    expect(store.wiped).toBe('corrupt');
    expect(store.outboxSize()).toBe(0);
    store.close();
  });

  it('wipes and rebuilds when a migration fails', () => {
    // A file at version 0 whose contents clash with migration 1.
    const raw = new DatabaseSync(file);
    raw.exec('CREATE TABLE outbox (x INTEGER)');
    raw.close();
    const errors: string[] = [];
    const store = new LocalStore({
      path: file,
      log: { warn: () => {}, error: (m) => errors.push(m) },
    });
    expect(store.wiped).toBe('migration_failed');
    expect(errors.join()).toMatch(/migration_failed/);
    expect(store.outboxSize()).toBe(0);
    store.close();
  });

  it('a busy/locked file is never wiped: it throws LocalStoreUnavailableError and keeps the data', () => {
    seedWorkspace(file);
    // Another process holds an exclusive lock on a rollback-journal database.
    const other = new DatabaseSync(file);
    other.exec('PRAGMA journal_mode = DELETE');
    other.exec('BEGIN EXCLUSIVE');
    other.exec("INSERT INTO sync_state (key, value) VALUES ('other', 'x')");
    let error: unknown;
    try {
      new LocalStore({ path: file, log, busyTimeoutMs: 50 }).close();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(LocalStoreUnavailableError);
    expect((error as LocalStoreUnavailableError).sqliteCode).toBe(5); // SQLITE_BUSY
    other.exec('ROLLBACK');
    other.close();
    const store = new LocalStore({ path: file, log });
    expect(store.wiped).toBeNull();
    expect(store.getState('marker')).toBe('kept');
    store.close();
  });

  it('a file that can’t be opened (no such folder) is an error, not a wipe', () => {
    expect(() => new LocalStore({ path: join(dir, 'missing', 'oat.db'), log })).toThrow(
      LocalStoreUnavailableError,
    );
  });

  it('classifies SQLite errors: only corruption wipes; busy/full/io/cantopen never do', () => {
    const err = (errcode: number) => Object.assign(new Error('x'), { errcode });
    expect(isCorruption(err(11))).toBe(true);
    expect(isCorruption(err(26))).toBe(true);
    expect(isCorruption(err(11 | (1 << 8)))).toBe(true); // extended code
    for (const code of [5, 6, 10, 13, 14, 10 | (12 << 8)]) {
      expect(isCorruption(err(code)), String(code)).toBe(false);
      expect(isTransient(err(code)), String(code)).toBe(true);
    }
    expect(isTransient(err(1))).toBe(false); // SQLITE_ERROR, e.g. a schema clash
    expect(isTransient(new Error('not sqlite'))).toBe(true);
  });
});
