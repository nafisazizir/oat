/**
 * `/api/search` (3.6) end to end through the route handler: real Better Auth sessions, documents written
 * through the documents API (so `content_md` is derived like in production), transcript segments inserted
 * directly. Deny cases: anonymous, another member's private notes, non-members, other workspaces.
 */
import { findPersonalWorkspaceId } from '@oat/auth';
import { meeting, newId, transcriptSegment } from '@oat/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DocumentDetail } from '@/lib/api-types';
import type { SearchResponse } from '@/lib/search';

import { createSearchApi } from '../search';
import { BASE, call, createHarness, denies, type Harness, type TestUser } from './test-harness';

let h: Harness;
let searchApi: ReturnType<typeof createSearchApi>;
let alice: TestUser;
let bob: TestUser;
let outsider: TestUser;
let team: string;
let alicePersonal: string;

const paragraph = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

async function created(as: TestUser, body: Record<string, unknown>): Promise<DocumentDetail> {
  const res = await call<DocumentDetail>(h.api.documents.POST, 'POST', '/api/documents', {
    as,
    body,
  });
  expect(res.status, JSON.stringify(res.error)).toBe(201);
  return res.body;
}

const search = (as: TestUser | null, query: string, opts: { bearer?: boolean } = {}) =>
  call<SearchResponse>(searchApi.GET, 'GET', `/api/search?${query}`, { as, ...opts });

beforeAll(async () => {
  h = await createHarness();
  searchApi = createSearchApi({
    db: () => h.db,
    getSession: (headers) => h.auth.api.getSession({ headers }),
    allowedOrigins: () => [BASE],
  });
  [alice, bob, outsider] = await Promise.all([
    h.signUp('alice'),
    h.signUp('bob'),
    h.signUp('outsider'),
  ]);
  team = await h.teamWorkspace(alice, [[bob, 'member']]);
  alicePersonal = (await findPersonalWorkspaceId(h.db, alice.id))!;

  await created(alice, {
    workspaceId: alicePersonal,
    title: 'Pelican personal notes',
    contentJson: paragraph(
      'My pelican thoughts on R&D and a<b comparisons, <script>alert(1)</script> today',
    ),
  });
  await created(alice, {
    workspaceId: team,
    title: 'Pelican private draft',
    contentJson: paragraph('Not for Bob.'),
  });
  await created(alice, {
    workspaceId: team,
    title: 'Pelican roadmap',
    visibility: 'workspace',
    contentJson: paragraph('The pelican launch is in March.'),
  });
  for (let i = 0; i < 3; i++) {
    await created(bob, {
      workspaceId: team,
      title: `Bob pelican page ${i}`,
      visibility: 'workspace',
    });
  }
  const standup = await created(alice, {
    workspaceId: team,
    kind: 'meeting',
    title: 'Pelican standup',
    visibility: 'workspace',
  });
  const oneOnOne = await created(alice, { workspaceId: team, kind: 'meeting', title: '1:1' });
  for (const [doc, text] of [
    [standup, 'Shipping the pelican feature on Friday.'],
    [oneOnOne, 'Private pelican feedback.'],
  ] as const) {
    const meetingId = newId();
    await h.db.insert(meeting).values({ id: meetingId, documentId: doc.id });
    await h.db.insert(transcriptSegment).values({
      id: newId(),
      meetingId,
      source: 'system',
      startMs: 125_000,
      endMs: 129_000,
      text,
    });
  }
}, 60_000);

afterAll(async () => {
  await h?.close();
});

describe('GET /api/search', () => {
  it('401 without a session', async () => {
    expect((await search(null, 'q=pelican')).status).toBe(401);
  });

  it('returns notes and transcript hits the user can read (cookie or bearer)', async () => {
    for (const bearer of [false, true]) {
      const res = await search(alice, 'q=pelican&limit=20', { bearer });
      expect(res.status).toBe(200);
      expect(res.body.notes!.items.map((n) => n.title).sort()).toEqual(
        [
          'Bob pelican page 0',
          'Bob pelican page 1',
          'Bob pelican page 2',
          'Pelican personal notes',
          'Pelican private draft',
          'Pelican roadmap',
          'Pelican standup',
        ].sort(),
      );
      expect(res.body.transcripts!.items.map((t) => t.documentTitle).sort()).toEqual([
        '1:1',
        'Pelican standup',
      ]);
    }
  });

  it('never returns another member’s private notes or transcripts', async () => {
    denies('GET /api/search');
    const res = await search(bob, 'q=pelican&limit=20');
    const titles = res.body.notes!.items.map((n) => n.title);
    expect(titles).not.toContain('Pelican private draft');
    expect(titles).not.toContain('Pelican personal notes');
    expect(titles).toContain('Pelican roadmap');
    expect(res.body.transcripts!.items).toEqual([
      expect.objectContaining({
        documentTitle: 'Pelican standup',
        startMs: 125_000,
        snippetHtml: expect.stringContaining('<mark>pelican</mark>'),
      }),
    ]);
    const outsiders = await search(outsider, 'q=pelican');
    expect(outsiders.body.notes!.items).toEqual([]);
    expect(outsiders.body.transcripts!.items).toEqual([]);
  });

  it('workspaceId scopes the search; a workspace you are not in is a 404', async () => {
    denies('GET /api/search');
    const res = await search(alice, `q=pelican&type=notes&workspaceId=${alicePersonal}`);
    expect(res.body.notes!.items.map((n) => n.title)).toEqual(['Pelican personal notes']);
    expect(res.body.transcripts).toBeUndefined();
    expect((await search(bob, `q=pelican&workspaceId=${alicePersonal}`)).status).toBe(404);
    expect((await search(outsider, `q=pelican&workspaceId=${team}`)).status).toBe(404);
  });

  it('escapes snippets (only <mark> markup)', async () => {
    const res = await search(alice, `q=pelican thoughts&type=notes`);
    const [hit] = res.body.notes!.items;
    expect(hit!.title).toBe('Pelican personal notes');
    expect(hit!.snippetHtml.replace(/<\/?mark>/g, '')).not.toMatch(/[<>]/);
    expect(hit!.snippetHtml).toContain('R&amp;D and a &lt;b comparisons');
    expect(hit!.snippetHtml).not.toContain('<script');
  });

  it('pages one type with an opaque cursor', async () => {
    const first = await search(bob, 'q=pelican&type=notes&limit=2');
    expect(first.body.notes!.items).toHaveLength(2);
    const cursor = first.body.notes!.nextCursor!;
    expect(cursor).toBeTruthy();
    const second = await search(bob, `q=pelican&type=notes&limit=2&cursor=${cursor}`);
    const third = await search(
      bob,
      `q=pelican&type=notes&limit=2&cursor=${second.body.notes!.nextCursor}`,
    );
    const all = [first, second, third].flatMap((r) => r.body.notes!.items.map((n) => n.id));
    expect(new Set(all).size).toBe(5); // roadmap, standup, Bob's three
    expect(third.body.notes!.nextCursor).toBeNull();
  });

  it('400 on bad parameters; empty query → empty results', async () => {
    expect((await search(alice, 'q=x&type=bogus')).status).toBe(400);
    expect((await search(alice, 'q=x&limit=500')).status).toBe(400);
    expect((await search(alice, 'q=x&cursor=o10')).status).toBe(400); // type=all
    expect((await search(alice, 'q=x&type=notes&cursor=zzz')).status).toBe(400);
    const empty = await search(alice, 'q=%20%20');
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({
      query: '',
      notes: { items: [], nextCursor: null },
      transcripts: { items: [], nextCursor: null },
    });
  });
});
