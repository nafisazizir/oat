/**
 * Document sharing (5.3) against a throwaway database: the share settings API (`/api/documents/:id/share`)
 * with its deny cases, token issue/rotation/clearing (D-18), the D-18 private-folder rule, and the public
 * resolver behind `/share/[token]` (`loadSharedDocument`): disabled, reset and trashed links resolve to
 * nothing, the transcript only when opted in, and nothing beyond the document leaks. A link viewer has
 * no session, so no API route answers them.
 */
import { MIN_SHARE_TOKEN_LENGTH } from '@oat/core';
import { document, meeting, transcriptSegment, user } from '@oat/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DocumentDetail, DocumentSharing, FolderSummary } from '@/lib/api-types';

import { loadSharedDocument, newShareToken } from '../sharing';
import {
  call,
  type CallOptions,
  createHarness,
  denies,
  type Harness,
  type TestUser,
} from './test-harness';

let h: Harness;
let owner: TestUser;
let admin: TestUser;
let member: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let team: string;

beforeAll(async () => {
  h = await createHarness();
  [owner, admin, member, viewer, outsider] = await Promise.all([
    h.signUp('owner'),
    h.signUp('admin'),
    h.signUp('member'),
    h.signUp('viewer'),
    h.signUp('outsider'),
  ]);
  team = await h.teamWorkspace(owner, [
    [admin, 'admin'],
    [member, 'member'],
    [viewer, 'viewer'],
  ]);
  await h.db.update(user).set({ name: 'Olive Owner' }).where(eq(user.id, owner.id));
}, 60_000);

afterAll(async () => {
  await h?.close();
});

const TOKEN = /^[A-Za-z0-9_-]+$/;

async function created(as: TestUser, body: Record<string, unknown>): Promise<DocumentDetail> {
  const res = await call<DocumentDetail>(h.api.documents.POST, 'POST', '/api/documents', {
    as,
    body: { workspaceId: team, ...body },
  });
  expect(res.status, JSON.stringify(res.error)).toBe(201);
  return res.body;
}
const getDoc = (as: TestUser | null, id: string, opts: Partial<CallOptions> = {}) =>
  call<DocumentDetail>(h.api.document.GET, 'GET', `/api/documents/${id}`, {
    as,
    params: { id },
    ...opts,
  });
const sharing = (as: TestUser | null, id: string, opts: Partial<CallOptions> = {}) =>
  call<DocumentSharing>(h.api.documentShare.GET, 'GET', `/api/documents/${id}/share`, {
    as,
    params: { id },
    ...opts,
  });
const share = (as: TestUser | null, id: string, body: unknown, opts: Partial<CallOptions> = {}) =>
  call<DocumentSharing>(h.api.documentShare.PATCH, 'PATCH', `/api/documents/${id}/share`, {
    as,
    body,
    params: { id },
    ...opts,
  });
async function shared(as: TestUser, id: string, body: unknown): Promise<DocumentSharing> {
  const res = await share(as, id, body);
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  return res.body;
}
const tokenOf = (s: DocumentSharing) => s.sharePath!.replace('/share/', '');
const resolve = (token: string) => loadSharedDocument(h.db, token);

const content = (text: string) => ({
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Summary' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text },
        { type: 'mention', attrs: { id: 'member-user-id', label: 'Mia' } },
      ],
    },
  ],
});

