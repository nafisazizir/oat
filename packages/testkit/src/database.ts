import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { adminDatabaseUrl } from './env.ts';

export interface TestDatabase {
  /** Database name, `oat_test_<base36 ms timestamp>_<random>`. */
  name: string;
  /** Connection string for the new database (same server/credentials as the admin URL). */
  url: string;
  /** Drops the database, terminating open connections. Safe to call more than once. */
  drop(): Promise<void>;
}

export interface CreateTestDatabaseOptions {
  /** Superuser URL. Default: `adminDatabaseUrl()` (env `OAT_DATABASE_ADMIN_URL` / `DATABASE_URL`). */
  adminUrl?: string;
}

export const TEST_DATABASE_PREFIX = 'oat_test_';
const TEST_DATABASE_NAME = /^oat_test_([0-9a-z]+)_[0-9a-f]+$/;
/** Test databases older than this are considered leaked (crashed run) and swept. */
export const STALE_TEST_DATABASE_MS = 60 * 60 * 1000;
/** Set to `1` to allow creating/dropping test databases on a non-loopback Postgres host. */
export const ALLOW_REMOTE_DB_ENV = 'OAT_TESTKIT_ALLOW_REMOTE_DB';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** `oat_test_<base36 creation ms>_<8 hex>`; lowercase, safe to interpolate as an identifier. */
export function testDatabaseName(now: number = Date.now()): string {
  return `${TEST_DATABASE_PREFIX}${now.toString(36)}_${randomBytes(4).toString('hex')}`;
}

/** Creation time encoded in a test database name, or `undefined` if it isn't one. */
export function testDatabaseCreatedAt(name: string): number | undefined {
  const match = TEST_DATABASE_NAME.exec(name);
  if (!match?.[1]) return undefined;
  const ms = parseInt(match[1], 36);
  return Number.isSafeInteger(ms) ? ms : undefined;
}

/**
 * Throws unless `url` points at a loopback host, so a stray `DATABASE_URL=<Neon>` in a shell can never make
 * tests create or drop databases on a real server. Override with `OAT_TESTKIT_ALLOW_REMOTE_DB=1`.
 */
export function assertLocalDatabase(
  url: string,
  env: Record<string, string | undefined> = process.env,
): void {
  const host = new URL(url).hostname;
  if (LOOPBACK.has(host) || env[ALLOW_REMOTE_DB_ENV] === '1') return;
  throw new Error(
    `@oat/testkit: refusing to manage test databases on non-local host "${host}". ` +
      `Point OAT_DATABASE_ADMIN_URL/DATABASE_URL at the compose Postgres, or set ${ALLOW_REMOTE_DB_ENV}=1.`,
  );
}

async function withAdmin<T>(adminUrl: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  assertLocalDatabase(adminUrl);
  const client = new pg.Client({ connectionString: adminUrl });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(
      `@oat/testkit: cannot reach Postgres at ${redact(adminUrl)}. Is the dev stack up? (pnpm dev:up)`,
      { cause: err },
    );
  }
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function redact(url: string): string {
  const u = new URL(url);
  if (u.password) u.password = '***';
  return u.toString();
}

const dropSql = (name: string) => {
  if (testDatabaseCreatedAt(name) === undefined) throw new Error(`refusing to drop ${name}`);
  return `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`;
};

/**
 * Drops `oat_test_*` databases created more than `olderThanMs` ago (leaked by crashed or killed runs).
 * Returns the dropped names. `createTestDatabase()` calls this opportunistically once per process.
 */
export async function sweepStaleTestDatabases(
  options: { adminUrl?: string; olderThanMs?: number; now?: number } = {},
): Promise<string[]> {
  const { olderThanMs = STALE_TEST_DATABASE_MS, now = Date.now() } = options;
  const adminUrl = options.adminUrl ?? adminDatabaseUrl();
  return withAdmin(adminUrl, async (c) => {
    const { rows } = await c.query<{ datname: string }>(
      `select datname from pg_database where datname like 'oat\\_test\\_%'`,
    );
    const stale = rows
      .map((r) => r.datname)
      .filter((name) => {
        const createdAt = testDatabaseCreatedAt(name);
        return createdAt !== undefined && now - createdAt > olderThanMs;
      });
    const dropped: string[] = [];
    for (const name of stale) {
      try {
        await c.query(dropSql(name));
        dropped.push(name);
      } catch {
        // Another process may be sweeping the same database; ignore.
      }
    }
    return dropped;
  });
}

let swept: Promise<unknown> | undefined;

/**
 * Creates a throwaway database on the compose Postgres so parallel test runs (and worktrees) never share
 * state. It inherits `vector` + `pg_trgm` from template1 (docker/postgres/init). Always `drop()` it, e.g.
 * in `afterAll`; leaked ones are swept after an hour (see `sweepStaleTestDatabases`).
 * Refuses non-loopback hosts unless `OAT_TESTKIT_ALLOW_REMOTE_DB=1`.
 */
export async function createTestDatabase(
  options: CreateTestDatabaseOptions = {},
): Promise<TestDatabase> {
  const adminUrl = options.adminUrl ?? adminDatabaseUrl();
  assertLocalDatabase(adminUrl);
  // Best effort, once per process; never fails the caller.
  swept ??= sweepStaleTestDatabases({ adminUrl }).catch(() => undefined);
  await swept;

  const name = testDatabaseName();
  await withAdmin(adminUrl, (c) => c.query(`CREATE DATABASE "${name}"`));

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;

  let dropped = false;
  return {
    name,
    url: url.toString(),
    async drop() {
      if (dropped) return;
      await withAdmin(adminUrl, (c) => c.query(dropSql(name)));
      dropped = true;
    },
  };
}
