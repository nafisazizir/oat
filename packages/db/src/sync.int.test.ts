/** D-22: trigger-written change log and the out-of-order-safe reader. */
import { createTestDatabase, type TestDatabase, waitFor } from '@oat/testkit';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db, migrate } from './client.ts';
import { newId } from './id.ts';
import * as s from './schema/index.ts';
import { type Change, readChanges } from './sync.ts';

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

/** All visible changes for `ws` after `cursor`, following pages. */
async function drain(ws: string[], cursor: string | null = null, limit = 1000) {
  const changes: Change[] = [];
  for (;;) {
    const page = await readChanges(db, ws, cursor, { limit });
    changes.push(...page.changes);
    cursor = page.cursor;
    if (!page.hasMore) return { changes, cursor };
  }
}

/**
 * Visibility waits for every older transaction in the whole cluster (other test runs share the server), so
 * "eventually" assertions poll briefly instead of expecting rows instantly.
 */
async function eventually(ws: string[], cursor: string | null, atLeast: number) {
  return waitFor(
    async () => {
      const r = await drain(ws, cursor);
      return r.changes.length >= atLeast ? r : undefined;
    },
    { timeout: 10_000, interval: 50 },
  );
}

async function makeWorkspace() {
  const userId = newId();
  const ws = newId();
  await db.insert(s.user).values({ id: userId, email: `${userId}@example.test` });
  await db.insert(s.workspace).values({ id: ws, name: 'W', slug: `w-${ws}`, createdBy: userId });
  return { userId, ws };
}

describe('change_log triggers', () => {
  it('log every synced table with its workspace, and nothing else', async () => {
    const { userId, ws } = await makeWorkspace();
    const doc = newId();
    const meetingId = newId();
    const thread = newId();
    await db.insert(s.membership).values({ workspaceId: ws, userId, role: 'owner' });
    await db.insert(s.invite).values({
      workspaceId: ws,
      email: 'x@example.test',
      inviterId: userId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await db
      .insert(s.folder)
      .values({ workspaceId: ws, name: 'F', visibility: 'workspace', ownerId: userId });
    await db
      .insert(s.document)
      .values({ id: doc, workspaceId: ws, ownerId: userId, kind: 'meeting' });
    await db.insert(s.meeting).values({ id: meetingId, documentId: doc });
    await db.insert(s.participant).values({ meetingId, name: 'P', source: 'manual' });
    await db.insert(s.transcriptSegment).values({
      id: `seg-${meetingId}`,
      meetingId,
      source: 'mic',
      startMs: 0,
      endMs: 1,
      text: 'hi',
    });
    await db.insert(s.enhancement).values({
      documentId: doc,
      model: 'm',
      inputHash: 'h',
      inputNotesJson: {},
      idempotencyKey: newId(),
    });
    await db.insert(s.template).values({ workspaceId: ws, name: 'T' });
    await db.insert(s.template).values({ workspaceId: null, name: 'Built-in', isBuiltin: true });
    await db
      .insert(s.chatThread)
      .values({ id: thread, workspaceId: ws, userId, scope: 'workspace' });
    await db.insert(s.chatMessage).values({ threadId: thread, role: 'user', partsJson: [] });
    // Not synced: no log rows.
    await db.insert(s.integration).values({ workspaceId: ws, userId, provider: 'notion' });
    await db.insert(s.chunk).values({
      workspaceId: ws,
      documentId: doc,
      text: 'c',
      embedding: new Array<number>(s.EMBEDDING_DIMENSIONS).fill(0.1),
    });

    const { changes } = await eventually([ws], null, s.SYNCED_TABLES.length);
    expect(new Set(changes.map((c) => c.tableName))).toEqual(new Set(s.SYNCED_TABLES));
    expect(changes).toHaveLength(s.SYNCED_TABLES.length);
    expect(changes.every((c) => c.workspaceId === ws && c.op === 'upsert')).toBe(true);
    expect(changes.find((c) => c.tableName === 'transcript_segment')?.rowId).toBe(
      `seg-${meetingId}`,
    );
    // Ordered by (txid, seq): one autocommit statement per insert, so txids increase.
    const keys = changes.map((c) => [BigInt(c.txid), c.seq] as const);
    for (let i = 1; i < keys.length; i++) {
      const [pt, ps] = keys[i - 1]!;
      const [t, q] = keys[i]!;
      expect(t > pt || (t === pt && q > ps)).toBe(true);
    }
  });

  it('logs updates, deletes, cascades and moves between workspaces', async () => {
    const { userId, ws } = await makeWorkspace();
    const { ws: ws2 } = await makeWorkspace();
    const doc = newId();
    const meetingId = newId();
    await db
      .insert(s.document)
      .values({ id: doc, workspaceId: ws, ownerId: userId, kind: 'meeting' });
    await db.insert(s.meeting).values({ id: meetingId, documentId: doc });
    await db.insert(s.transcriptSegment).values({
      id: `seg-${meetingId}`,
      meetingId,
      source: 'mic',
      startMs: 0,
      endMs: 1,
      text: 'a',
    });
    const start = await eventually([ws], null, 4);

    await db.update(s.document).set({ deletedAt: new Date() }).where(eq(s.document.id, doc));
    const soft = await eventually([ws], start.cursor, 1);
    expect(soft.changes).toMatchObject([{ tableName: 'document', rowId: doc, op: 'upsert' }]);

    // Hard delete cascades to meeting + segments; children whose parent is gone are covered by its row.
    await db.delete(s.document).where(eq(s.document.id, doc));
    const del = await eventually([ws], soft.cursor, 1);
    expect(del.changes).toMatchObject([{ tableName: 'document', rowId: doc, op: 'delete' }]);

    // A row moving between workspaces is a delete in the old one and an upsert in the new one.
    const folderId = newId();
    await db.insert(s.folder).values({
      id: folderId,
      workspaceId: ws,
      name: 'F',
      visibility: 'workspace',
      ownerId: userId,
    });
    const ins = await eventually([ws], del.cursor, 1);
    await db.update(s.folder).set({ workspaceId: ws2 }).where(eq(s.folder.id, folderId));
    const moved = await eventually([ws, ws2], ins.cursor, 2);
    expect(moved.changes.map((c) => [c.workspaceId, c.op])).toEqual(
      expect.arrayContaining([
        [ws, 'delete'],
        [ws2, 'upsert'],
      ]),
    );

    // Deleting a workspace is logged too (change_log has no FK to workspace).
    await db.delete(s.workspace).where(eq(s.workspace.id, ws2));
    const gone = await eventually([ws2], moved.cursor, 2);
    expect(gone.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tableName: 'workspace', rowId: ws2, op: 'delete' }),
        expect.objectContaining({ tableName: 'folder', rowId: folderId, op: 'delete' }),
      ]),
    );
  });
});