describe('share settings: authorization', () => {
  it('anonymous requests get 401', async () => {
    const doc = await created(owner, {});
    expect((await sharing(null, doc.id)).status).toBe(401);
    expect((await share(null, doc.id, { visibility: 'link' })).status).toBe(401);
  });

  it('deny: others’ private docs are 404; viewers and plain members can’t change sharing', async () => {
    denies('GET /api/documents/[id]/share', 'PATCH /api/documents/[id]/share');
    const secret = await created(owner, { title: 'Secret' });
    for (const u of [admin, member, viewer, outsider]) {
      expect((await sharing(u, secret.id)).status).toBe(404);
      expect((await share(u, secret.id, { visibility: 'link' })).status).toBe(404);
    }
    const team1 = await created(owner, { visibility: 'workspace' });
    // Members and viewers can see the settings (they can read the doc) but not change them.
    const asViewer = await sharing(viewer, team1.id);
    expect(asViewer.status).toBe(200);
    expect(asViewer.body.canShare).toBe(false);
    expect((await share(viewer, team1.id, { visibility: 'link' })).status).toBe(403);
    expect((await sharing(member, team1.id)).body.canShare).toBe(false);
    expect((await share(member, team1.id, { visibility: 'private' })).status).toBe(403);
    expect((await sharing(outsider, team1.id)).status).toBe(404);
    expect((await share(outsider, team1.id, { visibility: 'private' })).status).toBe(404);
    // Workspace admins can (core: owner/admin for non-private docs).
    expect((await sharing(admin, team1.id)).body.canShare).toBe(true);
    expect((await shared(admin, team1.id, { visibility: 'link' })).visibility).toBe('link');
    // Members share their own documents.
    const mine = await created(member, {});
    expect((await shared(member, mine.id, { visibility: 'workspace' })).visibility).toBe(
      'workspace',
    );
  });

  it('refuses cross-site cookie writes, bad input and empty updates', async () => {
    const doc = await created(owner, {});
    const evil = await share(
      owner,
      doc.id,
      { visibility: 'link' },
      { origin: 'https://evil.example' },
    );
    expect(evil.status).toBe(403);
    expect(evil.error?.code).toBe('cross_site');
    expect((await share(owner, doc.id, {})).status).toBe(400);
    expect((await share(owner, doc.id, { visibility: 'public' })).status).toBe(400);
    expect((await share(owner, doc.id, { visibility: 'link', extra: 1 })).status).toBe(400);
    expect((await share(owner, doc.id, { rotateLink: true })).status).toBe(400); // not a link doc
  });

  it('visibility decides who reads the document', async () => {
    const doc = await created(owner, {});
    expect((await getDoc(member, doc.id)).status).toBe(404);
    await shared(owner, doc.id, { visibility: 'workspace' });
    expect((await getDoc(member, doc.id)).status).toBe(200);
    expect((await getDoc(viewer, doc.id)).status).toBe(200);
    expect((await getDoc(outsider, doc.id)).status).toBe(404);
    await shared(owner, doc.id, { visibility: 'link' });
    expect((await getDoc(member, doc.id)).status).toBe(200);
    expect((await getDoc(outsider, doc.id)).status).toBe(404); // a link is not membership
    await shared(owner, doc.id, { visibility: 'private' });
    expect((await getDoc(member, doc.id)).status).toBe(404);
  });

  it('D-18: a document in a private folder can’t be shared until moved out', async () => {
    const folderRes = await call<FolderSummary>(h.api.folders.POST, 'POST', '/api/folders', {
      as: owner,
      body: { workspaceId: team, name: 'Mine' },
    });
    const doc = await created(owner, { folderId: folderRes.body.id });
    expect(doc.visibility).toBe('private');
    const s = await sharing(owner, doc.id);
    expect(s.body).toMatchObject({ inPrivateFolder: true, canShare: true });
    for (const visibility of ['workspace', 'link']) {
      const res = await share(owner, doc.id, { visibility });
      expect(res.status).toBe(409);
      expect(res.error?.code).toBe('private_folder');
    }
    expect((await shared(owner, doc.id, { shareTranscript: true })).shareTranscript).toBe(true);
  });
});

