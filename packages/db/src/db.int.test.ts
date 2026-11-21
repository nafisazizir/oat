import {
  CHAT_MESSAGE_ROLES,
  CHAT_SCOPES,
  DOCUMENT_KINDS,
  DOCUMENT_VISIBILITIES,
  FOLDER_VISIBILITIES,
  PARTICIPANT_SOURCES,
  ROLES,
  TRANSCRIPT_SOURCES,
} from '@oat/core';
import { createTestDatabase, type TestDatabase } from '@oat/testkit';
import { asc, cosineDistance, count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db, migrate } from './client.ts';
import { newId, newToken } from './id.ts';
import * as s from './schema/index.ts';
import { seed, SEED } from './seed.ts';

/** Postgres SQLSTATE of a failed query (postgres.js error, possibly wrapped by Drizzle). */
async function pgError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    const code = e.cause?.code ?? e.code;
    if (code) return code;
    throw err;
  }
  throw new Error('expected the query to fail');
}
const FK_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

/** A unit vector along axis `i` (1536-d), optionally blended with axis `j`. */
function axis(i: number, j?: number, w = 0): number[] {
  const v = new Array<number>(s.EMBEDDING_DIMENSIONS).fill(0);
  v[i] = 1;
  if (j !== undefined) v[j] = w;
  return v;
}

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

describe('migrations', () => {
  it('re-running migrate is a no-op', async () => {
    const before = await db.$client`select count(*)::int as n from drizzle.__drizzle_migrations`;
    await migrate(testDb.url);
    const after = await db.$client`select count(*)::int as n from drizzle.__drizzle_migrations`;
    expect(after[0]?.n).toBe(before[0]?.n);
    expect(before[0]?.n).toBeGreaterThanOrEqual(3);
  });

  it('concurrent migrate() calls on a fresh database serialise', async () => {
    const fresh = await createTestDatabase();
    try {
      await Promise.all([migrate(fresh.url), migrate(fresh.url), migrate(fresh.url)]);
      const check = createDb(fresh.url, { max: 1 });
      try {
        const [row] =
          await check.$client`select count(*)::int as n from drizzle.__drizzle_migrations`;
        const [mine] =
          await db.$client`select count(*)::int as n from drizzle.__drizzle_migrations`;
        expect(row?.n).toBe(mine?.n);
      } finally {
        await check.$client.end();
      }
    } finally {
      await fresh.drop();
    }
  });

  it('creates the extensions and every table', async () => {
    const ext = await db.$client<{ extname: string }[]>`select extname from pg_extension`;
    expect(ext.map((r) => r.extname)).toEqual(expect.arrayContaining(['vector', 'pg_trgm']));
    const tables = await db.$client<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public'`;
    expect(tables.map((r) => r.table_name)).toEqual(
      expect.arrayContaining(['user', 'workspace', 'document', 'transcript_segment', 'change_log']),
    );
  });

  it('database enum values equal the schema and @oat/core', async () => {
    const rows = await db.$client<{ typname: string; labels: string[] }[]>`
      select t.typname, array_agg(e.enumlabel order by e.enumsortorder) as labels
      from pg_type t join pg_enum e on e.enumtypid = t.oid group by t.typname`;
    const inDb = Object.fromEntries(rows.map((r) => [r.typname, r.labels]));
    const pgEnums = [
      s.roleEnum,
      s.inviteStatusEnum,
      s.folderVisibilityEnum,
      s.documentVisibilityEnum,
      s.documentKindEnum,
      s.transcriptSourceEnum,
      s.participantSourceEnum,
      s.enhancementStatusEnum,
      s.chatScopeEnum,
      s.chatMessageRoleEnum,
      s.integrationProviderEnum,
      s.changeOpEnum,
    ];
    for (const e of pgEnums) expect(inDb[e.enumName], e.enumName).toEqual(e.enumValues);
    expect(inDb).not.toHaveProperty('workspace_kind'); // D-36
    expect(inDb).toMatchObject({
      role: [...ROLES],
      folder_visibility: [...FOLDER_VISIBILITIES],
      document_visibility: [...DOCUMENT_VISIBILITIES],
      document_kind: [...DOCUMENT_KINDS],
      transcript_source: [...TRANSCRIPT_SOURCES],
      participant_source: [...PARTICIPANT_SOURCES],
      chat_scope: [...CHAT_SCOPES],
      chat_message_role: [...CHAT_MESSAGE_ROLES],
    });
  });
});

