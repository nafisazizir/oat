/**
 * Opening the local database (D-19, D-28): WAL, foreign keys, migrations by `user_version`, and
 * wipe-and-rebuild **only** when the file can't be trusted:
 * - it is corrupt: SQLite says `SQLITE_CORRUPT` (11) / `SQLITE_NOTADB` (26), or `quick_check` isn't `ok`;
 * - it was written by a newer app (`user_version` above ours);
 * - a migration fails for a reason that isn't transient (a schema clash, a constraint).
 * Anything transient — busy/locked (another process), disk full, I/O, can't open, read-only, out of
 * memory — is thrown as a `LocalStoreUnavailableError` and the file is left alone: the caller reports it
 * and tries again later. A wipe only costs a full pull plus whatever had not been pushed (logged).
 *
 * Single writer: one connection in one process (the Electron main process, behind the app's
 * single-instance lock). node:sqlite calls are synchronous, so statements never interleave.
 */
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { MIGRATIONS } from './migrations.ts';

export type WipeReason = 'corrupt' | 'too_new' | 'migration_failed';

export interface OpenResult {
  db: DatabaseSync;
  /** Set when an existing file was thrown away. */
  wiped: WipeReason | null;
  /** Schema version the file had before migrating (0 = new). */
  fromVersion: number;
}

export interface OpenLogger {
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

/** The database can't be used right now (busy, disk full, I/O…); it was not touched. Try again later. */
export class LocalStoreUnavailableError extends Error {
  override name = 'LocalStoreUnavailableError';
  readonly sqliteCode: number | undefined;
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.sqliteCode = sqliteCode(cause);
  }
}

const IN_MEMORY = ':memory:';

/** Primary SQLite result code of a node:sqlite error (`errcode` may be an extended code). */
export function sqliteCode(error: unknown): number | undefined {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' ? code & 0xff : undefined;
}

const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;
/** PERM, BUSY, LOCKED, NOMEM, READONLY, IOERR, FULL, CANTOPEN, PROTOCOL, AUTH: never a reason to wipe. */
const TRANSIENT = new Set([3, 5, 6, 7, 8, 10, 13, 14, 15, 23]);

export const isCorruption = (error: unknown) => {
  const code = sqliteCode(error);
  return code === SQLITE_CORRUPT || code === SQLITE_NOTADB;
};

/** Errors that say nothing about the file's contents (and must never cause a wipe). */
export const isTransient = (error: unknown) => {
  const code = sqliteCode(error);
  return code === undefined || TRANSIENT.has(code);
};

class QuickCheckFailed extends Error {}

/** Deletes the database file and its WAL/SHM companions. */
export function deleteDatabaseFiles(path: string): void {
  if (path === IN_MEMORY) return;
  for (const suffix of ['', '-wal', '-shm', '-journal'])
    rmSync(`${path}${suffix}`, { force: true });
}

function connect(path: string, timeout: number): DatabaseSync {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout });
  try {
    if (path !== IN_MEMORY) {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
    }
    db.exec('PRAGMA foreign_keys = ON');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

const userVersion = (db: DatabaseSync) =>
  Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);

function migrate(db: DatabaseSync, from: number, migrations: readonly string[]): void {
  for (let v = from; v < migrations.length; v++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migrations[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }
}

const unavailable = (path: string, error: unknown) =>
  new LocalStoreUnavailableError(
    `Can't open the local database ${path}: ${error instanceof Error ? error.message : String(error)}`,
    error,
  );

/**
 * Opens (creating or rebuilding as needed) and migrates the database at `path` (`:memory:` for tests).
 * Throws `LocalStoreUnavailableError` (file untouched) on transient errors.
 */
export function openDatabase(
  path: string,
  log?: OpenLogger,
  migrations: readonly string[] = MIGRATIONS,
  { busyTimeoutMs = 5_000 }: { busyTimeoutMs?: number } = {},
): OpenResult {
  let wiped: WipeReason | null = null;
  const wipe = (reason: WipeReason, db?: DatabaseSync, error?: unknown) => {
    log?.error(`local-store: wiping ${path} (${reason})`, error);
    try {
      db?.close();
    } catch {
      /* already unusable */
    }
    deleteDatabaseFiles(path);
    wiped = reason;
  };
  const fresh = (): DatabaseSync => {
    try {
      return connect(path, busyTimeoutMs);
    } catch (error) {
      throw unavailable(path, error);
    }
  };

  let db: DatabaseSync | undefined;
  let from: number;
  try {
    db = connect(path, busyTimeoutMs);
    const check = db.prepare('PRAGMA quick_check').get() as { quick_check: string } | undefined;
    if (check?.quick_check !== 'ok')
      throw new QuickCheckFailed(`quick_check: ${check?.quick_check}`);
    from = userVersion(db);
  } catch (error) {
    if (!isCorruption(error) && !(error instanceof QuickCheckFailed)) {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
      throw unavailable(path, error);
    }
    wipe('corrupt', db, error);
    db = fresh();
    from = 0;
  }
  if (from > migrations.length) {
    wipe('too_new', db);
    db = fresh();
    from = 0;
  }
  try {
    migrate(db, from, migrations);
  } catch (error) {
    if (path === IN_MEMORY) {
      db.close();
      throw error;
    }
    if (isTransient(error)) {
      db.close();
      throw unavailable(path, error);
    }
    // Retried once on an empty file; failing again is a bug in the migrations, not a bad file.
    wipe('migration_failed', db, error);
    db = fresh();
    try {
      migrate(db, 0, migrations);
    } catch (again) {
      db.close();
      throw again;
    }
  }
  return { db, wiped, fromVersion: from };
}