describe('share links', () => {
  it('entering link issues a ≥128-bit base64url token; leaving clears it; re-entering rotates it', async () => {
    const doc = await created(owner, { title: 'Plan', contentJson: content('Ship it.') });
    const before = await sharing(owner, doc.id);
    expect(before.body).toMatchObject({ visibility: 'private', sharePath: null });

    const on = await shared(owner, doc.id, { visibility: 'link' });
    const first = tokenOf(on);
    expect(first).toMatch(TOKEN);
    expect(first.length).toBeGreaterThanOrEqual(MIN_SHARE_TOKEN_LENGTH);
    expect(first.length * 6).toBeGreaterThanOrEqual(128);
    // Sharing never bumps the content version (no false sync conflicts with unsynced edits).
    const versionOf = async () =>
      (await h.db.select().from(document).where(eq(document.id, doc.id)))[0]!.version;
    expect(await versionOf()).toBe(0);
    expect((await resolve(first))?.title).toBe('Plan');
    // Idempotent: setting link again keeps the token.
    const again = await shared(owner, doc.id, { visibility: 'link' });
    expect(tokenOf(again)).toBe(first);

    const off = await shared(owner, doc.id, { visibility: 'workspace' });
    expect(off.sharePath).toBeNull();
    const [row] = await h.db.select().from(document).where(eq(document.id, doc.id));
    expect(row!.shareToken).toBeNull();
    expect(await resolve(first)).toBeUndefined(); // disabled link → 404

    const reOn = await shared(owner, doc.id, { visibility: 'link' });
    const second = tokenOf(reOn);
    expect(second).not.toBe(first);
    expect(await resolve(first)).toBeUndefined(); // the old link never comes back (D-18)
    expect(await resolve(second)).toBeDefined();
  });

  it('“reset link” replaces the token; the old URL stops working', async () => {
    const doc = await created(owner, {});
    const first = tokenOf(await shared(owner, doc.id, { visibility: 'link' }));
    const rotated = await shared(owner, doc.id, { rotateLink: true });
    const second = tokenOf(rotated);
    expect(second).not.toBe(first);
    expect(await resolve(first)).toBeUndefined();
    expect(await resolve(second)).toBeDefined();
  });

  it('a trashed document’s link is dead (and sharing can’t change in the trash)', async () => {
    const doc = await created(owner, { title: 'Soon gone' });
    const token = tokenOf(await shared(owner, doc.id, { visibility: 'link' }));
    const del = await call(h.api.document.DELETE, 'DELETE', `/api/documents/${doc.id}`, {
      as: owner,
      params: { id: doc.id },
    });
    expect(del.status).toBe(200);
    expect(await resolve(token)).toBeUndefined();
    expect((await share(owner, doc.id, { visibility: 'private' })).status).toBe(403);
    expect((await sharing(owner, doc.id)).body.canShare).toBe(false);
  });

  it('unknown and malformed tokens resolve to nothing', async () => {
    expect(await resolve(newShareToken())).toBeUndefined();
    for (const bad of [
      '',
      'short',
      'a'.repeat(21),
      `${'a'.repeat(30)}!`,
      'x'.repeat(200),
      '../../etc',
    ]) {
      expect(await resolve(bad)).toBeUndefined();
    }
  });

  it('a link viewer can’t reach any API route, with or without the token', async () => {
    const doc = await created(owner, {});
    const token = tokenOf(await shared(owner, doc.id, { visibility: 'link' }));
    const withToken: Partial<CallOptions> = {
      extraHeaders: { authorization: `Bearer ${token}`, 'x-share-token': token },
    };
    const id = doc.id;
    const anon = { as: null, params: { id }, ...withToken };
    const results = await Promise.all([
      call(h.api.documents.GET, 'GET', `/api/documents?workspaceId=${team}&token=${token}`, anon),
      call(h.api.document.GET, 'GET', `/api/documents/${id}?token=${token}`, anon),
      call(h.api.document.PATCH, 'PATCH', `/api/documents/${id}`, {
        ...anon,
        body: { baseVersion: 1, title: 'x' },
      }),
      call(h.api.document.DELETE, 'DELETE', `/api/documents/${id}`, anon),
      call(h.api.documentShare.GET, 'GET', `/api/documents/${id}/share`, anon),
      call(h.api.documentShare.PATCH, 'PATCH', `/api/documents/${id}/share`, {
        ...anon,
        body: { visibility: 'private' },
      }),
      call(h.api.documentMove.POST, 'POST', `/api/documents/${id}/move`, {
        ...anon,
        body: { folderId: null },
      }),
      call(h.api.documentRestore.POST, 'POST', `/api/documents/${id}/restore`, anon),
      call(h.api.folders.GET, 'GET', `/api/folders?workspaceId=${team}`, anon),
    ]);
    expect(results.map((r) => r.status)).toEqual(results.map(() => 401));
    // A signed-in non-member holding the token gets nothing through the API either.
    expect((await getDoc(outsider, id, withToken)).status).toBe(404);
    expect((await sharing(outsider, id, withToken)).status).toBe(404);
  });
});

