/**
 * 3.6 search against a real, migrated Postgres: permission filtering across two users/workspaces (plus a
 * non-member and a removed member), snippet escaping, ranking sanity and query syntax.
 */
import { createTestDatabase, type TestDatabase } from '@oat/testkit';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type Db, migrate } from './client.ts';
import { newId } from './id.ts';
import * as s from './schema/index.ts';
import { searchDocuments, searchSegments, type SearchScope } from './search.ts';

let testDb: TestDatabase;
let db: Db;

const ids = {
  alice: newId(),
  bob: newId(),
  carol: newId(), // member of nothing Alice/Bob have
  dave: newId(), // former team member
  aliceOwn: newId(),
  bobOwn: newId(),
  carolOwn: newId(),
  team: newId(),
  gone: newId(), // soft-deleted team workspace (D-22)
};

/** Titles are unique per doc so assertions can name them. */
const docs: Record<string, string> = {};

async function addDoc(
  title: string,
  input: {
    workspaceId: string;
    ownerId: string;
    visibility?: 'private' | 'workspace' | 'link';
    contentMd?: string;
    kind?: 'page' | 'meeting';
    deleted?: boolean;
    updatedAt?: Date;
  },
): Promise<string> {
  const id = newId();
  const visibility = input.visibility ?? 'private';
  await db.insert(s.document).values({
    id,
    workspaceId: input.workspaceId,
    ownerId: input.ownerId,
    kind: input.kind ?? 'page',
    title,
    contentMd: input.contentMd ?? '',
    visibility,
    shareToken: visibility === 'link' ? `tok_${id.replace(/-/g, '')}` : null,
    deletedAt: input.deleted ? new Date() : null,
    ...(input.updatedAt ? { updatedAt: input.updatedAt, createdAt: input.updatedAt } : {}),
  });
  docs[title] = id;
  return id;
}

async function addMeeting(
  title: string,
  doc: Parameters<typeof addDoc>[1],
  segments: string[],
): Promise<string> {
  const documentId = await addDoc(title, { ...doc, kind: 'meeting' });
  const meetingId = newId();
  await db.insert(s.meeting).values({ id: meetingId, documentId });
  await db.insert(s.transcriptSegment).values(
    segments.map((text, i) => ({
      id: newId(),
      meetingId,
      source: i % 2 === 0 ? ('mic' as const) : ('system' as const),
      startMs: i * 5000,
      endMs: i * 5000 + 4000,
      text,
    })),
  );
  return documentId;
}

const as = (userId: string, workspaceIds?: string[]): SearchScope =>
  workspaceIds ? { userId, workspaceIds } : { userId };