describe('readChanges', () => {
  it('filters by workspace and pages with the cursor', async () => {
    const a = await makeWorkspace();
    const b = await makeWorkspace();
    for (let i = 0; i < 5; i++) {
      await db
        .insert(s.folder)
        .values({ workspaceId: a.ws, name: `A${i}`, visibility: 'workspace', ownerId: a.userId });
    }
    await db
      .insert(s.folder)
      .values({ workspaceId: b.ws, name: 'B', visibility: 'workspace', ownerId: b.userId });

    const all = await eventually([a.ws], null, 6); // workspace row + 5 folders
    expect(all.changes.every((c) => c.workspaceId === a.ws)).toBe(true);

    const p1 = await readChanges(db, [a.ws], null, { limit: 4 });
    expect(p1.changes).toHaveLength(4);
    expect(p1.hasMore).toBe(true);
    const p2 = await readChanges(db, [a.ws], p1.cursor, { limit: 4 });
    expect(p2.changes).toHaveLength(2);
    expect(p2.hasMore).toBe(false);
    expect([...p1.changes, ...p2.changes]).toEqual(all.changes);

    // Nothing new: cursor is returned unchanged.
    const p3 = await readChanges(db, [a.ws], p2.cursor);
    expect(p3).toEqual({ changes: [], cursor: p2.cursor, hasMore: false });
    expect(await readChanges(db, [], null)).toEqual({ changes: [], cursor: null, hasMore: false });
    await expect(readChanges(db, [a.ws], 'garbage')).rejects.toThrow(/cursor/);
  });

  it('never skips a transaction that commits after a later one (two connections)', async () => {
    const { userId, ws } = await makeWorkspace();
    const start = await eventually([ws], null, 1);

    const early = await db.$client.reserve();
    const late = await db.$client.reserve();
    const folderSql = (conn: typeof early, name: string) =>
      conn`insert into folder (id, workspace_id, name, visibility, owner_id)
           values (${newId()}, ${ws}, ${name}, 'workspace', ${userId})`;
    try {
      // `early` writes first (lower txid + seq) but commits last.
      await early`begin`;
      await folderSql(early, 'early');
      await late`begin`;
      await folderSql(late, 'late');
      await late`commit`;

      // A naive `seq > cursor` reader would now return "late" and move its cursor past "early".
      const [naive] = await db.$client<{ n: number }[]>`
        select count(*)::int as n from change_log where workspace_id = ${ws} and table_name = 'folder'`;
      expect(naive?.n).toBe(1);
      // readChanges holds "late" back while "early" (an older transaction) is still running.
      const during = await readChanges(db, [ws], start.cursor);
      expect(during.changes).toEqual([]);
      expect(during.cursor).toBe(start.cursor);

      await early`commit`;
    } finally {
      early.release();
      late.release();
    }

    const after = await eventually([ws], start.cursor, 2);
    const names = await Promise.all(
      after.changes.map(async (c) => {
        const [f] = await db.select().from(s.folder).where(eq(s.folder.id, c.rowId));
        return f?.name;
      }),
    );
    expect(names).toEqual(['early', 'late']);
  });
});