describe('seed', () => {
  it('reuses a demo user and their first workspace that already exist under other ids', async () => {
    const fresh = await createTestDatabase();
    const other = createDb(fresh.url, { max: 2 });
    try {
      await migrate(fresh.url);
      const userId = newId();
      const wsId = newId();
      await other.insert(s.user).values({ id: userId, email: SEED.email, name: 'Signed up' });
      await other.insert(s.workspace).values({
        id: wsId,
        name: 'Mine',
        slug: `mine-${userId}`,
        createdBy: userId,
      });
      await other.insert(s.membership).values({ workspaceId: wsId, userId, role: 'owner' });

      const result = await seed(other);
      expect(result.inserted).toMatchObject({ user: 0, workspace: 1, membership: 1 });
      const docs = await other.select().from(s.document).where(eq(s.document.workspaceId, wsId));
      expect(docs.map((d) => d.ownerId)).toEqual([userId, userId]);
      expect(Object.values((await seed(other)).inserted).every((n) => n === 0)).toBe(true);
    } finally {
      await other.$client.end();
      await fresh.drop();
    }
  });

  it('populates demo data and is idempotent', async () => {
    const first = await seed(db);
    expect(first.inserted).toMatchObject({ user: 1, workspace: 2, membership: 2, document: 4 });
    expect(first.inserted.transcript_segment).toBeGreaterThan(0);

    const second = await seed(db);
    expect(Object.values(second.inserted).every((n) => n === 0)).toBe(true);

    const [docs] = await db.select({ n: count() }).from(s.document);
    expect(docs?.n).toBe(4);
    const segments = await db
      .select()
      .from(s.transcriptSegment)
      .where(eq(s.transcriptSegment.meetingId, SEED.meetingId))
      .orderBy(asc(s.transcriptSegment.startMs));
    expect(segments.length).toBe(first.inserted.transcript_segment);
  });
});

