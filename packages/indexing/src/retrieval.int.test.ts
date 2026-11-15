/** `searchChunks`: permission-safe retrieval across users and workspaces, relevance with mock embeddings. */
import { createMockEmbeddingModel } from '@oat/ai/testing';
import { canReadDocument, createPermissionContext, type PermissionContext } from '@oat/core';
import { schema as s } from '@oat/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backfill } from './backfill.ts';
import {
  addSegments,
  body,
  type Env,
  heading,
  makeDocument,
  makeUser,
  makeWorkspace,
  paragraph,
  setupEnv,
  teardownEnv,
} from './int-fixtures.ts';
import { chunkTextFtsRank, type SearchOptions, searchChunks } from './retrieval.ts';

let env: Env;
const model = createMockEmbeddingModel();
const users = { alice: '', bob: '', carol: '' };
const ws = { shared: '', aliceOnly: '' };
const docs: Record<string, string> = {};

beforeAll(async () => {
  env = await setupEnv();
  const { db } = env;
  users.alice = await makeUser(db, 'Alice');
  users.bob = await makeUser(db, 'Bob');
  users.carol = await makeUser(db, 'Carol');
  ws.shared = await makeWorkspace(db, users.alice, [[users.bob, 'member']]);
  ws.aliceOnly = await makeWorkspace(db, users.alice);
  await makeWorkspace(db, users.carol);

  const page = (
    key: string,
    input: Omit<Parameters<typeof makeDocument>[1], 'content'>,
    text: string,
  ) =>
    makeDocument(db, {
      ...input,
      content: body(heading(`${key}-h`, 'Notes'), paragraph(`${key}-p`, text)),
    }).then((id) => (docs[key] = id));
  const A = { ownerId: users.alice };
  await page(
    'sharedBudget',
    { ...A, workspaceId: ws.shared, visibility: 'workspace', title: 'Budget review' },
    'Quarterly budget planning: marketing spend grows, travel budget shrinks.',
  );
  await page(
    'alicePrivate',
    { ...A, workspaceId: ws.shared, visibility: 'private', title: 'Private budget' },
    'Confidential budget planning for the acquisition.',
  );
  await page(
    'bobPrivate',
    { ownerId: users.bob, workspaceId: ws.shared, visibility: 'private', title: 'Bob budget' },
    'My own budget planning thoughts.',
  );
  await page(
    'linkShared',
    { ...A, workspaceId: ws.shared, visibility: 'link', title: 'Linked budget' },
    'Budget planning summary shared by link.',
  );
  await page(
    'otherWorkspace',
    { ...A, workspaceId: ws.aliceOnly, visibility: 'workspace', title: 'W2 budget' },
    'Budget planning in another workspace.',
  );
  await page(
    'trashed',
    { ...A, workspaceId: ws.shared, visibility: 'workspace', title: 'Old budget' },
    'Budget planning that was thrown away.',
  );
  await db
    .update(s.document)
    .set({ deletedAt: new Date() })
    .where(eq(s.document.id, docs.trashed!));
  const distractors = [
    'Lunch menu: pizza on Friday, salad bar on Tuesday.',
    'Office move: the new desks arrive next week.',
    'Design critique of the onboarding illustrations.',
    'Security training is mandatory for all staff.',
    'Customer interview about the mobile app crash.',
    'Holiday calendar and vacation requests.',
  ];
  for (const [i, text] of distractors.entries()) {
    await page(
      `noise${i}`,
      { ...A, workspaceId: ws.shared, visibility: 'workspace', title: `Note ${i}` },
      text,
    );
  }
  docs.meeting = await makeDocument(db, {
    ...A,
    workspaceId: ws.shared,
    visibility: 'workspace',
    kind: 'meeting',
    title: 'Weekly sync',
  });
  const [m] = await db.insert(s.meeting).values({ documentId: docs.meeting }).returning();
  await addSegments(db, m!.id, [
    {
      id: 'seg-1',
      source: 'mic',
      startMs: 120_000,
      endMs: 125_000,
      text: 'Let us talk about the hiring pipeline.',
    },
    {
      id: 'seg-2',
      source: 'system',
      startMs: 125_500,
      endMs: 131_000,
      text: 'We need two more backend engineers for hiring.',
    },
  ]);

  const totals = await backfill({ db, embeddingModel: model });
  expect(totals.failed).toEqual([]);
});
afterAll(() => teardownEnv(env));

async function ctxFor(userId: string | null, shareToken?: string): Promise<PermissionContext> {
  const memberships = userId
    ? await env.db.select().from(s.membership).where(eq(s.membership.userId, userId))
    : [];
  return createPermissionContext({ userId, memberships, shareToken });
}

async function search(userId: string | null, query: string, options: SearchOptions = {}) {
  return searchChunks(
    { db: env.db, permissions: await ctxFor(userId), embeddingModel: model },
    query,
    {
      k: 20,
      ...options,
    },
  );
}
const docKeys = (hits: { documentId: string }[]) =>
  [...new Set(hits.map((h) => Object.keys(docs).find((k) => docs[k] === h.documentId)!))].sort();

