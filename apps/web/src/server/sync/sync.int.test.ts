/**
 * Sync API (2.6, D-19) against a throwaway database and a real in-process Better Auth: push (create,
 * idempotent replays, per-row authorization and deny cases, cross-meeting id spoofing, stale versions,
 * malformed entries), pull (permissions, paging, deletes on access loss, stale cursor), and a
 * property-style run of the real desktop `LocalStore` + `SyncEngine` against these handlers through a
 * flaky transport: whatever the faults, the server ends up with exactly the client's final segments.
 */
import { findFirstWorkspaceId } from '@oat/auth';
import type {
  SyncPullResponse,
  SyncPushEntry,
  SyncPushRequest,
  SyncPushResponse,
  SyncPushResult,
} from '@oat/core';
import { document, meeting, membership, transcriptSegment } from '@oat/db';
import { LocalStore, SyncEngine, SyncTransportError } from '@oat/local-store';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { denies } from '../api/authz-markers';
import {
  BASE,
  call,
  type CallOptions,
  createHarness,
  type Harness,
  type TestUser,
} from '../api/test-harness';
import { createSyncApi, type SyncApi } from './api';

let h: Harness;
let sync: SyncApi;
let owner: TestUser;
let member: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let team: string;
let ownerOwnWs: string;
let outsiderOwnWs: string;
let counter = 0;

beforeAll(async () => {
  h = await createHarness();
  sync = createSyncApi({
    db: () => h.db,
    getSession: (headers) => h.auth.api.getSession({ headers }),
    allowedOrigins: () => ['http://localhost:3000'],
  });
  [owner, member, viewer, outsider] = await Promise.all([
    h.signUp('sync-owner'),
    h.signUp('sync-member'),
    h.signUp('sync-viewer'),
    h.signUp('sync-outsider'),
  ]);
  team = await h.teamWorkspace(owner, [
    [member, 'member'],
    [viewer, 'viewer'],
  ]);
  ownerOwnWs = (await findFirstWorkspaceId(h.db, owner.id))!;
  outsiderOwnWs = (await findFirstWorkspaceId(h.db, outsider.id))!;
}, 60_000);

afterAll(async () => {
  await h?.close();
});