describe('tables', () => {
  // Fresh fixtures independent of the seed.
  const ids = {
    user: newId(),
    other: newId(),
    ws: newId(),
    folder: newId(),
    doc: newId(),
    meeting: newId(),
    template: newId(),
    thread: newId(),
  };

  beforeAll(async () => {
    await db.insert(s.user).values([
      { id: ids.user, email: `${ids.user}@example.test`, name: null },
      { id: ids.other, email: `${ids.other}@example.test`, name: 'Other' },
    ]);
    await db
      .insert(s.workspace)
      .values({ id: ids.ws, name: 'T', slug: `t-${ids.ws}`, createdBy: ids.user });
    await db.insert(s.membership).values({ workspaceId: ids.ws, userId: ids.user, role: 'owner' });
    await db.insert(s.folder).values({
      id: ids.folder,
      workspaceId: ids.ws,
      name: 'F',
      visibility: 'workspace',
      ownerId: ids.user,
    });
    await db.insert(s.document).values({
      id: ids.doc,
      workspaceId: ids.ws,
      folderId: ids.folder,
      ownerId: ids.user,
      kind: 'meeting',
      title: 'Doc',
    });
    await db.insert(s.template).values({
      id: ids.template,
      workspaceId: ids.ws,
      name: 'Tpl',
      sectionsJson: [{ heading: 'Notes', instructions: '' }],
    });
    await db
      .insert(s.meeting)
      .values({ id: ids.meeting, documentId: ids.doc, templateId: ids.template });
  });

  it('applies defaults and reads back typed rows', async () => {
    const [ws] = await db.select().from(s.workspace).where(eq(s.workspace.id, ids.ws));
    expect(ws).toMatchObject({ logo: null, metadata: null });
    expect(ws).not.toHaveProperty('kind');
    expect(ws?.createdAt).toBeInstanceOf(Date);

    const [doc] = await db.select().from(s.document).where(eq(s.document.id, ids.doc));
    expect(doc).toMatchObject({
      visibility: 'private',
      version: 0,
      contentJson: { type: 'doc', content: [] },
      contentMd: '',
      shareToken: null,
      deletedAt: null,
    });

    const [inv] = await db
      .insert(s.invite)
      .values({
        workspaceId: ids.ws,
        email: 'invitee@example.test',
        inviterId: ids.user,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning();
    expect(inv).toMatchObject({ role: 'member', status: 'pending', acceptedAt: null });
    expect(inv?.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it('bumps updated_at on drizzle updates', async () => {
    const [before] = await db.select().from(s.document).where(eq(s.document.id, ids.doc));
    await new Promise((r) => setTimeout(r, 5));
    const [after] = await db
      .update(s.document)
      .set({ title: 'Renamed', version: sql`${s.document.version} + 1` })
      .where(eq(s.document.id, ids.doc))
      .returning();
    expect(after?.version).toBe(1);
    expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());
  });

  it('stores participants, segments, enhancements, chat, integrations and change log', async () => {
    await db.insert(s.participant).values({ meetingId: ids.meeting, name: 'P', source: 'manual' });
    await db.insert(s.transcriptSegment).values([
      {
        id: 'client-seg-2',
        meetingId: ids.meeting,
        source: 'system',
        startMs: 2000,
        endMs: 3000,
        text: 'b',
      },
      {
        id: 'client-seg-1',
        meetingId: ids.meeting,
        source: 'mic',
        startMs: 0,
        endMs: 1500,
        text: 'a',
      },
    ]);
    const segs = await db
      .select({ id: s.transcriptSegment.id, isFinal: s.transcriptSegment.isFinal })
      .from(s.transcriptSegment)
      .where(eq(s.transcriptSegment.meetingId, ids.meeting))
      .orderBy(asc(s.transcriptSegment.startMs));
    expect(segs).toEqual([
      { id: 'client-seg-1', isFinal: true },
      { id: 'client-seg-2', isFinal: true },
    ]);

    const [enh] = await db
      .insert(s.enhancement)
      .values({
        documentId: ids.doc,
        templateId: ids.template,
        model: 'mock',
        inputHash: 'h',
        inputNotesJson: { type: 'doc', content: [] },
        idempotencyKey: `enh-${ids.doc}`,
      })
      .returning();
    expect(enh).toMatchObject({ status: 'generating', outputJson: null, completedAt: null });
    expect(enh?.startedAt).toBeInstanceOf(Date);
    await db
      .update(s.enhancement)
      .set({ status: 'completed', outputJson: { sections: [] }, completedAt: new Date() })
      .where(eq(s.enhancement.id, enh!.id));

    const [thread] = await db
      .insert(s.chatThread)
      .values({
        id: ids.thread,
        workspaceId: ids.ws,
        userId: ids.user,
        scope: 'document',
        documentId: ids.doc,
      })
      .returning();
    expect(thread?.title).toBe('');
    await db.insert(s.chatMessage).values({
      threadId: ids.thread,
      role: 'user',
      partsJson: [{ type: 'text', text: 'hi' }],
      contextJson: { documentId: ids.doc },
    });
    const msgs = await db
      .select()
      .from(s.chatMessage)
      .where(eq(s.chatMessage.threadId, ids.thread));
    expect(msgs[0]).toMatchObject({ role: 'user', contextJson: { documentId: ids.doc } });

    const [integ] = await db
      .insert(s.integration)
      .values({ workspaceId: ids.ws, userId: ids.user, provider: 'notion' })
      .returning();
    expect(integ).toMatchObject({ settingsJson: {}, credentialsRef: null });

    const log = await db
      .insert(s.changeLog)
      .values([
        { tableName: 'document', rowId: ids.doc, workspaceId: ids.ws, op: 'upsert' },
        { tableName: 'document', rowId: ids.doc, workspaceId: ids.ws, op: 'delete' },
      ])
      .returning();
    expect(typeof log[0]?.seq).toBe('number');
    expect(log[1]!.seq).toBeGreaterThan(log[0]!.seq);
  });

  it('enforces foreign keys', async () => {
    expect(
      await pgError(
        db.insert(s.document).values({ workspaceId: newId(), ownerId: ids.user, kind: 'page' }),
      ),
    ).toBe(FK_VIOLATION);
    expect(
      await pgError(
        db.insert(s.transcriptSegment).values({
          id: newId(),
          meetingId: newId(),
          source: 'mic',
          startMs: 0,
          endMs: 1,
          text: '',
        }),
      ),
    ).toBe(FK_VIOLATION);
  });

  it('enforces unique constraints', async () => {
    expect(
      await pgError(db.insert(s.membership).values({ workspaceId: ids.ws, userId: ids.user })),
    ).toBe(UNIQUE_VIOLATION);
    expect(await pgError(db.insert(s.user).values({ email: `${ids.user}@example.test` }))).toBe(
      UNIQUE_VIOLATION,
    );
    // Case variants too (lower(email) unique index).
    expect(
      await pgError(db.insert(s.user).values({ email: `${ids.user.toUpperCase()}@Example.TEST` })),
    ).toBe(UNIQUE_VIOLATION);
    expect(
      await pgError(
        db.insert(s.workspace).values({ name: 'dup', slug: `t-${ids.ws}`, createdBy: ids.user }),
      ),
    ).toBe(UNIQUE_VIOLATION);
    expect(await pgError(db.insert(s.meeting).values({ documentId: ids.doc }))).toBe(
      UNIQUE_VIOLATION,
    );

    const token = newToken();
    const base = { workspaceId: ids.ws, ownerId: ids.user, kind: 'page' as const };
    await db.insert(s.document).values({ ...base, visibility: 'link', shareToken: token });
    expect(
      await pgError(
        db.insert(s.document).values({ ...base, visibility: 'link', shareToken: token }),
      ),
    ).toBe(UNIQUE_VIOLATION);

    const enh = {
      documentId: ids.doc,
      model: 'm',
      inputHash: 'h',
      inputNotesJson: {},
      idempotencyKey: `same-${ids.doc}`,
    };
    await db.insert(s.enhancement).values(enh);
    expect(await pgError(db.insert(s.enhancement).values(enh))).toBe(UNIQUE_VIOLATION);
  });

  it('enforces check constraints', async () => {
    const base = { workspaceId: ids.ws, ownerId: ids.user, kind: 'page' as const };
    // link visibility needs a token; tokens must look like share tokens; version >= 0
    expect(await pgError(db.insert(s.document).values({ ...base, visibility: 'link' }))).toBe(
      CHECK_VIOLATION,
    );
    expect(await pgError(db.insert(s.document).values({ ...base, shareToken: 'short' }))).toBe(
      CHECK_VIOLATION,
    );
    expect(await pgError(db.insert(s.document).values({ ...base, version: -1 }))).toBe(
      CHECK_VIOLATION,
    );
    // segment range
    expect(
      await pgError(
        db.insert(s.transcriptSegment).values({
          id: newId(),
          meetingId: ids.meeting,
          source: 'mic',
          startMs: 10,
          endMs: 5,
          text: '',
        }),
      ),
    ).toBe(CHECK_VIOLATION);
    // chat thread scope ⇔ documentId
    expect(
      await pgError(
        db.insert(s.chatThread).values({
          workspaceId: ids.ws,
          userId: ids.user,
          scope: 'workspace',
          documentId: ids.doc,
        }),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await pgError(
        db
          .insert(s.chatThread)
          .values({ workspaceId: ids.ws, userId: ids.user, scope: 'document' }),
      ),
    ).toBe(CHECK_VIOLATION);
    // built-in templates have no workspace, workspace templates aren't built-in
    expect(
      await pgError(
        db.insert(s.template).values({ name: 'x', workspaceId: ids.ws, isBuiltin: true }),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(await pgError(db.insert(s.template).values({ name: 'x', workspaceId: null }))).toBe(
      CHECK_VIOLATION,
    );
    // completed enhancement needs output + completed_at
    expect(
      await pgError(
        db.insert(s.enhancement).values({
          documentId: ids.doc,
          model: 'm',
          inputHash: 'h',
          inputNotesJson: {},
          idempotencyKey: newId(),
          status: 'completed',
        }),
      ),
    ).toBe(CHECK_VIOLATION);
    // folder cannot be its own parent
    const fid = newId();
    expect(
      await pgError(
        db.insert(s.folder).values({
          id: fid,
          parentId: fid,
          workspaceId: ids.ws,
          name: 'x',
          visibility: 'private',
          ownerId: ids.user,
        }),
      ),
    ).toBe(CHECK_VIOLATION);
    // enum values outside the contract
    expect(
      await pgError(
        db.$client`insert into membership (id, workspace_id, user_id, role) values (${newId()}, ${ids.ws}, ${ids.other}, 'admin,member')`,
      ),
    ).toBe('22P02');
  });

  it('cascades and restricts deletes as designed', async () => {
    const ws = newId();
    const folderA = newId();
    const folderB = newId();
    const doc = newId();
    const meetingId = newId();
    await db
      .insert(s.workspace)
      .values({ id: ws, name: 'C', slug: `c-${ws}`, createdBy: ids.other });
    await db.insert(s.folder).values([
      { id: folderA, workspaceId: ws, name: 'A', visibility: 'workspace', ownerId: ids.other },
      {
        id: folderB,
        workspaceId: ws,
        parentId: folderA,
        name: 'B',
        visibility: 'workspace',
        ownerId: ids.other,
      },
    ]);
    await db
      .insert(s.document)
      .values({ id: doc, workspaceId: ws, folderId: folderB, ownerId: ids.other, kind: 'meeting' });
    await db.insert(s.meeting).values({ id: meetingId, documentId: doc });
    await db
      .insert(s.transcriptSegment)
      .values({ id: newId(), meetingId, source: 'mic', startMs: 0, endMs: 1, text: 'x' });

    // Users who own content or created a workspace can't be deleted out from under it.
    expect(await pgError(db.delete(s.user).where(eq(s.user.id, ids.other)))).toBe(FK_VIOLATION);

    // Deleting a folder deletes its subfolders; their documents move to the root.
    await db.delete(s.folder).where(eq(s.folder.id, folderA));
    expect(await db.select().from(s.folder).where(eq(s.folder.workspaceId, ws))).toEqual([]);
    const [moved] = await db.select().from(s.document).where(eq(s.document.id, doc));
    expect(moved?.folderId).toBeNull();

    // Deleting a workspace removes its documents, meetings and segments.
    await db.delete(s.workspace).where(eq(s.workspace.id, ws));
    expect(await db.select().from(s.document).where(eq(s.document.id, doc))).toEqual([]);
    expect(
      await db
        .select()
        .from(s.transcriptSegment)
        .where(eq(s.transcriptSegment.meetingId, meetingId)),
    ).toEqual([]);
  });

  it('stores embeddings and ranks chunks by cosine distance', async () => {
    await db.insert(s.chunk).values([
      { documentId: ids.doc, workspaceId: ids.ws, text: 'x-axis', embedding: axis(0) },
      { documentId: ids.doc, workspaceId: ids.ws, text: 'mostly x', embedding: axis(0, 1, 0.5) },
      {
        documentId: ids.doc,
        workspaceId: ids.ws,
        text: 'y-axis',
        embedding: axis(1),
        source: 'transcript',
        segmentStartMs: 0,
        segmentEndMs: 1500,
      },
    ]);
    const query = axis(0, 1, 0.1);
    const distance = cosineDistance(s.chunk.embedding, query);
    const ranked = await db
      .select({ text: s.chunk.text, distance })
      .from(s.chunk)
      .where(eq(s.chunk.workspaceId, ids.ws))
      .orderBy(distance);
    expect(ranked.map((r) => r.text)).toEqual(['x-axis', 'mostly x', 'y-axis']);
    expect(Number(ranked[0]!.distance)).toBeLessThan(0.01);

    const [read] = await db.select().from(s.chunk).where(eq(s.chunk.text, 'y-axis'));
    expect(read?.embedding).toHaveLength(s.EMBEDDING_DIMENSIONS);
    expect(read?.embedding[1]).toBe(1);

    // Wrong dimensionality is rejected by pgvector.
    expect(
      await pgError(
        db
          .insert(s.chunk)
          .values({ documentId: ids.doc, workspaceId: ids.ws, text: 'bad', embedding: [1, 2, 3] }),
      ),
    ).toBe('22000');

    const [idx] = await db.$client<{ indexdef: string }[]>`
      select indexdef from pg_indexes where indexname = 'chunk_embedding_hnsw_idx'`;
    expect(idx?.indexdef).toMatch(/USING hnsw \(embedding vector_cosine_ops\)/);
  });
});
