import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  STALE_TEST_DATABASE_MS,
  sweepStaleTestDatabases,
  testDatabaseName,
  type TestDatabase,
} from './database.ts';
import { adminDatabaseUrl } from './env.ts';

async function query<T extends pg.QueryResultRow>(
  url: string,
  sql: string,
  params: unknown[] = [],
) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

const exists = async (name: string) =>
  (await query(adminDatabaseUrl(), 'select 1 from pg_database where datname = $1', [name]))
    .length === 1;

describe('createTestDatabase (compose Postgres)', () => {
  const created: TestDatabase[] = [];
  afterAll(async () => {
    await Promise.all(created.map((db) => db.drop()));
  });

  it('creates a usable oat_test_* database with vector + pg_trgm, and drops it', async () => {
    const db = await createTestDatabase();
    created.push(db);
    expect(db.name).toMatch(/^oat_test_/);
    expect(new URL(db.url).pathname).toBe(`/${db.name}`);
    expect(await exists(db.name)).toBe(true);

    const ext = await query<{ extname: string }>(db.url, 'select extname from pg_extension');
    expect(ext.map((r) => r.extname)).toEqual(expect.arrayContaining(['vector', 'pg_trgm']));

    // Extensions actually work.
    const [row] = await query<{ d: number; s: number }>(
      db.url,
      "select '[1,2,3]'::vector <-> '[1,2,4]'::vector as d, similarity('oat', 'oats') as s",
    );
    expect(row?.d).toBe(1);
    expect(row?.s).toBeGreaterThan(0);

    // drop() works even with a connection still open, and is idempotent.
    const open = new pg.Client({ connectionString: db.url });
    await open.connect();
    open.on('error', () => {}); // terminated by DROP ... WITH (FORCE)
    await db.drop();
    await db.drop();
    expect(await exists(db.name)).toBe(false);
  });

  it('gives each call its own database', async () => {
    const [a, b] = await Promise.all([createTestDatabase(), createTestDatabase()]);
    created.push(a, b);
    expect(a.name).not.toBe(b.name);
    await query(a.url, 'create table t (id int)');
    const inB = await query(
      b.url,
      "select 1 from information_schema.tables where table_name = 't'",
    );
    expect(inB).toHaveLength(0);
  });

  it('sweeps leaked test databases older than an hour, and only those', async () => {
    const leaked = testDatabaseName(Date.now() - STALE_TEST_DATABASE_MS - 60_000);
    const fresh = await createTestDatabase();
    created.push(fresh);
    await query(adminDatabaseUrl(), `create database "${leaked}"`);

    const dropped = await sweepStaleTestDatabases();
    expect(dropped).toContain(leaked);
    expect(dropped).not.toContain(fresh.name);
    expect(await exists(leaked)).toBe(false);
    expect(await exists(fresh.name)).toBe(true);
    expect(await exists('oat')).toBe(true);
  });
});