const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++counter}`;

function push(as: TestUser | null, entries: unknown[], opts: Partial<CallOptions> = {}) {
  return call<SyncPushResponse>(sync.push.POST, 'POST', '/api/sync/push', {
    as,
    bearer: true,
    origin: null,
    body: { entries },
    ...opts,
  });
}

function pull(as: TestUser | null, cursor: string | null = null, limit?: number) {
  const q = new URLSearchParams();
  if (cursor) q.set('cursor', cursor);
  if (limit) q.set('limit', String(limit));
  return call<SyncPullResponse>(sync.pull.GET, 'GET', `/api/sync/pull?${q}`, {
    as,
    bearer: true,
    origin: null,
  });
}

let version = 0;
const v = () => ++version;
const EMPTY = { type: 'doc' as const, content: [{ type: 'paragraph' }] };

const docEntry = (
  id: string,
  workspaceId: string,
  patch: {
    title?: string;
    baseVersion?: number;
    kind?: 'meeting' | 'page';
    contentJson?: object;
  } = {},
): Extract<SyncPushEntry, { table: 'document'; op: 'upsert' }> => ({
  version: v(),
  op: 'upsert',
  table: 'document',
  baseVersion: patch.baseVersion ?? 0,
  row: {
    id,
    workspaceId,
    kind: patch.kind ?? 'meeting',
    title: patch.title ?? 'Standup',
    contentJson: (patch.contentJson ?? EMPTY) as { type: 'doc' },
  },
});
const meetingEntry = (id: string, documentId: string): SyncPushEntry => ({
  version: v(),
  op: 'upsert',
  table: 'meeting',
  row: {
    id,
    documentId,
    calendarEventId: null,
    startedAt: '2026-11-14T10:00:00.000Z',
    endedAt: null,
    platform: null,
  },
});
const segEntry = (id: string, meetingId: string, text = `text of ${id}`): SyncPushEntry => ({
  version: v(),
  op: 'upsert',
  table: 'transcript_segment',
  row: { id, meetingId, source: 'mic', speakerLabel: null, startMs: 0, endMs: 1000, text },
});

/** A meeting document + meeting of `as` in `workspaceId`, pushed. */
async function meetingOf(as: TestUser, workspaceId: string) {
  const docId = uid('doc');
  const meetingId = uid('mtg');
  const res = await push(as, [docEntry(docId, workspaceId), meetingEntry(meetingId, docId)]);
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  expect(res.body.results.map((r) => r.status)).toEqual(['ok', 'ok']);
  return { docId, meetingId };
}

const statusOf = (results: SyncPushResult[], entry: SyncPushEntry) =>
  results.find((r) => r.version === entry.version)!;

const serverSegments = (meetingId: string) =>
  h.db
    .select({ id: transcriptSegment.id, text: transcriptSegment.text })
    .from(transcriptSegment)
    .where(eq(transcriptSegment.meetingId, meetingId))
    .orderBy(asc(transcriptSegment.id));

describe('push', () => {
  it('creates a meeting document, its meeting and final segments; replays are idempotent', async () => {
    const docId = uid('doc');
    const meetingId = uid('mtg');
    const batch = [
      segEntry(uid('s'), meetingId, 'second'), // children may come first: applied parents first
      docEntry(docId, ownerOwnWs, { title: '  Weekly \n sync ' }),
      meetingEntry(meetingId, docId),
      segEntry(uid('s'), meetingId, 'first'),
    ];
    const res = await push(owner, batch);
    expect(res.status).toBe(200);
    expect(res.body.results.map((r) => [r.version, r.status])).toEqual(
      batch.map((e) => [e.version, 'ok']),
    );
    const docResult = statusOf(res.body.results, batch[1]!);
    expect(docResult).toMatchObject({
      row: {
        id: docId,
        title: 'Weekly sync',
        version: 0,
        ownerId: owner.id,
        visibility: 'private',
      },
    });
    const [doc] = await h.db.select().from(document).where(eq(document.id, docId));
    expect(doc).toMatchObject({ kind: 'meeting', ownerId: owner.id, workspaceId: ownerOwnWs });
    expect((await serverSegments(meetingId)).map((s) => s.text).sort()).toEqual([
      'first',
      'second',
    ]);

    // The same batch again (a lost response): same answers, nothing duplicated, no version bump.
    const again = await push(owner, batch);
    expect(again.body.results.every((r) => r.status === 'ok')).toBe(true);
    expect(await serverSegments(meetingId)).toHaveLength(2);
    const [after] = await h.db.select().from(document).where(eq(document.id, docId));
    expect(after!.version).toBe(0);
  });

  it('segments are insert-or-replace by id; deletes are idempotent', async () => {
    const { meetingId } = await meetingOf(owner, ownerOwnWs);
    const id = uid('s');
    await push(owner, [segEntry(id, meetingId, 'draft')]);
    await push(owner, [segEntry(id, meetingId, 'final text')]);
    expect(await serverSegments(meetingId)).toEqual([{ id, text: 'final text' }]);
    const del = { version: v(), op: 'delete', table: 'transcript_segment', id };
    expect((await push(owner, [del])).body.results[0]!.status).toBe('ok');
    expect((await push(owner, [{ ...del, version: v() }])).body.results[0]!.status).toBe('ok');
    expect(await serverSegments(meetingId)).toEqual([]);
  });

  it('rejects cross-meeting id spoofing (same user and another user)', async () => {
    const a = await meetingOf(owner, ownerOwnWs);
    const b = await meetingOf(owner, ownerOwnWs);
    const c = await meetingOf(outsider, outsiderOwnWs);
    const id = uid('s');
    await push(owner, [segEntry(id, a.meetingId, 'original')]);

    const moved = segEntry(id, b.meetingId, 'hijacked');
    const res = await push(owner, [moved, segEntry(uid('s'), b.meetingId, 'fine')]);
    expect(statusOf(res.body.results, moved)).toMatchObject({
      status: 'rejected',
      code: 'invalid',
    });
    expect(res.body.results.filter((r) => r.status === 'ok')).toHaveLength(1);

    const stolen = segEntry(id, c.meetingId, 'stolen');
    const res2 = await push(outsider, [stolen]);
    expect(statusOf(res2.body.results, stolen)).toMatchObject({ status: 'rejected' });
    expect(await serverSegments(a.meetingId)).toEqual([{ id, text: 'original' }]);
    expect(await serverSegments(c.meetingId)).toEqual([]);

    // A meeting can't be re-pointed at another document either.
    const repoint = meetingEntry(a.meetingId, b.docId);
    expect(statusOf((await push(owner, [repoint])).body.results, repoint)).toMatchObject({
      status: 'rejected',
      code: 'invalid',
    });
  });

  it('per-row authorization: no access → rejected, nothing written', async () => {
    denies('POST /api/sync/push');
    const mine = await meetingOf(owner, ownerOwnWs);
    // Outsider: someone else's (private) meeting doesn't exist for them.
    const intrude = segEntry(uid('s'), mine.meetingId, 'intruder');
    const editDoc = docEntry(mine.docId, ownerOwnWs, { title: 'pwned' });
    const intoOwnWs = docEntry(uid('doc'), ownerOwnWs);
    const intoTeam = docEntry(uid('doc'), team);
    const r1 = (await push(outsider, [intrude, editDoc, intoOwnWs, intoTeam])).body.results;
    for (const e of [intrude, editDoc, intoOwnWs, intoTeam]) {
      expect(statusOf(r1, e), JSON.stringify(e)).toMatchObject({
        status: 'rejected',
        code: 'not_found',
      });
    }
    // Member: can't write into the owner's private meeting in the team workspace either.
    const teamMeeting = await meetingOf(owner, team);
    const memberSeg = segEntry(uid('s'), teamMeeting.meetingId, 'member');
    expect(statusOf((await push(member, [memberSeg])).body.results, memberSeg)).toMatchObject({
      status: 'rejected',
      code: 'not_found',
    });
    // Viewer: may not create in the team workspace, nor edit a shared meeting.
    await h.db
      .update(document)
      .set({ visibility: 'workspace' })
      .where(eq(document.id, teamMeeting.docId));
    const viewerDoc = docEntry(uid('doc'), team);
    const viewerSeg = segEntry(uid('s'), teamMeeting.meetingId, 'viewer');
    const r2 = (await push(viewer, [viewerDoc, viewerSeg])).body.results;
    expect(statusOf(r2, viewerDoc)).toMatchObject({ status: 'rejected', code: 'forbidden' });
    expect(statusOf(r2, viewerSeg)).toMatchObject({ status: 'rejected', code: 'forbidden' });
    // …while a member may add to the shared meeting.
    const memberShared = segEntry(uid('s'), teamMeeting.meetingId, 'member ok');
    expect(statusOf((await push(member, [memberShared])).body.results, memberShared).status).toBe(
      'ok',
    );
    expect((await serverSegments(mine.meetingId)).length).toBe(0);
    const [ownerDoc] = await h.db.select().from(document).where(eq(document.id, mine.docId));
    expect(ownerDoc!.title).toBe('Standup');
    // Deleting someone else's segment is refused too.
    const [target] = await serverSegments(teamMeeting.meetingId);
    const del = { version: v(), op: 'delete', table: 'transcript_segment', id: target!.id };
    expect((await push(outsider, [del])).body.results[0]).toMatchObject({ status: 'rejected' });
    expect(await serverSegments(teamMeeting.meetingId)).toHaveLength(1);
  });

  it('3.9: a meeting note recorded into a team workspace — members may, viewers may not (nor once demoted)', async () => {
    denies('POST /api/sync/push');
    const writer = await h.signUp('sync-39-writer');
    const watcher = await h.signUp('sync-39-viewer');
    const ws = await h.teamWorkspace(owner, [
      [writer, 'member'],
      [watcher, 'viewer'],
    ]);
    // A member's desktop recording: document + meeting + segment, private and theirs, in the team workspace.
    const ok = await meetingOf(writer, ws);
    const okSeg = segEntry(uid('s'), ok.meetingId, 'recorded in the team');
    expect(statusOf((await push(writer, [okSeg])).body.results, okSeg).status).toBe('ok');
    const [created] = await h.db.select().from(document).where(eq(document.id, ok.docId));
    expect(created).toMatchObject({ workspaceId: ws, ownerId: writer.id, visibility: 'private' });

    // A viewer's desktop can't create there: the document, and the meeting/segment under it, are refused.
    const vDoc = docEntry(uid('doc'), ws);
    const vMeeting = meetingEntry(uid('mtg'), vDoc.row.id);
    const vSeg = segEntry(uid('s'), (vMeeting as { row: { id: string } }).row.id, 'viewer words');
    const r = (await push(watcher, [vDoc, vMeeting, vSeg])).body.results;
    expect(statusOf(r, vDoc)).toMatchObject({ status: 'rejected', code: 'forbidden' });
    expect(statusOf(r, vMeeting).status).toBe('rejected');
    expect(statusOf(r, vSeg).status).toBe('rejected');
    expect(await h.db.select().from(document).where(eq(document.id, vDoc.row.id))).toEqual([]);

    // Demoted to viewer: new notes there are refused, and so are more words for the earlier one.
    await h.db
      .update(membership)
      .set({ role: 'viewer' })
      .where(and(eq(membership.workspaceId, ws), eq(membership.userId, writer.id)));
    const late = docEntry(uid('doc'), ws);
    const lateSeg = segEntry(uid('s'), ok.meetingId, 'after demotion');
    const r2 = (await push(writer, [late, lateSeg])).body.results;
    expect(statusOf(r2, late)).toMatchObject({ status: 'rejected', code: 'forbidden' });
    expect(statusOf(r2, lateSeg)).toMatchObject({ status: 'rejected', code: 'forbidden' });
  });

  it('anonymous → 401; cookie writes need our origin', async () => {
    expect((await push(null, [segEntry('x', 'y')], { origin: BASE })).status).toBe(401);
    const res = await push(owner, [segEntry('x', 'y')], {
      bearer: false,
      origin: 'https://evil.example',
    });
    expect(res.status).toBe(403);
    expect((await pull(null)).status).toBe(401);
  });

  it('stale base version: conflict with the server copy unless the text is the same', async () => {
    const { docId } = await meetingOf(owner, ownerOwnWs);
    const first = docEntry(docId, ownerOwnWs, { title: 'v1', baseVersion: 0 });
    expect(statusOf((await push(owner, [first])).body.results, first)).toMatchObject({
      status: 'ok',
      row: { version: 1, title: 'v1' },
    });
    // Replaying the same edit on the old base is recognised as applied.
    const replay = docEntry(docId, ownerOwnWs, { title: 'v1', baseVersion: 0 });
    expect(statusOf((await push(owner, [replay])).body.results, replay)).toMatchObject({
      status: 'ok',
      row: { version: 1 },
    });
    // A different edit on the old base conflicts.
    const stale = docEntry(docId, ownerOwnWs, { title: 'other', baseVersion: 0 });
    expect(statusOf((await push(owner, [stale])).body.results, stale)).toMatchObject({
      status: 'conflict',
      row: { id: docId, version: 1, title: 'v1' },
    });
    // Content goes through the editor schema (block ids assigned).
    const content = docEntry(docId, ownerOwnWs, {
      title: 'v1',
      baseVersion: 1,
      contentJson: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }],
      },
    });
    const r = statusOf((await push(owner, [content])).body.results, content);
    expect(r).toMatchObject({ status: 'ok', row: { version: 2 } });
    const block = r.status === 'ok' ? r.row!.contentJson.content : undefined;
    expect((block as { attrs: { id: string } }[])[0]!.attrs.id).toEqual(expect.any(String));
  });

  it('malformed or unsupported entries are rejected one by one', async () => {
    const { docId, meetingId } = await meetingOf(owner, ownerOwnWs);
    const good = segEntry(uid('s'), meetingId, 'good');
    const entries = [
      { version: v(), op: 'upsert', table: 'transcript_segment', row: { id: 'x' } },
      { version: v(), op: 'upsert', table: 'workspace', row: { id: 'w' } },
      // (3.5: deleting an unknown document is ok — conflicted copies are deleted by sync.)
      { version: v(), op: 'delete', table: 'meeting', id: uid('mtg') },
      docEntry(uid('doc'), ownerOwnWs, {
        contentJson: { type: 'doc', content: [{ type: 'iframe' }] },
      }),
      docEntry(docId, team), // can't move workspaces
      // Server-owned fields can't ride along (strict rows).
      {
        ...docEntry(uid('doc'), ownerOwnWs),
        row: { ...docEntry('x', ownerOwnWs).row, ownerId: member.id },
      },
      {
        ...docEntry(uid('doc'), ownerOwnWs),
        row: { ...docEntry('y', ownerOwnWs).row, visibility: 'link' },
      },
      {
        ...docEntry(uid('doc'), ownerOwnWs),
        row: { ...docEntry('z', ownerOwnWs).row, version: 9 },
      },
      good,
    ];
    const res = await push(owner, entries);
    expect(res.status).toBe(200);
    expect(res.body.results.map((r) => (r.status === 'rejected' ? r.code : r.status))).toEqual([
      'invalid',
      'invalid',
      'unsupported',
      'invalid',
      'invalid',
      'invalid',
      'invalid',
      'invalid',
      'ok',
    ]);
    expect((await push(owner, [])).status).toBe(400);
    const tooMany = Array.from({ length: 501 }, () => segEntry(uid('s'), meetingId));
    expect((await push(owner, tooMany)).status).toBe(400);
  });

  it('500 segments in one push', async () => {
    const { meetingId } = await meetingOf(owner, ownerOwnWs);
    const entries = Array.from({ length: 500 }, (_, i) => segEntry(uid('s'), meetingId, `t${i}`));
    const started = Date.now();
    const res = await push(owner, entries);
    expect(res.body.results.every((r) => r.status === 'ok')).toBe(true);
    expect(await serverSegments(meetingId)).toHaveLength(500);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

/**
 * Pulls pages (accumulating, following the cursor) until `done(changes so far)` or a timeout. The change
 * log only shows transactions older than the oldest one still running anywhere on the (shared) Postgres
 * (D-22), so under parallel test load fresh writes can take a moment to become visible.
 */
async function pullUntil(
  as: TestUser,
  from: string | null,
  done: (changes: SyncPullResponse['changes']) => boolean,
  limit?: number,
): Promise<{
  changes: SyncPullResponse['changes'];
  cursor: string | null;
  workspaceIds: string[];
}> {
  const changes: SyncPullResponse['changes'] = [];
  let cursor = from;
  let workspaceIds: string[];
  const deadline = Date.now() + 20_000;
  for (;;) {
    const res = await pull(as, cursor, limit);
    expect(res.status).toBe(200);
    workspaceIds = res.body.workspaceIds;
    changes.push(...res.body.changes);
    cursor = res.body.cursor;
    if (res.body.hasMore) continue;
    if (done(changes) || Date.now() > deadline) return { changes, cursor, workspaceIds };
    await new Promise((r) => setTimeout(r, 100));
  }
}

const idOf = (c: SyncPullResponse['changes'][number]) => (c.op === 'upsert' ? c.row.id : c.id);

describe('pull', () => {
  it('returns what the user can read, pages with the cursor, and nothing more after', async () => {
    denies('GET /api/sync/pull');
    const a = await h.signUp('pull-a');
    const b = await h.signUp('pull-b');
    const aOwnWs = (await findFirstWorkspaceId(h.db, a.id))!;
    const bOwnWs = (await findFirstWorkspaceId(h.db, b.id))!;
    const mine = await meetingOf(a, aOwnWs);
    const seg1Id = uid('s');
    const seg1 = segEntry(seg1Id, mine.meetingId, 'hello');
    await push(a, [seg1, segEntry(uid('s'), mine.meetingId, 'world')]);
    const theirs = await meetingOf(b, bOwnWs);
    await push(b, [segEntry(uid('s'), theirs.meetingId, 'secret')]);

    const first = await pullUntil(
      a,
      null,
      (cs) => cs.filter((c) => c.table === 'transcript_segment').length >= 2,
      2,
    );
    const all = first.changes;
    const cursor = first.cursor;
    expect(first.workspaceIds).toEqual([aOwnWs]);
    const ids = all.map(idOf);
    expect(ids).toEqual(expect.arrayContaining([aOwnWs, mine.docId, mine.meetingId]));
    expect(all.filter((c) => c.table === 'transcript_segment').map((c) => c.op)).toEqual([
      'upsert',
      'upsert',
    ]);
    expect(JSON.stringify(all)).not.toContain('secret');
    expect(ids).not.toContain(theirs.docId);
    // Caught up: an empty page with the same cursor.
    const empty = await pull(a, cursor);
    expect(empty.body).toMatchObject({ changes: [], cursor, hasMore: false });

    // A retraction shows up as a delete.
    await push(a, [{ version: v(), op: 'delete', table: 'transcript_segment', id: seg1Id }]);
    const next = await pullUntil(a, cursor, (cs) => cs.length > 0);
    expect(next.changes).toEqual([{ op: 'delete', table: 'transcript_segment', id: seg1Id }]);
  });

  it('access loss becomes deletes (document made private by its owner)', async () => {
    const shared = await meetingOf(owner, team);
    await h.db
      .update(document)
      .set({ visibility: 'workspace' })
      .where(eq(document.id, shared.docId));
    await push(owner, [segEntry(uid('s'), shared.meetingId, 'shared words')]);
    const before = await pullUntil(member, null, (cs) =>
      cs.some((c) => c.op === 'upsert' && c.row.id === shared.docId),
    );
    expect(before.changes.some((c) => c.op === 'upsert' && c.row.id === shared.docId)).toBe(true);
    await h.db.update(document).set({ visibility: 'private' }).where(eq(document.id, shared.docId));
    const after = await pullUntil(member, before.cursor, (cs) =>
      cs.some((c) => idOf(c) === shared.docId),
    );
    expect(after.changes).toContainEqual({
      op: 'delete',
      table: 'document',
      id: shared.docId,
    });
  });

  it('3.9: workspace rows carry my role; a change to my membership re-sends the row', async () => {
    const m = await h.signUp('pull-39-member');
    const ws = await h.teamWorkspace(owner, [[m, 'member']]);
    const role = (changes: SyncPullResponse['changes']) =>
      changes.flatMap((c) =>
        c.op === 'upsert' && c.table === 'workspace' && c.row.id === ws ? [c.row.role] : [],
      );
    const first = await pullUntil(m, null, (cs) => role(cs).length > 0);
    expect(role(first.changes).at(-1)).toBe('member');
    // …and the workspace made for them at sign-up, as its owner. No row says what kind it is (D-36).
    const mOwn = await findFirstWorkspaceId(h.db, m.id);
    const own = first.changes.find(
      (c) => c.op === 'upsert' && c.table === 'workspace' && c.row.id === mOwn,
    );
    expect(own).toMatchObject({ row: { role: 'owner' } });
    expect(own && 'row' in own ? Object.keys(own.row).sort() : []).toEqual(['id', 'name', 'role']);
    // The owner sees their own role in the same workspace.
    const mine = await pullUntil(owner, null, (cs) => role(cs).length > 0);
    expect(role(mine.changes).at(-1)).toBe('owner');

    await h.db
      .update(membership)
      .set({ role: 'viewer' })
      .where(and(eq(membership.workspaceId, ws), eq(membership.userId, m.id)));
    const next = await pullUntil(m, first.cursor, (cs) => role(cs).length > 0);
    expect(role(next.changes)).toEqual(['viewer']);
  });

  it('an unusable cursor is 409 stale_cursor; a malformed limit is 400', async () => {
    const res = await pull(owner, 'not-a-cursor');
    expect(res.status).toBe(409);
    expect(res.error?.code).toBe('stale_cursor');
    expect((await pull(owner, null, 0)).status).toBe(200); // 0 = default (not sent)
    const bad = await call(sync.pull.GET, 'GET', '/api/sync/pull?limit=9999', {
      as: owner,
      bearer: true,
    });
    expect(bad.status).toBe(400);
  });
});

describe('local store + engine against the real API', () => {
  function engineFor(user: TestUser) {
    const store = new LocalStore({ path: ':memory:', log: { warn: () => {}, error: () => {} } });
    const engine = new SyncEngine({
      store,
      setTimer: () => () => {},
      transport: {
        push: async (req: SyncPushRequest) => {
          const res = await push(user, req.entries);
          if (res.status !== 200) throw new SyncTransportError(res.status, `HTTP ${res.status}`);
          return res.body;
        },
        pull: async (cursor) => {
          const res = await pull(user, cursor);
          if (res.status !== 200) throw new SyncTransportError(res.status, `HTTP ${res.status}`);
          return res.body;
        },
      },
    });
    engine.start();
    return { store, engine };
  }

  it('segments refused while the note is in the trash are parked, then synced once it is restored', async () => {
    const user = await h.signUp('trash');
    const { store, engine } = engineFor(user);
    const deadline = Date.now() + 20_000;
    while (!store.firstWorkspaceId() && Date.now() < deadline) await engine.syncNow();
    const meetingId = uid('mtg');
    const documentId = uid('doc');
    store.createMeeting({
      meetingId,
      documentId,
      workspaceId: store.firstWorkspaceId()!,
      ownerId: user.id,
      title: 'Trash me',
      startedAt: new Date().toISOString(),
    });
    store.saveSegment({
      id: uid('s'),
      meetingId,
      source: 'mic',
      speakerLabel: null,
      startMs: 0,
      endMs: 10,
      text: 'before',
    });
    expect(await engine.syncNow()).toMatchObject({ pending: 0, parked: 0 });

    // The note goes to the trash (web); the desktop keeps transcribing.
    const trashed = await call(h.api.document.DELETE, 'DELETE', `/api/documents/${documentId}`, {
      as: user,
      params: { id: documentId },
    });
    expect(trashed.status).toBe(200);
    const late = uid('s');
    store.saveSegment({
      id: late,
      meetingId,
      source: 'system',
      speakerLabel: null,
      startMs: 20,
      endMs: 30,
      text: 'during trash',
    });
    expect(await engine.syncNow()).toMatchObject({ state: 'idle', pending: 0, parked: 1 });
    expect((await serverSegments(meetingId)).map((x) => x.text)).toEqual(['before']);

    // Restored: the pull sees the note's new version and the parked segment goes through.
    const restored = await call(
      h.api.documentRestore.POST,
      'POST',
      `/api/documents/${documentId}/restore`,
      {
        as: user,
        params: { id: documentId },
      },
    );
    expect(restored.status).toBe(200);
    let status = await engine.syncNow();
    for (let i = 0; i < 40 && status.parked + status.pending > 0; i++) {
      await new Promise((r) => setTimeout(r, 100)); // change-log visibility (see `pullUntil`)
      status = await engine.syncNow();
    }
    expect(status).toMatchObject({ pending: 0, parked: 0 });
    expect((await serverSegments(meetingId)).map((x) => x.text).sort()).toEqual([
      'before',
      'during trash',
    ]);
    engine.stop();
    store.close();
  });
});

describe('property: local store + engine against the real API', () => {
  it('random local writes and network faults converge to the same final segments, no duplicates', async () => {
    const user = await h.signUp('prop');
    const seen: Record<string, number> = {};
    for (let round = 0; round < 6; round++) {
      let seed = 7 + round * 31;
      const rand = () => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        return seed / 2 ** 31;
      };
      type Fault = 'none' | 'offline' | 'lost' | 'server';
      const faults: Fault[] = ['none', 'none', 'offline', 'lost', 'server'];
      let faulty = true;
      const fault = () => (faulty ? faults[Math.floor(rand() * faults.length)]! : 'none');
      const through = async <T>(send: () => Promise<{ status: number; body: T }>): Promise<T> => {
        const f = fault();
        seen[f] = (seen[f] ?? 0) + 1;
        if (f === 'offline') throw new SyncTransportError(0, 'offline');
        if (f === 'server') throw new SyncTransportError(503, 'busy');
        const res = await send();
        if (res.status !== 200) throw new SyncTransportError(res.status, `HTTP ${res.status}`);
        if (f === 'lost') throw new SyncTransportError(0, 'response lost');
        return res.body;
      };
      const store = new LocalStore({ path: ':memory:', log: { warn: () => {}, error: () => {} } });
      const engine = new SyncEngine({
        store,
        random: rand,
        setTimer: () => () => {},
        pushBatchSize: 9,
        transport: {
          push: (req: SyncPushRequest) => through(() => push(user, req.entries)),
          pull: (cursor) => through(() => pull(user, cursor, 25)),
        },
      });
      engine.start();
      // The first pull may need a moment (change-log visibility, see `pullUntil`) and faults are on.
      const deadline = Date.now() + 20_000;
      while (!store.firstWorkspaceId() && Date.now() < deadline) {
        await engine.syncNow();
        await new Promise((r) => setTimeout(r, 50));
      }
      const workspaceId = store.firstWorkspaceId()!;
      const meetingId = uid('mtg');
      store.createMeeting({
        meetingId,
        documentId: uid('doc'),
        workspaceId,
        ownerId: user.id,
        title: 'Prop',
        startedAt: new Date().toISOString(),
      });
      let n = 0;
      for (let step = 0; step < 40; step++) {
        const r = rand();
        const ids = store.segments(meetingId).map((s) => s.id);
        if (r < 0.55 || ids.length === 0) {
          store.saveSegment({
            id: `${meetingId}-s${n++}`,
            meetingId,
            source: rand() < 0.5 ? 'mic' : 'system',
            speakerLabel: null,
            startMs: step * 1000,
            endMs: step * 1000 + 900,
            text: `words ${step}`,
          });
        } else if (r < 0.7) {
          const s = store.segments(meetingId)[Math.floor(rand() * ids.length)]!;
          store.saveSegment({ ...s, text: `${s.text} (edited ${step})` });
        } else if (r < 0.78) {
          store.deleteSegment(ids[Math.floor(rand() * ids.length)]!);
        } else {
          await engine.syncNow();
        }
      }
      faulty = false;
      for (let i = 0; i < 5 && store.outboxSize() > 0; i++) await engine.syncNow();
      expect(store.outboxSize(), `round ${round}`).toBe(0);

      const local = store
        .segments(meetingId)
        .map((s) => ({ id: s.id, text: s.text }))
        .sort((x, y) => x.id.localeCompare(y.id));
      expect(await serverSegments(meetingId), `round ${round}`).toEqual(local);
      const [dupes] = await h.db.execute<{ n: number }>(
        sql`select count(*)::int - count(distinct (start_ms, source, text))::int as n
            from transcript_segment where meeting_id = ${meetingId}`,
      );
      expect(dupes!.n, `round ${round}: duplicate segments`).toBe(0);
      const [m] = await h.db.select().from(meeting).where(eq(meeting.id, meetingId));
      expect(m).toBeDefined();
      engine.stop();
      store.close();
    }
    // Every kind of fault actually happened along the way.
    expect(Object.keys(seen).sort()).toEqual(['lost', 'none', 'offline', 'server']);
  }, 120_000);
});