async function titles(scope: SearchScope, q: string): Promise<string[]> {
  const { items } = await searchDocuments(db, scope, q, { limit: 50 });
  return items.map((h) => h.title);
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await migrate(testDb.url);
  db = createDb(testDb.url, { max: 4 });

  await db.insert(s.user).values([
    { id: ids.alice, email: `alice-${ids.alice}@example.test`, name: 'Alice' },
    { id: ids.bob, email: `bob-${ids.bob}@example.test`, name: 'Bob' },
    { id: ids.carol, email: `carol-${ids.carol}@example.test`, name: 'Carol' },
    { id: ids.dave, email: `dave-${ids.dave}@example.test`, name: 'Dave' },
  ]);
  await db.insert(s.workspace).values([
    {
      id: ids.aliceOwn,
      name: 'A',
      slug: `own-${ids.alice}`,
      createdBy: ids.alice,
    },
    {
      id: ids.bobOwn,
      name: 'B',
      slug: `own-${ids.bob}`,
      createdBy: ids.bob,
    },
    {
      id: ids.carolOwn,
      name: 'C',
      slug: `own-${ids.carol}`,
      createdBy: ids.carol,
    },
    { id: ids.team, name: 'Team', slug: `team-${ids.team}`, createdBy: ids.alice },
    { id: ids.gone, name: 'Gone', slug: `gone-${ids.gone}`, createdBy: ids.alice },
  ]);
  await db.insert(s.membership).values([
    { workspaceId: ids.aliceOwn, userId: ids.alice, role: 'owner' },
    { workspaceId: ids.bobOwn, userId: ids.bob, role: 'owner' },
    { workspaceId: ids.carolOwn, userId: ids.carol, role: 'owner' },
    { workspaceId: ids.team, userId: ids.alice, role: 'owner' },
    { workspaceId: ids.team, userId: ids.bob, role: 'viewer' },
    { workspaceId: ids.team, userId: ids.dave, role: 'member' },
    { workspaceId: ids.gone, userId: ids.alice, role: 'owner' },
    { workspaceId: ids.gone, userId: ids.bob, role: 'member' },
  ]);

  const team = { workspaceId: ids.team };
  await addDoc('Alice own zebra notes', {
    workspaceId: ids.aliceOwn,
    ownerId: ids.alice,
    contentMd: 'Zebra crossing budget for the side project.',
  });
  await addDoc('Bob own zebra secrets', {
    workspaceId: ids.bobOwn,
    ownerId: ids.bob,
    contentMd: 'Bob keeps his zebra plans here.',
  });
  await addDoc('Carol zebra diary', {
    workspaceId: ids.carolOwn,
    ownerId: ids.carol,
    visibility: 'workspace',
    contentMd: 'Even a workspace-visible doc in a workspace you are not in stays hidden.',
  });
  await addDoc('Team zebra private draft', { ...team, ownerId: ids.alice, visibility: 'private' });
  await addDoc('Team zebra roadmap', { ...team, ownerId: ids.alice, visibility: 'workspace' });
  await addDoc('Team zebra public link', { ...team, ownerId: ids.alice, visibility: 'link' });
  await addDoc('Team zebra trashed', {
    ...team,
    ownerId: ids.alice,
    visibility: 'workspace',
    deleted: true,
  });
  await addDoc('Dave zebra private', { ...team, ownerId: ids.dave, visibility: 'private' });
  await addDoc('Dave zebra shared', { ...team, ownerId: ids.dave, visibility: 'workspace' });

  await addMeeting('Team zebra standup', { ...team, ownerId: ids.alice, visibility: 'workspace' }, [
    'Morning everyone, quick standup today.',
    'The zebra migration shipped last night.',
  ]);
  await addMeeting(
    'Alice private zebra 1:1',
    { ...team, ownerId: ids.alice, visibility: 'private' },
    ['We talked about the zebra compensation plan.'],
  );
  await addMeeting(
    'Trashed zebra meeting',
    { ...team, ownerId: ids.alice, visibility: 'workspace', deleted: true },
    ['Zebra content in a trashed meeting.'],
  );

  // A team workspace that is soft-deleted afterwards: memberships stay, content must disappear.
  const gone = { workspaceId: ids.gone, ownerId: ids.alice };
  await addDoc('Gone zebra private', { ...gone, contentMd: 'zebra' });
  await addDoc('Gone zebra shared', { ...gone, visibility: 'workspace', contentMd: 'zebra' });
  await addMeeting('Gone zebra meeting', { ...gone, visibility: 'workspace' }, [
    'The zebra plan in a deleted workspace.',
  ]);
  await db.update(s.workspace).set({ deletedAt: new Date() }).where(eq(s.workspace.id, ids.gone));

  // Dave leaves the team: his own docs there become invisible to him (membership required).
  await db
    .delete(s.membership)
    .where(and(eq(s.membership.workspaceId, ids.team), eq(s.membership.userId, ids.dave)));
});

afterAll(async () => {
  await db?.$client.end();
  await testDb?.drop();
});