describe('public view (/share/[token])', () => {
  it('renders sanitised HTML, the author’s name and meeting times — and nothing else', async () => {
    const doc = await created(owner, {
      kind: 'meeting',
      title: 'Weekly sync',
      contentJson: content('We agreed <script>alert(1)</script> to ship.'),
    });
    const [m] = await h.db
      .insert(meeting)
      .values({
        documentId: doc.id,
        startedAt: new Date('2026-11-10T14:00:00Z'),
        endedAt: new Date('2026-11-10T14:45:00Z'),
      })
      .returning();
    await h.db.insert(transcriptSegment).values([
      {
        id: `${doc.id}-1`,
        meetingId: m!.id,
        source: 'mic',
        startMs: 0,
        endMs: 900,
        text: 'Hello all.',
      },
      {
        id: `${doc.id}-2`,
        meetingId: m!.id,
        source: 'system',
        startMs: 1000,
        endMs: 2000,
        text: 'Hi Olive.',
      },
      {
        id: `${doc.id}-3`,
        meetingId: m!.id,
        source: 'system',
        speakerLabel: 'Sam',
        startMs: 2500,
        endMs: 3000,
        text: 'Interim, never shown.',
        isFinal: false,
      },
    ]);
    const s = await shared(owner, doc.id, { visibility: 'link' });
    expect(s.shareTranscript).toBe(false);

    const view = await resolve(tokenOf(s));
    expect(view).toMatchObject({
      title: 'Weekly sync',
      kind: 'meeting',
      authorName: 'Olive Owner',
      meeting: {
        startedAt: new Date('2026-11-10T14:00:00Z'),
        endedAt: new Date('2026-11-10T14:45:00Z'),
      },
      transcript: null, // off by default: the transcript stays private
    });
    expect(view!.html).toContain('<h2 data-origin="me">Summary</h2>');
    expect(view!.html).toContain('We agreed &lt;script&gt;alert(1)&lt;/script&gt; to ship.');
    expect(view!.html).toContain('@Mia');
    // No identifiers or account data: document/workspace/user ids, emails, tokens.
    const serialized = JSON.stringify(view);
    for (const secret of [doc.id, team, owner.id, owner.email, 'member-user-id', tokenOf(s)]) {
      expect(serialized).not.toContain(secret);
    }
    expect(Object.keys(view!).sort()).toEqual(
      ['authorName', 'html', 'kind', 'meeting', 'title', 'transcript', 'updatedAt'].sort(),
    );
  });

  it('shows the transcript (finals only) only when the sharer turns it on', async () => {
    const doc = await created(owner, { kind: 'meeting', title: 'Call' });
    const [m] = await h.db.insert(meeting).values({ documentId: doc.id }).returning();
    await h.db.insert(transcriptSegment).values([
      {
        id: `${doc.id}-b`,
        meetingId: m!.id,
        source: 'system',
        startMs: 5000,
        endMs: 6000,
        text: 'Second.',
      },
      {
        id: `${doc.id}-a`,
        meetingId: m!.id,
        source: 'mic',
        startMs: 0,
        endMs: 900,
        text: 'First.',
      },
      {
        id: `${doc.id}-c`,
        meetingId: m!.id,
        source: 'system',
        startMs: 7000,
        endMs: 8000,
        text: 'Interim.',
        isFinal: false,
      },
    ]);
    const on = await shared(owner, doc.id, { visibility: 'link', shareTranscript: true });
    expect(on.shareTranscript).toBe(true);
    const view = await resolve(tokenOf(on));
    expect(view!.transcript).toEqual([
      { source: 'mic', speaker: 'Olive Owner', startMs: 0, text: 'First.' },
      { source: 'system', speaker: 'Others', startMs: 5000, text: 'Second.' },
    ]);
    await shared(owner, doc.id, { shareTranscript: false });
    expect((await resolve(tokenOf(on)))!.transcript).toBeNull();
  });

  it('a user without a display name is not identified (no email fallback)', async () => {
    const doc = await created(member, { title: 'Anon author' });
    const s = await shared(member, doc.id, { visibility: 'link' });
    const view = await resolve(tokenOf(s));
    expect(view!.authorName).toBeNull();
    expect(JSON.stringify(view)).not.toContain(member.email.split('@')[0]!);
  });
});
