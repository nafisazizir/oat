import { createTestDatabase, type TestDatabase } from '@oat/testkit';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db, migrate } from './client.ts';
import { newId } from './id.ts';
import * as s from './schema/index.ts';
import { type BuiltinTemplateRow, upsertBuiltinTemplates } from './templates.ts';

let testDb: TestDatabase;
let db: Db;

beforeAll(async () => {
  testDb = await createTestDatabase();
  await migrate(testDb.url);
  db = createDb(testDb.url, { max: 4 });
});

afterAll(async () => {
  await db?.$client.end();
  await testDb?.drop();
});

const builtins: BuiltinTemplateRow[] = [
  {
    id: '01900000-0000-7000-8b17-0000000000a1',
    name: 'Alpha',
    instructions: 'First.',
    sections: [{ heading: 'One', instructions: 'Do one.' }],
  },
  {
    id: '01900000-0000-7000-8b17-0000000000a2',
    name: 'Beta',
    instructions: '',
    sections: [
      { heading: 'Two', instructions: '' },
      { heading: 'Three', instructions: 'Do three.' },
    ],
  },
];

const rows = () =>
  db.select().from(s.template).where(eq(s.template.isBuiltin, true)).orderBy(asc(s.template.id));

describe('upsertBuiltinTemplates', () => {
  it('inserts built-ins as workspace-less is_builtin rows', async () => {
    const result = await upsertBuiltinTemplates(db, builtins);
    expect(result).toEqual({ written: builtins.map((b) => b.id), stale: [] });
    expect(
      (await rows()).map((r) => ({
        id: r.id,
        workspaceId: r.workspaceId,
        isBuiltin: r.isBuiltin,
        name: r.name,
        instructions: r.instructions,
        sections: r.sectionsJson,
      })),
    ).toEqual(
      builtins.map((b) => ({
        id: b.id,
        workspaceId: null,
        isBuiltin: true,
        name: b.name,
        instructions: b.instructions,
        sections: b.sections,
      })),
    );
  });

  it('is a no-op when nothing changed (no write, no updated_at bump)', async () => {
    const before = await rows();
    const result = await upsertBuiltinTemplates(db, builtins);
    expect(result.written).toEqual([]);
    expect((await rows()).map((r) => r.updatedAt.getTime())).toEqual(
      before.map((r) => r.updatedAt.getTime()),
    );
  });

  it('updates only the built-ins whose content changed', async () => {
    const before = await rows();
    const changed = [
      builtins[0]!,
      {
        ...builtins[1]!,
        sections: [builtins[1]!.sections[1]!, builtins[1]!.sections[0]!],
      },
    ];
    const result = await upsertBuiltinTemplates(db, changed);
    expect(result.written).toEqual([builtins[1]!.id]);
    const after = await rows();
    expect(after[0]!.updatedAt.getTime()).toBe(before[0]!.updatedAt.getTime());
    expect(after[1]!.sectionsJson.map((x) => x.heading)).toEqual(['Three', 'Two']);
    expect(after[1]!.createdAt.getTime()).toBe(before[1]!.createdAt.getTime());
  });

  it('runs concurrently without errors or duplicates', async () => {
    const next = builtins.map((b) => ({ ...b, name: `${b.name}!` }));
    await Promise.all([
      upsertBuiltinTemplates(db, next),
      upsertBuiltinTemplates(db, next),
      upsertBuiltinTemplates(db, next),
    ]);
    expect((await rows()).map((r) => r.name)).toEqual(['Alpha!', 'Beta!']);
  });

  it('reports built-ins that are no longer defined without deleting them', async () => {
    const result = await upsertBuiltinTemplates(db, [builtins[0]!]);
    expect(result.stale).toEqual([builtins[1]!.id]);
    expect(await rows()).toHaveLength(2);
  });

  it('never overwrites a workspace template that shares an id', async () => {
    const [user] = await db
      .insert(s.user)
      .values({ id: newId(), email: `t-${Date.now()}@example.test`, name: 'T' })
      .returning();
    const [ws] = await db
      .insert(s.workspace)
      .values({ name: 'W', slug: `w-${Date.now()}`, kind: 'team', createdBy: user!.id })
      .returning();
    const id = newId();
    await db.insert(s.template).values({ id, workspaceId: ws!.id, name: 'Mine', isBuiltin: false });
    await upsertBuiltinTemplates(db, [{ id, name: 'Hijack', instructions: '', sections: [] }]);
    const [row] = await db.select().from(s.template).where(eq(s.template.id, id));
    expect(row).toMatchObject({ name: 'Mine', workspaceId: ws!.id, isBuiltin: false });
  });

  it('does nothing for an empty list', async () => {
    expect(await upsertBuiltinTemplates(db, [])).toEqual({ written: [], stale: [] });
  });
});