describe('permission filter', () => {
  it('Alice sees the docs of her own workspace and everything readable in the team, nothing of Bob/Carol', async () => {
    expect((await titles(as(ids.alice), 'zebra')).sort()).toEqual(
      [
        'Alice own zebra notes',
        'Alice private zebra 1:1',
        'Dave zebra shared',
        'Team zebra private draft',
        'Team zebra public link',
        'Team zebra roadmap',
        'Team zebra standup',
      ].sort(),
    );
  });

  it('Bob (team viewer) never sees Alice’s private docs, trashed docs or other people’s workspaces', async () => {
    expect((await titles(as(ids.bob), 'zebra')).sort()).toEqual(
      [
        'Bob own zebra secrets',
        'Dave zebra shared',
        'Team zebra public link',
        'Team zebra roadmap',
        'Team zebra standup',
      ].sort(),
    );
  });

  it('a non-member sees only their own workspace; a removed member sees nothing of the team', async () => {
    expect(await titles(as(ids.carol), 'zebra')).toEqual(['Carol zebra diary']);
    expect(await titles(as(ids.dave), 'zebra')).toEqual([]);
  });

  it('workspaceIds narrows the search but never widens it', async () => {
    expect((await titles(as(ids.alice, [ids.aliceOwn]), 'zebra')).sort()).toEqual([
      'Alice own zebra notes',
    ]);
    // Bob asking for Alice's own workspace / Carol's gets nothing.
    expect(await titles(as(ids.bob, [ids.aliceOwn, ids.carolOwn]), 'zebra')).toEqual([]);
    expect(await titles(as(ids.bob, []), 'zebra')).toEqual([]);
  });

  it('transcript hits follow the meeting document’s permissions', async () => {
    const alice = await searchSegments(db, as(ids.alice), 'zebra');
    expect(alice.items.map((h) => h.document.title).sort()).toEqual([
      'Alice private zebra 1:1',
      'Team zebra standup',
    ]);
    const bob = await searchSegments(db, as(ids.bob), 'zebra');
    expect(bob.items.map((h) => h.document.title)).toEqual(['Team zebra standup']);
    expect(bob.items[0]).toMatchObject({ startMs: 5000, endMs: 9000, source: 'system' });
    expect(bob.items[0]!.snippetHtml).toContain('<mark>zebra</mark>');
    expect((await searchSegments(db, as(ids.carol), 'zebra')).items).toEqual([]);
    expect((await searchSegments(db, as(ids.dave), 'zebra')).items).toEqual([]);
  });

  it('soft-deleted workspaces are excluded, with or without workspaceIds (members included)', async () => {
    for (const user of [ids.alice, ids.bob]) {
      for (const scope of [as(user), as(user, [ids.gone]), as(user, [ids.gone, ids.team])]) {
        const docTitles = await titles(scope, 'zebra');
        expect(docTitles.filter((t) => t.startsWith('Gone'))).toEqual([]);
        const segments = await searchSegments(db, scope, 'zebra');
        expect(segments.items.map((h) => h.document.title)).not.toContain('Gone zebra meeting');
      }
      expect(await titles(as(user, [ids.gone]), 'zebra')).toEqual([]);
    }
    // Restored → visible again (the filter is the workspace flag, not the data).
    await db.update(s.workspace).set({ deletedAt: null }).where(eq(s.workspace.id, ids.gone));
    try {
      expect((await titles(as(ids.bob, [ids.gone]), 'zebra')).sort()).toEqual([
        'Gone zebra meeting',
        'Gone zebra shared',
      ]);
      const segments = await searchSegments(db, as(ids.bob, [ids.gone]), 'zebra');
      expect(segments.items.map((h) => h.document.title)).toEqual(['Gone zebra meeting']);
    } finally {
      await db
        .update(s.workspace)
        .set({ deletedAt: new Date() })
        .where(eq(s.workspace.id, ids.gone));
    }
  });

  it('only final segments are searchable', async () => {
    const meetingDoc = docs['Team zebra standup']!;
    const [m] = await db.select().from(s.meeting).where(eq(s.meeting.documentId, meetingDoc));
    await db.insert(s.transcriptSegment).values({
      id: newId(),
      meetingId: m!.id,
      source: 'mic',
      startMs: 60_000,
      endMs: 61_000,
      text: 'interim quokka words',
      isFinal: false,
    });
    expect((await searchSegments(db, as(ids.alice), 'quokka')).items).toEqual([]);
  });
});