describe('searchChunks permissions', () => {
  it('returns only what each user may read: own, workspace and link docs of their workspaces, never trash', async () => {
    expect(docKeys(await search(users.bob, 'budget planning'))).toEqual(
      expect.arrayContaining(['bobPrivate', 'linkShared', 'sharedBudget']),
    );
    const bob = docKeys(await search(users.bob, 'budget planning'));
    expect(bob).not.toContain('alicePrivate');
    expect(bob).not.toContain('otherWorkspace');
    expect(bob).not.toContain('trashed');

    const alice = docKeys(await search(users.alice, 'budget planning'));
    expect(alice).toEqual(
      expect.arrayContaining(['alicePrivate', 'otherWorkspace', 'sharedBudget', 'linkShared']),
    );
    expect(alice).not.toContain('bobPrivate');
    expect(alice).not.toContain('trashed');

    expect(await search(users.carol, 'budget planning')).toEqual([]);
    expect(await search(null, 'budget planning')).toEqual([]);
  });

  it('a share token never widens search', async () => {
    const [linked] = await env.db
      .select()
      .from(s.document)
      .where(eq(s.document.id, docs.linkShared!));
    const anon = await ctxFor(null, linked!.shareToken!);
    expect(canReadDocument(anon, linked!)).toBe(true); // it can *read* the page…
    const hits = await searchChunks(
      { db: env.db, permissions: anon, embeddingModel: model },
      'budget',
      {
        scope: { documentId: linked!.id },
      },
    );
    expect(hits).toEqual([]); // …but not search it
  });

  it('scopes to one document or one workspace, and an unreadable scope is empty', async () => {
    const own = await search(users.alice, 'budget', { scope: { documentId: docs.alicePrivate! } });
    expect(own.length).toBeGreaterThan(0);
    expect(new Set(own.map((h) => h.documentId))).toEqual(new Set([docs.alicePrivate]));
    expect(
      await search(users.bob, 'budget', { scope: { documentId: docs.alicePrivate! } }),
    ).toEqual([]);
    expect(await search(users.bob, 'budget', { scope: { workspaceId: ws.aliceOnly } })).toEqual([]);
    const w2 = await search(users.alice, 'budget', { scope: { workspaceId: ws.aliceOnly } });
    expect(docKeys(w2)).toEqual(['otherWorkspace']);
  });

  it('agrees with canReadDocument for every (user, document) pair', async () => {
    const rows = await env.db.select().from(s.document);
    for (const userId of [users.alice, users.bob, users.carol]) {
      const ctx = await ctxFor(userId);
      for (const doc of rows) {
        const hits = await searchChunks(
          { db: env.db, permissions: ctx, embeddingModel: model },
          'notes',
          {
            scope: { documentId: doc.id },
          },
        );
        const expected = doc.deletedAt === null && canReadDocument(ctx, doc);
        expect({ doc: doc.title, userId, found: hits.length > 0 }).toEqual({
          doc: doc.title,
          userId,
          found: expected,
        });
      }
    }
  });

  it('hides a soft-deleted workspace even from a context that still lists the membership', async () => {
    await env.db
      .update(s.workspace)
      .set({ deletedAt: new Date() })
      .where(eq(s.workspace.id, ws.aliceOnly));
    try {
      // ctxFor builds the context from raw membership rows (loadPermissionContext would drop it already).
      expect(docKeys(await search(users.alice, 'budget planning'))).not.toContain('otherWorkspace');
    } finally {
      await env.db
        .update(s.workspace)
        .set({ deletedAt: null })
        .where(eq(s.workspace.id, ws.aliceOnly));
    }
    expect(docKeys(await search(users.alice, 'budget planning'))).toContain('otherWorkspace');
  });

  it('applies visibility changes immediately, without re-indexing', async () => {
    await env.db
      .update(s.document)
      .set({ visibility: 'private' })
      .where(eq(s.document.id, docs.sharedBudget!));
    try {
      expect(docKeys(await search(users.bob, 'budget planning'))).not.toContain('sharedBudget');
    } finally {
      await env.db
        .update(s.document)
        .set({ visibility: 'workspace' })
        .where(eq(s.document.id, docs.sharedBudget!));
    }
    expect(docKeys(await search(users.bob, 'budget planning'))).toContain('sharedBudget');
  });
});

describe('searchChunks ranking', () => {
  it('ranks the relevant transcript chunk top-3 and returns its citation', async () => {
    const hits = await search(users.bob, 'hiring backend engineers', { k: 3 });
    expect(hits).toHaveLength(3);
    const hit = hits.find((h) => h.documentId === docs.meeting);
    expect(hit).toBeDefined();
    expect(hit!.ref).toEqual({
      source: 'transcript',
      segmentIds: ['seg-1', 'seg-2'],
      startMs: 120_000,
      endMs: 131_000,
    });
    expect(hit!.documentTitle).toBe('Weekly sync');
    expect(hit!.documentKind).toBe('meeting');
    // Scores are cosine similarities, best first.
    expect(hits.map((h) => h.score)).toEqual([...hits.map((h) => h.score)].sort((a, b) => b - a));
  });

  it('ranks the relevant note top-3 among distractors, with block refs', async () => {
    const hits = await search(users.bob, 'marketing spend and travel budget', { k: 3 });
    const hit = hits.find((h) => h.documentId === docs.sharedBudget);
    expect(hit).toBeDefined();
    expect(hit!.ref).toEqual({ source: 'notes', blockIds: ['sharedBudget-h', 'sharedBudget-p'] });
    expect(hit!.text).toContain('marketing spend');
  });

  it('filters by source', async () => {
    const hits = await search(users.bob, 'hiring', { sources: ['notes'] });
    expect(hits.every((h) => h.ref.source === 'notes')).toBe(true);
  });

  it('fuses an FTS rank when given one (hybrid), still permission-safe', async () => {
    const hits = await search(users.bob, 'acquisition', { ftsRank: chunkTextFtsRank, k: 5 });
    expect(docKeys(hits)).not.toContain('alicePrivate');
    const alice = await search(users.alice, 'acquisition', { ftsRank: chunkTextFtsRank, k: 5 });
    expect(alice[0]!.documentId).toBe(docs.alicePrivate);
    expect(alice[0]!.score).toBeGreaterThan(alice[1]!.score);
  });

  it('returns nothing for an empty query', async () => {
    expect(await search(users.alice, '   ')).toEqual([]);
  });
});
