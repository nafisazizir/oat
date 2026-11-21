/**
 * Migration 0013 (D-36, task unified-workspaces step A) on a database that already holds data at the previous
 * schema: former personal workspaces stay in place under the same id (so no document moves), are renamed and
 * get a generated slug; team workspaces are untouched; `kind`, its enum and its constraints are gone.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase, type TestDatabase } from '@oat/testkit';
import { migrate as drizzleMigrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db, migrate, MIGRATIONS_FOLDER } from './client.ts';

const MIGRATION = '0013_unified_workspaces';

/** A copy of the migrations folder that stops just before `tag` (what `main` had). */
function migrationsBefore(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'oat-migrations-'));
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  const at = journal.entries.findIndex((e) => e.tag === tag);
  if (at < 0) throw new Error(`migration ${tag} is not in the journal`);
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

let testDb: TestDatabase;
let db: Db;
let before: string;

const u = (n: number) => `user-${n}`;
const ws = (n: number) => `ws-${n}`;

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = createDb(testDb.url, { max: 2 });
  before = migrationsBefore(MIGRATION);
  await drizzleMigrate(db, { migrationsFolder: before });

  const sql = db.$client;
  await sql`insert into "user" (id, name, email, email_verified) values
    (${u(1)}, 'Ada Lovelace', 'ada@example.test', true),
    (${u(2)}, '', 'noname@example.test', true),
    (${u(3)}, null, 'null@example.test', true),
    (${u(4)}, '  Émile   Zola ', 'emile@example.test', true),
    (${u(5)}, 'Grace Hopper', 'grace@example.test', true)`;
  await sql`insert into workspace (id, name, slug, kind, created_by) values
    (${ws(1)}, 'Personal', ${`personal-${u(1)}`}, 'personal', ${u(1)}),
    (${ws(2)}, 'Personal', ${`personal-${u(2)}`}, 'personal', ${u(2)}),
    (${ws(3)}, 'Personal', ${`personal-${u(3)}`}, 'personal', ${u(3)}),
    (${ws(4)}, 'Personal', ${`personal-${u(4)}`}, 'personal', ${u(4)}),
    (${ws(5)}, 'Grace’s desk', ${`personal-${u(5)}`}, 'personal', ${u(5)}),
    (${ws(6)}, 'Acme', 'acme', 'team', ${u(1)})`;
  await sql`insert into membership (id, workspace_id, user_id, role) values
    ('m1', ${ws(1)}, ${u(1)}, 'owner'), ('m2', ${ws(2)}, ${u(2)}, 'owner'),
    ('m3', ${ws(3)}, ${u(3)}, 'owner'), ('m4', ${ws(4)}, ${u(4)}, 'owner'),
    ('m5', ${ws(5)}, ${u(5)}, 'owner'), ('m6', ${ws(6)}, ${u(1)}, 'owner'),
    ('m7', ${ws(6)}, ${u(5)}, 'member')`;
  await sql`insert into document (id, workspace_id, owner_id, kind, title) values
    ('doc-1', ${ws(1)}, ${u(1)}, 'page', 'Diary'),
    ('doc-2', ${ws(1)}, ${u(1)}, 'meeting', 'Standup'),
    ('doc-3', ${ws(6)}, ${u(5)}, 'page', 'Team page')`;
  await sql`delete from change_log`;

  await migrate(testDb.url);
});

afterAll(async () => {
  await db?.$client.end();
  await testDb?.drop();
  if (before) rmSync(before, { recursive: true, force: true });
});

describe(`migration ${MIGRATION}`, () => {
  it('keeps every workspace under its id and every document in its workspace', async () => {
    const rows = await db.$client<{ id: string; workspace_id: string }[]>`
      select id, workspace_id from document order by id`;
    expect(rows.map((r) => [r.id, r.workspace_id])).toEqual([
      ['doc-1', ws(1)],
      ['doc-2', ws(1)],
      ['doc-3', ws(6)],
    ]);
    const members = await db.$client<{ n: number }[]>`select count(*)::int as n from membership`;
    expect(members[0]?.n).toBe(7);
  });

  it('renames "Personal" to "<First name>’s workspace" (fallback "My workspace"), keeps other names', async () => {
    const rows = await db.$client<{ id: string; name: string }[]>`
      select id, name from workspace order by id`;
    expect(Object.fromEntries(rows.map((r) => [r.id, r.name]))).toEqual({
      [ws(1)]: 'Ada’s workspace',
      [ws(2)]: 'My workspace',
      [ws(3)]: 'My workspace',
      [ws(4)]: 'Émile’s workspace',
      [ws(5)]: 'Grace’s desk', // its owner had renamed it: kept
      [ws(6)]: 'Acme',
    });
  });

  it('replaces `personal-<userId>` slugs with generated ones; other slugs are untouched', async () => {
    const rows = await db.$client<{ id: string; slug: string }[]>`
      select id, slug from workspace order by id`;
    const slug = Object.fromEntries(rows.map((r) => [r.id, r.slug]));
    expect(slug[ws(1)]).toMatch(/^ada-s-workspace-[0-9a-f]{12}$/);
    expect(slug[ws(2)]).toMatch(/^my-workspace-[0-9a-f]{12}$/);
    expect(slug[ws(4)]).toMatch(/^mile-s-workspace-[0-9a-f]{12}$/);
    expect(slug[ws(5)]).toMatch(/^grace-s-desk-[0-9a-f]{12}$/);
    expect(slug[ws(6)]).toBe('acme');
    expect(rows.some((r) => r.slug.startsWith('personal-'))).toBe(false);
    expect(new Set(rows.map((r) => r.slug)).size).toBe(rows.length);
    // The app's own slug rule (`@oat/auth` server.ts) accepts them, so they can be edited later.
    for (const r of rows) expect(r.slug).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
  });

  it('tells syncing clients about the renamed workspaces (change log)', async () => {
    const rows = await db.$client<{ row_id: string }[]>`
      select distinct row_id from change_log where table_name = 'workspace' order by row_id`;
    expect(rows.map((r) => r.row_id)).toEqual([ws(1), ws(2), ws(3), ws(4), ws(5)]);
  });

  it('drops `kind`, its enum, the one-personal-per-user index and the team-only delete check', async () => {
    const sql = db.$client;
    const columns = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'workspace'`;
    expect(columns.map((c) => c.column_name)).not.toContain('kind');
    expect(await sql`select 1 from pg_type where typname = 'workspace_kind'`).toHaveLength(0);
    expect(
      await sql`select 1 from pg_indexes where indexname = 'workspace_personal_created_by_uq'`,
    ).toHaveLength(0);
    expect(
      await sql`select 1 from pg_constraint where conname = 'workspace_deleted_team_only_ck'`,
    ).toHaveLength(0);
    // What those rules forbade now works: a second workspace per creator, and soft-deleting a former
    // personal workspace.
    await sql`insert into workspace (id, name, slug, created_by) values ('ws-7', 'Second', 'second', ${u(2)})`;
    await sql`update workspace set deleted_at = now() where id = ${ws(2)}`;
  });
});