describe('snippets', () => {
  it('escapes HTML in titles and bodies; only <mark> remains', async () => {
    await addDoc('<b onmouseover="x()">Injected</b> walrus', {
      workspaceId: ids.aliceOwn,
      ownerId: ids.alice,
      contentMd:
        '<script>alert("walrus")</script> <img src=x onerror=alert(1)> walrus & friends fake <mark>not mine</mark>',
    });
    const { items } = await searchDocuments(db, as(ids.alice), 'walrus');
    expect(items).toHaveLength(1);
    const [hit] = items;
    for (const html of [hit!.titleHtml, hit!.snippetHtml]) {
      expect(html.replace(/<\/?mark>/g, '')).not.toMatch(/[<>]/);
    }
    expect(hit!.titleHtml).toBe(
      '&lt;b onmouseover=&quot;x()&quot;&gt;Injected&lt;/b&gt; <mark>walrus</mark>',
    );
    expect(hit!.snippetHtml).toContain('onerror=alert(1)&gt;');
    expect(hit!.snippetHtml).toContain('<mark>walrus</mark>');
    expect(hit!.snippetHtml).toContain('&amp;');
    // Sentinel characters in the content can't forge highlights.
    expect(hit!.snippetHtml).not.toContain('<mark>fake</mark>');
    expect(hit!.snippetHtml).not.toMatch(/[]/);
  });

  it('strips Markdown markers from body snippets', async () => {
    await addDoc('Markdown heron', {
      workspaceId: ids.aliceOwn,
      ownerId: ids.alice,
      contentMd:
        '## Heron facts\n\n> quoted\n\n- **Herons** wade in [shallow water](https://example.test/x).',
    });
    const { items } = await searchDocuments(db, as(ids.alice), 'heron');
    expect(items[0]!.snippetHtml).not.toMatch(/[#*[\]]|example\.test/);
    expect(items[0]!.snippetHtml).toContain('<mark>Herons</mark>');
  });
});

describe('ranking and matching', () => {
  beforeAll(async () => {
    const ws = { workspaceId: ids.aliceOwn, ownerId: ids.alice };
    const old = new Date(Date.now() - 200 * 86_400_000);
    await addDoc('Weekly sync', {
      ...ws,
      contentMd: 'We mentioned the okapi once.',
      updatedAt: old,
    });
    await addDoc('Okapi field guide', { ...ws, contentMd: 'Everything about the okapi.' });
    await addDoc('Older okapi copy', { ...ws, contentMd: 'Same text.', updatedAt: old });
    await addDoc('Newer okapi copy', { ...ws, contentMd: 'Same text.' });
    await addDoc('Café planning', { ...ws, contentMd: 'Résumé of the naïve plan.' });
    await addDoc('Quarterly budget review', {
      ...ws,
      contentMd: 'Budget numbers, draft one. Projected spend.',
    });
    await addDoc('Budget draft', { ...ws, contentMd: 'A draft of the budget.' });
  });

  it('title matches outrank body-only matches; newer outranks older among equals', async () => {
    const order = await titles(as(ids.alice), 'okapi');
    expect(order.at(-1)).toBe('Weekly sync');
    expect(order.indexOf('Newer okapi copy')).toBeLessThan(order.indexOf('Older okapi copy'));
    expect(order.slice(0, 3)).toContain('Okapi field guide');
  });

  it('matches stems, prefixes while typing, and folds accents', async () => {
    expect(await titles(as(ids.alice), 'reviews')).toEqual(['Quarterly budget review']);
    expect(await titles(as(ids.alice), 'quarterl')).toEqual(['Quarterly budget review']);
    expect(await titles(as(ids.alice), 'cafe')).toEqual(['Café planning']);
    expect(await titles(as(ids.alice), 'resume naive')).toEqual(['Café planning']);
  });

  it('supports web-search syntax: phrases and exclusions', async () => {
    expect(await titles(as(ids.alice), '"budget review"')).toEqual(['Quarterly budget review']);
    expect(await titles(as(ids.alice), 'budget -projected')).toEqual(['Budget draft']);
  });

  it('falls back to trigram title matches: typos, substrings and short prefixes', async () => {
    expect(await titles(as(ids.alice), 'budgett')).toEqual(
      expect.arrayContaining(['Quarterly budget review', 'Budget draft']),
    );
    expect(await titles(as(ids.alice), 'arterly')).toEqual(['Quarterly budget review']);
    // 2 characters: word prefix ("quoted" in a body matches too, below the title hit).
    expect((await titles(as(ids.alice), 'Qu'))[0]).toBe('Quarterly budget review');
    expect(await titles(as(ids.alice), 'ua')).toEqual([]);
  });

  it('pages with limit/offset and reports hasMore', async () => {
    const first = await searchDocuments(db, as(ids.alice), 'okapi', { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const rest = await searchDocuments(db, as(ids.alice), 'okapi', { limit: 2, offset: 2 });
    expect(rest.items).toHaveLength(2);
    expect(rest.hasMore).toBe(false);
    const seen = [...first.items, ...rest.items].map((h) => h.id);
    expect(new Set(seen).size).toBe(4);
  });

  it('returns nothing (and never errors) for empty, punctuation-only or stopword queries', async () => {
    expect(await titles(as(ids.alice), '')).toEqual([]);
    expect(await titles(as(ids.alice), '&|!:*')).toEqual([]);
    await expect(titles(as(ids.alice), 'the')).resolves.toBeDefined();
    await expect(titles(as(ids.alice), '"the" -a or')).resolves.toBeDefined();
  });

  it('the generated columns follow writes', async () => {
    const id = docs['Budget draft']!;
    await db
      .update(s.document)
      .set({ title: 'Renamed capybara', contentMd: 'now about capybaras' })
      .where(eq(s.document.id, id));
    expect(await titles(as(ids.alice), 'capybara')).toEqual(['Renamed capybara']);
    const [row] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from document where search_tsv @@ to_tsquery('public.oat_search', 'draft') and id = ${id}`,
    );
    expect(row!.n).toBe(0);
  });
});
