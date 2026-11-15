/**
 * Sync 3.5 against a throwaway database and real in-process Better Auth: push receipts (lost acks never
 * conflict), conflicted copies (device name, linking rules, sync delete → trash, compare/resolve API and
 * its deny cases), subtree backfill (share a meeting note → a teammate's desktop gets the transcript),
 * the SSE invalidation channel (authz, replay, membership), the `lagging` pull hint, and a multi-device
 * property run (two real `LocalStore` + `SyncEngine` desktops and web edits through the documents API,
 * with network faults) that must converge with conflicted copies only for real concurrent edits.
 */
import { createMemoryRateLimiter, findPersonalWorkspaceId } from '@oat/auth';
import {
  documentContentKey,
  type SyncBackfillResponse,
  type SyncEvent,
  type SyncPullResponse,
  type SyncPushEntry,
  type SyncPushRequest,
  type SyncPushResponse,
} from '@oat/core';
import { document, membership, session } from '@oat/db';
import { LocalStore, SyncEngine, SyncTransportError } from '@oat/local-store';
import { waitFor } from '@oat/testkit';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DocumentDetail } from '@/lib/api-types';

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
import type { ConflictDetail } from './conflicts';

let h: Harness;
let sync: SyncApi;
let owner: TestUser;
let member: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let team: string;
let ownerPersonal: string;
let counter = 0;

beforeAll(async () => {
  h = await createHarness();
  sync = createSyncApi(
    {
      db: () => h.db,
      getSession: (headers) => h.auth.api.getSession({ headers }),
      allowedOrigins: () => [BASE],
    },
    { events: { pollMs: 50, membershipEveryMs: 200 } },
  );
  [owner, member, viewer, outsider] = await Promise.all([
    h.signUp('s35-owner'),
    h.signUp('s35-member'),
    h.signUp('s35-viewer'),
    h.signUp('s35-outsider'),
  ]);
  team = await h.teamWorkspace(owner, [
    [member, 'member'],
    [viewer, 'viewer'],
  ]);
  ownerPersonal = (await findPersonalWorkspaceId(h.db, owner.id))!;
}, 60_000);

afterAll(async () => {
  await h?.close();
});

const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++counter}`;
let version = 0;
const v = () => ++version;
const body = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const textOf = (d: { contentJson: unknown }) =>
  ((d.contentJson as ReturnType<typeof body>).content?.[0]?.content?.[0]?.text as string) ?? '';

function push(as: TestUser | null, entries: unknown[], device?: { name: string }) {
  return call<SyncPushResponse>(sync.push.POST, 'POST', '/api/sync/push', {
    as,
    bearer: true,
    origin: null,
    body: { entries, ...(device ? { device } : {}) },
  });
}

function pull(as: TestUser, cursor: string | null = null, limit?: number) {
  const q = new URLSearchParams();
  if (cursor) q.set('cursor', cursor);
  if (limit) q.set('limit', String(limit));
  return call<SyncPullResponse>(sync.pull.GET, 'GET', `/api/sync/pull?${q}`, {
    as,
    bearer: true,
    origin: null,
  });
}

function backfill(as: TestUser | null, documentId: string, after?: string, limit?: number) {
  const q = new URLSearchParams({ document: documentId });
  if (after) q.set('after', after);
  if (limit) q.set('limit', String(limit));
  return call<SyncBackfillResponse>(sync.backfill.GET, 'GET', `/api/sync/backfill?${q}`, {
    as,
    bearer: true,
    origin: null,
  });
}

const conflictCall = (
  method: 'GET' | 'POST',
  as: TestUser | null,
  id: string,
  extra: Partial<CallOptions> = {},
) =>
  call<ConflictDetail>(sync.conflict[method], method, `/api/sync/conflicts/${id}`, {
    as,
    params: { id },
    ...extra,
  });

const docEntry = (
  id: string,
  workspaceId: string,
  text: string,
  baseVersion: number,
  extra: { conflictOf?: string; title?: string } = {},
): SyncPushEntry => ({
  version: v(),
  op: 'upsert',
  table: 'document',
  baseVersion,
  row: {
    id,
    workspaceId,
    kind: 'page',
    title: extra.title ?? 'Plan',
    contentJson: body(text),
    ...(extra.conflictOf ? { conflictOf: extra.conflictOf } : {}),
  },
});

async function serverDoc(id: string) {
  const [row] = await h.db.select().from(document).where(eq(document.id, id));
  return row!;
}

/** A web edit through the documents API, on the current version. */
async function webEdit(as: TestUser, id: string, text: string) {
  const cur = await serverDoc(id);
  const res = await call<DocumentDetail>(h.api.document.PATCH, 'PATCH', `/api/documents/${id}`, {
    as,
    params: { id },
    body: { baseVersion: cur.version, contentJson: body(text) },
  });
  expect(res.status).toBe(200);
  return res.body;
}

describe('push: receipts (lost acks) and conflicted copies', () => {
  it('a stale push of a text that already landed is ok; a different text conflicts', async () => {
    const id = uid('doc');
    expect(
      (await push(owner, [docEntry(id, ownerPersonal, 'v0', 0)])).body.results[0],
    ).toMatchObject({ status: 'ok' });
    // Edit to X on version 0; pretend the answer was lost (the client still thinks it is on 0).
    expect(
      (await push(owner, [docEntry(id, ownerPersonal, 'X', 0)])).body.results[0],
    ).toMatchObject({
      status: 'ok',
      row: { version: 1 },
    });
    await webEdit(owner, id, 'W'); // someone saw X and edited it: version 2
    // Re-sending X on base 0: X landed before → ok with the current row, not a conflict.
    const replay = (await push(owner, [docEntry(id, ownerPersonal, 'X', 0)])).body.results[0]!;
    expect(replay).toMatchObject({ status: 'ok', row: { version: 2 } });
    expect(textOf((replay as { row: { contentJson: unknown } }).row)).toBe('W');
    // A text that never landed on a stale base is a real conflict.
    expect(
      (await push(owner, [docEntry(id, ownerPersonal, 'Y', 1)])).body.results[0],
    ).toMatchObject({
      status: 'conflict',
      row: { version: 2 },
    });
    expect(textOf(await serverDoc(id))).toBe('W');
  });

  it('a copy is linked to a readable original and stamped with the device; otherwise a plain page', async () => {
    const original = uid('doc');
    await push(owner, [docEntry(original, team, 'theirs', 0)]);
    await h.db.update(document).set({ visibility: 'workspace' }).where(eq(document.id, original));
    const copy = uid('copy');
    const res = await push(
      member,
      [docEntry(copy, team, 'mine', 0, { conflictOf: original, title: 'Plan (conflicted copy)' })],
      { name: 'Nafis’s MacBook' },
    );
    expect(res.body.results[0]).toMatchObject({
      status: 'ok',
      row: { conflictOfId: original, conflictDevice: 'Nafis’s MacBook' },
    });
    const row = await serverDoc(copy);
    expect(row).toMatchObject({
      conflictOfId: original,
      conflictDevice: 'Nafis’s MacBook',
      ownerId: member.id,
      visibility: 'private',
    });
    expect(row.conflictAt).toBeInstanceOf(Date);

    // An original the pusher can't read (owner's private page), or in another workspace: no link.
    const secret = uid('doc');
    await push(owner, [docEntry(secret, team, 'secret', 0)]);
    const c2 = uid('copy');
    await push(member, [docEntry(c2, team, 'x', 0, { conflictOf: secret })]);
    expect(await serverDoc(c2)).toMatchObject({ conflictOfId: null, conflictDevice: null });
    const c3 = uid('copy');
    await push(owner, [docEntry(c3, ownerPersonal, 'x', 0, { conflictOf: original })]);
    expect((await serverDoc(c3)).conflictOfId).toBeNull();
  });

  it('sync deletes only conflicted copies (to the trash); unknown ids are ok', async () => {
    const original = uid('doc');
    await push(owner, [docEntry(original, ownerPersonal, 'o', 0)]);
    const copy = uid('copy');
    await push(owner, [docEntry(copy, ownerPersonal, 'c', 0, { conflictOf: original })]);
    const del = (id: string, as = owner) =>
      push(as, [{ version: v(), op: 'delete', table: 'document', id }]).then(
        (r) => r.body.results[0],
      );
    expect(await del(original)).toMatchObject({ status: 'rejected', code: 'unsupported' });
    expect(await del(copy, outsider)).toMatchObject({ status: 'rejected', code: 'not_found' });
    expect(await del(copy)).toMatchObject({ status: 'ok' });
    expect((await serverDoc(copy)).deletedAt).toBeInstanceOf(Date);
    expect(await del(copy)).toMatchObject({ status: 'ok' }); // idempotent
    expect(await del(uid('never'))).toMatchObject({ status: 'ok' });
    expect((await serverDoc(original)).deletedAt).toBeNull();
  });
});

describe('conflicts API (compare + resolve)', () => {
  async function conflictPair(workspaceId: string, as = owner) {
    const original = uid('doc');
    await push(owner, [docEntry(original, workspaceId, 'theirs', 0, { title: 'Notes' })]);
    if (workspaceId === team) {
      await h.db.update(document).set({ visibility: 'workspace' }).where(eq(document.id, original));
    }
    const copy = uid('copy');
    await push(
      as,
      [
        docEntry(copy, workspaceId, 'mine', 0, {
          conflictOf: original,
          title: 'Notes (conflicted copy)',
        }),
      ],
      { name: 'Desk' },
    );
    return { original, copy };
  }

  it('GET compares both sides; keep copy writes it into the original and trashes the copy', async () => {
    const { original, copy } = await conflictPair(ownerPersonal);
    const got = await conflictCall('GET', owner, copy);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({
      copy: { id: copy, device: 'Desk', title: 'Notes (conflicted copy)' },
      original: { id: original, title: 'Notes', editable: true, deleted: false },
      canResolve: true,
    });
    const stale = await conflictCall('POST', owner, copy, {
      body: { keep: 'copy', baseVersion: got.body.original!.version + 5 },
    });
    expect(stale.status).toBe(409);
    const done = await conflictCall('POST', owner, copy, {
      body: { keep: 'copy', baseVersion: got.body.original!.version },
    });
    expect(done.status).toBe(200);
    const o = await serverDoc(original);
    expect({ title: o.title, text: textOf(o) }).toEqual({ title: 'Notes', text: 'mine' });
    expect((await serverDoc(copy)).deletedAt).toBeInstanceOf(Date);
    expect((await conflictCall('GET', owner, copy)).status).toBe(404); // resolved
  });

  it('keep original only trashes the copy', async () => {
    const { original, copy } = await conflictPair(ownerPersonal);
    const before = await serverDoc(original);
    expect((await conflictCall('POST', owner, copy, { body: { keep: 'original' } })).status).toBe(
      200,
    );
    const after = await serverDoc(original);
    expect(after.version).toBe(before.version);
    expect((await serverDoc(copy)).deletedAt).toBeInstanceOf(Date);
  });

  it('denies: other users can’t see or resolve a copy; a non-editor can’t keep the copy', async () => {
    denies('GET /api/sync/conflicts/[id]');
    denies('POST /api/sync/conflicts/[id]');
    const { copy } = await conflictPair(ownerPersonal);
    expect((await conflictCall('GET', outsider, copy)).status).toBe(404);
    expect(
      (await conflictCall('POST', outsider, copy, { body: { keep: 'original' } })).status,
    ).toBe(404);
    expect((await conflictCall('GET', null, copy)).status).toBe(401);
    // Not a copy at all.
    const page = uid('doc');
    await push(owner, [docEntry(page, ownerPersonal, 'p', 0)]);
    expect((await conflictCall('GET', owner, page)).status).toBe(404);
    // A cross-site cookie write is refused.
    expect(
      (
        await conflictCall('POST', owner, copy, {
          body: { keep: 'original' },
          origin: 'https://evil.example',
        })
      ).status,
    ).toBe(403);

    // A member demoted to viewer: may look at its copy, can't overwrite the original or drop the copy.
    const { original, copy: memberCopy } = await conflictPair(team, member);
    await h.db
      .update(membership)
      .set({ role: 'viewer' })
      .where(and(eq(membership.userId, member.id), eq(membership.workspaceId, team)));
    try {
      const got = await conflictCall('GET', member, memberCopy);
      expect(got.body.original).toMatchObject({ id: original, editable: false });
      expect(got.body.canResolve).toBe(false); // viewers can't delete either
      expect(
        (await conflictCall('POST', member, memberCopy, { body: { keep: 'copy' } })).status,
      ).toBe(403);
    } finally {
      await h.db
        .update(membership)
        .set({ role: 'member' })
        .where(and(eq(membership.userId, member.id), eq(membership.workspaceId, team)));
    }
    expect(textOf(await serverDoc(original))).toBe('theirs');
  });
});

describe('backfill', () => {
  async function privateMeetingWithTranscript(segments: number) {
    const docId = uid('doc');
    const meetingId = uid('mtg');
    const entries: SyncPushEntry[] = [
      {
        version: v(),
        op: 'upsert',
        table: 'document',
        baseVersion: 0,
        row: {
          id: docId,
          workspaceId: team,
          kind: 'meeting',
          title: 'Sync',
          contentJson: body('agenda'),
        },
      },
      {
        version: v(),
        op: 'upsert',
        table: 'meeting',
        row: {
          id: meetingId,
          documentId: docId,
          calendarEventId: null,
          startedAt: '2026-11-14T10:00:00.000Z',
          endedAt: null,
          platform: null,
        },
      },
      {
        version: v(),
        op: 'upsert',
        table: 'participant',
        row: { id: uid('p'), meetingId, name: 'Ada', email: null, source: 'manual' },
      },
      ...Array.from({ length: segments }, (_, i): SyncPushEntry => ({
        version: v(),
        op: 'upsert',
        table: 'transcript_segment',
        row: {
          id: `${meetingId}-s${String(i).padStart(2, '0')}`,
          meetingId,
          source: 'system',
          speakerLabel: null,
          startMs: i * 1000,
          endMs: i * 1000 + 900,
          text: `line ${i} quarterly`,
        },
      })),
    ];
    const res = await push(owner, entries);
    expect(res.body.results.every((r) => r.status === 'ok')).toBe(true);
    return { docId, meetingId };
  }

  const share = (id: string) =>
    call<DocumentDetail>(h.api.documentShare.PATCH, 'PATCH', `/api/documents/${id}/share`, {
      as: owner,
      params: { id },
      body: { visibility: 'workspace' },
    });

  it('returns a readable meeting’s subtree in pages; 404 while it is private (deny)', async () => {
    denies('GET /api/sync/backfill');
    const { docId, meetingId } = await privateMeetingWithTranscript(5);
    expect((await backfill(member, docId)).status).toBe(404);
    expect((await backfill(outsider, docId)).status).toBe(404);
    expect((await share(docId)).status).toBe(200);
    const first = await backfill(member, docId, undefined, 2);
    expect(first.status).toBe(200);
    expect(first.body.changes.map((c) => c.table)).toEqual([
      'meeting',
      'participant',
      'transcript_segment',
      'transcript_segment',
    ]);
    const ids: string[] = [];
    let page = first.body;
    for (;;) {
      for (const c of page.changes)
        if (c.table === 'transcript_segment' && c.op === 'upsert') ids.push(c.row.id);
      if (!page.next) break;
      page = (await backfill(member, docId, page.next, 2)).body;
      expect(page.changes.every((c) => c.table === 'transcript_segment')).toBe(true);
    }
    expect(ids).toEqual(
      Array.from({ length: 5 }, (_, i) => `${meetingId}-s${String(i).padStart(2, '0')}`),
    );
    expect((await backfill(member, docId, 'nope')).status).toBe(400);
  });

  it('share a meeting note → the teammate’s desktop (LocalStore + engine) gets the transcript', async () => {
    const store = new LocalStore({ path: ':memory:', log: { warn: () => {}, error: () => {} } });
    const engine = new SyncEngine({
      store,
      setTimer: () => () => {},
      transport: {
        push: (req: SyncPushRequest) => push(member, req.entries).then((r) => r.body),
        pull: (cursor) => pull(member, cursor).then((r) => r.body),
        backfill: async (id, after) => {
          const r = await backfill(member, id, after ?? undefined, 3);
          if (r.status !== 200) throw new SyncTransportError(r.status, 'backfill');
          return r.body;
        },
      },
    });
    engine.start();
    // Initial sync: catch up with everything already in the team workspace.
    await waitFor(
      async () => {
        await engine.syncNow();
        return store.workspaces().some((w) => w.id === team) ? true : undefined;
      },
      { timeout: 20_000, interval: 100 },
    );
    const { docId, meetingId } = await privateMeetingWithTranscript(7);
    // While private, the member's pulls carry its subtree only as deletes (nothing arrives).
    await new Promise((r) => setTimeout(r, 300));
    await engine.syncNow();
    expect(store.document(docId)).toBeUndefined();
    expect((await share(docId)).status).toBe(200);
    await waitFor(
      async () => {
        await engine.syncNow();
        return store.segments(meetingId).length === 7 ? true : undefined;
      },
      { timeout: 20_000, interval: 100 },
    );
    expect(store.meeting(meetingId)).toMatchObject({ documentId: docId });
    expect(store.participants(meetingId).map((p) => p.name)).toEqual(['Ada']);
    expect(store.backfillQueue()).toEqual([]);
    expect(store.search('quarterly').length).toBeGreaterThan(0);
    engine.stop();
    store.close();
  }, 60_000);
});

/** Opens the SSE stream as `as` and collects parsed events until `until` holds (or the timeout). */
async function sse(
  as: TestUser | null,
  until: (events: { id: string | null; event: string; data: SyncEvent }[]) => boolean,
  options: {
    lastEventId?: string;
    timeoutMs?: number;
    onOpen?: () => Promise<void>;
    api?: SyncApi;
  } = {},
) {
  const abort = new AbortController();
  const headers = new Headers();
  if (as) headers.set('authorization', `Bearer ${as.bearer}`);
  if (options.lastEventId) headers.set('last-event-id', options.lastEventId);
  const res = await (options.api ?? sync).events.GET(
    new Request(`${BASE}/api/sync/events`, { headers, signal: abort.signal }),
    { params: Promise.resolve({}) },
  );
  const events: { id: string | null; event: string; data: SyncEvent }[] = [];
  if (res.status !== 200) return { status: res.status, events };
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 10_000);
  let opened = false;
  try {
    while (!until(events)) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const fields = Object.fromEntries(
          block
            .split('\n')
            .filter((l) => l && !l.startsWith(':'))
            .map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]),
        );
        if (fields.event) {
          events.push({
            id: fields.id ?? null,
            event: fields.event,
            data: JSON.parse(fields.data ?? '{}'),
          });
        }
      }
      if (!opened && events.length > 0) {
        opened = true;
        await options.onOpen?.();
      }
    }
  } finally {
    clearTimeout(timer);
    abort.abort();
    await reader.cancel().catch(() => {});
  }
  return { status: res.status, events };
}

describe('SSE invalidation channel', () => {
  it('names readable documents of the user’s workspaces only; others see nothing of them (deny)', async () => {
    denies('GET /api/sync/events');
    const shared = uid('doc');
    const secret = uid('doc');
    await push(owner, [docEntry(shared, team, 'a', 0), docEntry(secret, team, 'b', 0)]);
    await h.db.update(document).set({ visibility: 'workspace' }).where(eq(document.id, shared));
    await waitFor(
      async () =>
        (await pull(member)).body.changes.some((c) => c.op === 'upsert' && c.row.id === shared)
          ? true
          : undefined,
      { timeout: 15_000 },
    );

    const write = async () => {
      await push(owner, [docEntry(secret, team, 'b2', 0)]).catch(() => {});
      await webEdit(owner, shared, 'a2');
    };
    const seenBy = async (who: TestUser) =>
      sse(who, (evs) => evs.some((e) => e.data.ids?.includes(shared)), {
        onOpen: write,
        timeoutMs: 8_000,
      });

    const m = await seenBy(member);
    expect(m.status).toBe(200);
    expect(m.events[0]!.event).toBe('ready');
    const ids = m.events.flatMap((e) => e.data.ids ?? []);
    expect(ids).toContain(shared);
    expect(ids).not.toContain(secret);
    expect(m.events.some((e) => e.event === 'change' && e.data.tables.includes('document'))).toBe(
      true,
    );

    const o = await sse(outsider, () => false, { onOpen: write, timeoutMs: 1_500 });
    expect(o.events.flatMap((e) => e.data.ids ?? [])).not.toContain(shared);
    expect(o.events.filter((e) => e.event === 'change')).toEqual([]);

    expect((await sse(null, () => true)).status).toBe(401);
  }, 30_000);

  it('replays from Last-Event-ID and reports a membership change', async () => {
    const doc = uid('doc');
    await push(owner, [docEntry(doc, team, 'x', 0)]);
    await h.db.update(document).set({ visibility: 'workspace' }).where(eq(document.id, doc));
    const first = await sse(member, (evs) => evs.length >= 1, { timeoutMs: 5_000 });
    const start = first.events[0]!.id!;
    expect(start).toMatch(/^\d+\.\d+$/);
    await webEdit(owner, doc, 'while away');
    // Reconnect from where we were: the missed change comes first.
    const again = await sse(member, (evs) => evs.some((e) => e.data.ids?.includes(doc)), {
      lastEventId: start,
      timeoutMs: 10_000,
    });
    expect(again.events.some((e) => e.event === 'change' && e.data.ids.includes(doc))).toBe(true);

    // Joining a workspace is announced (its history is behind every cursor: the client re-pulls).
    const other = await h.teamWorkspace(owner, []);
    const joined = await sse(member, (evs) => evs.some((e) => e.data.workspaces), {
      timeoutMs: 8_000,
      onOpen: async () => {
        await h.db
          .insert(membership)
          .values({ workspaceId: other, userId: member.id, role: 'member' });
      },
    });
    expect(joined.events.some((e) => e.data.workspaces === true)).toBe(true);
  }, 30_000);
});

describe('SSE limits, session and membership (review 3.5)', () => {
  const deps = () => ({
    db: () => h.db,
    getSession: (headers: Headers) => h.auth.api.getSession({ headers }),
    allowedOrigins: () => [BASE],
  });

  /** Opens a stream and keeps it open until `close()`. */
  async function hold(api: SyncApi, as: TestUser) {
    const abort = new AbortController();
    const res = await api.events.GET(
      new Request(`${BASE}/api/sync/events`, {
        headers: { authorization: `Bearer ${as.bearer}` },
        signal: abort.signal,
      }),
      { params: Promise.resolve({}) },
    );
    const reader = res.status === 200 ? res.body!.getReader() : null;
    if (reader) await reader.read(); // the stream is running
    return {
      status: res.status,
      retryAfter: res.headers.get('retry-after'),
      reader,
      close: async () => {
        abort.abort();
        await reader?.cancel().catch(() => {});
      },
    };
  }

  it('caps concurrent streams per user (429) and frees the slot when one closes', async () => {
    const api = createSyncApi(deps(), { maxStreamsPerUser: 2, events: { pollMs: 50 } });
    const user = await h.signUp('s35-cap');
    const a = await hold(api, user);
    const b = await hold(api, user);
    expect([a.status, b.status]).toEqual([200, 200]);
    const c = await hold(api, user);
    expect(c.status).toBe(429);
    expect(c.retryAfter).toBe('30');
    expect((await hold(api, member)).status).toBe(200); // per user
    await a.close();
    const d = await waitFor(
      async () => {
        const r = await hold(api, user);
        if (r.status === 200) return r;
        await r.close();
        return undefined;
      },
      { timeout: 5_000, interval: 50 },
    );
    await Promise.all([b.close(), d.close()]);
  });

  it('rate-limits connects per user', async () => {
    const limiter = createMemoryRateLimiter();
    const api = createSyncApi(deps(), { rateLimiter: () => limiter, connectsPerMinute: 3 });
    const user = await h.signUp('s35-rate');
    const opened = [];
    for (let i = 0; i < 3; i++) {
      const r = await hold(api, user);
      expect(r.status).toBe(200);
      await r.close();
      opened.push(r);
    }
    const over = await hold(api, user);
    expect(over.status).toBe(429);
    expect(Number(over.retryAfter)).toBeGreaterThan(0);
  });

  it('ends the stream when the session is revoked', async () => {
    const api = createSyncApi(deps(), { events: { pollMs: 50, sessionEveryMs: 100 } });
    const user = await h.signUp('s35-revoke');
    const s = await hold(api, user);
    expect(s.status).toBe(200);
    await h.db.delete(session).where(eq(session.userId, user.id));
    const ended = await waitFor(
      async () => {
        const { done } = await s.reader!.read();
        return done ? true : undefined;
      },
      { timeout: 5_000, interval: 10 },
    );
    expect(ended).toBe(true);
    await s.close();
  });

  it('announces removal from a workspace quickly and names no more of its documents', async () => {
    const api = createSyncApi(deps(), { events: { pollMs: 50, membershipEveryMs: 200 } });
    const user = await h.signUp('s35-removed');
    const ws = await h.teamWorkspace(owner, [[user, 'member']]);
    const doc = uid('doc');
    await push(owner, [docEntry(doc, ws, 'x', 0)]);
    await h.db.update(document).set({ visibility: 'workspace' }).where(eq(document.id, doc));
    const got = await sse(user, (evs) => evs.some((e) => e.data.workspaces), {
      api,
      timeoutMs: 8_000,
      onOpen: async () => {
        await h.db
          .delete(membership)
          .where(and(eq(membership.userId, user.id), eq(membership.workspaceId, ws)));
        await webEdit(owner, doc, 'after removal');
      },
    });
    expect(got.events.some((e) => e.data.workspaces === true)).toBe(true);
    expect(got.events.flatMap((e) => e.data.ids ?? [])).not.toContain(doc);
  }, 20_000);
});

describe('pull: lagging hint (D-22 xmin stall)', () => {
  it('says lagging while an older transaction holds committed changes back', async () => {
    const start = await waitFor(
      async () => {
        const r = await pull(owner);
        return r.body.lagging ? undefined : r.body;
      },
      { timeout: 15_000 },
    );
    let cursor = start.cursor;
    for (let more = start.hasMore; more;) {
      const r = (await pull(owner, cursor)).body;
      cursor = r.cursor;
      more = r.hasMore;
    }
    const blocker = await h.db.$client.reserve();
    try {
      await blocker`begin`;
      await blocker`select pg_current_xact_id()`;
      await push(owner, [docEntry(uid('doc'), ownerPersonal, 'held', 0)]);
      const during = (await pull(owner, cursor)).body;
      expect(during.changes).toEqual([]);
      expect(during.lagging).toBe(true);
      await blocker`commit`;
    } finally {
      blocker.release();
    }
    const after = await waitFor(
      async () => {
        const r = (await pull(owner, cursor)).body;
        return r.changes.length > 0 ? r : undefined;
      },
      { timeout: 15_000 },
    );
    expect(after.changes.length).toBeGreaterThan(0);
  }, 30_000);
});

describe('property: two desktops + web, network faults', () => {
  it('converges; conflicted copies only for real concurrent edits', async () => {
    const user = await h.signUp('s35-prop');
    const personal = (await findPersonalWorkspaceId(h.db, user.id))!;
    let copies = 0;
    for (let round = 0; round < 3; round++) {
      let seed = 11 + round * 97;
      const rand = () => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        return seed / 2 ** 31;
      };
      // Every text each note ever had on the server (web edits + whatever a push left there).
      const history = new Map<string, Set<string>>();
      const remember = (id: string, title: string, contentJson: unknown) => {
        const set = history.get(id) ?? new Set<string>();
        set.add(documentContentKey(title, contentJson));
        history.set(id, set);
      };
      const notes = [uid('n'), uid('n'), uid('n')];
      for (const id of notes) {
        await push(user, [docEntry(id, personal, `${id} v0`, 0)]);
        const row = await serverDoc(id);
        remember(id, row.title, row.contentJson);
      }
      let faulty = false;
      type Fault = 'none' | 'offline' | 'lost' | 'server';
      const fault = (): Fault => {
        if (!faulty) return 'none';
        const r = rand();
        return r < 0.6 ? 'none' : r < 0.8 ? 'lost' : r < 0.92 ? 'offline' : 'server';
      };
      const desktop = (name: string) => {
        const store = new LocalStore({
          path: ':memory:',
          deviceName: name,
          log: { warn: () => {}, error: () => {} },
        });
        const through = async <T>(
          send: () => Promise<{ status: number; body: T }>,
          after?: () => Promise<void>,
        ) => {
          const f = fault();
          if (f === 'offline') throw new SyncTransportError(0, 'offline');
          if (f === 'server') throw new SyncTransportError(503, 'busy');
          const res = await send();
          await after?.();
          if (res.status !== 200) throw new SyncTransportError(res.status, `HTTP ${res.status}`);
          if (f === 'lost') throw new SyncTransportError(0, 'response lost');
          return res.body;
        };
        const engine = new SyncEngine({
          store,
          random: rand,
          setTimer: () => () => {},
          serverErrorsBeforeSplit: 1_000,
          device: { name },
          transport: {
            push: (req: SyncPushRequest) =>
              through(
                () => push(user, req.entries, req.device),
                async () => {
                  for (const e of req.entries) {
                    if (e.table !== 'document' || e.op !== 'upsert') continue;
                    const row = await serverDoc(e.row.id);
                    if (row) remember(row.id, row.title, row.contentJson);
                  }
                },
              ),
            pull: (cursor) => through(() => pull(user, cursor, 50)),
          },
        });
        engine.start();
        return { name, store, engine, last: new Map<string, string>() };
      };
      const A = desktop('A');
      const B = desktop('B');
      const settle = async () => {
        for (let i = 0; i < 4; i++) for (const d of [A, B]) await d.engine.syncNow();
      };
      const converged = async () => {
        const rows = (
          await h.db.select().from(document).where(eq(document.workspaceId, personal))
        ).map((d) => ({
          id: d.id,
          title: d.title,
          text: textOf(d),
          version: d.version,
          trashed: d.deletedAt !== null,
          conflictOfId: d.conflictOfId,
        }));
        rows.sort((x, y) => x.id.localeCompare(y.id));
        for (const d of [A, B]) {
          const local = d.store
            .documents(personal)
            .map((x) => ({
              id: x.id,
              title: x.title,
              text: textOf(x),
              version: x.version,
              trashed: x.deletedAt !== null,
              conflictOfId: x.conflictOfId,
            }))
            .sort((x, y) => x.id.localeCompare(y.id));
          if (JSON.stringify(local) !== JSON.stringify(rows) || d.store.outboxSize() > 0)
            return undefined;
        }
        return rows;
      };
      await waitFor(async () => (await settle(), await converged()), {
        timeout: 30_000,
        interval: 100,
      });

      faulty = true;
      for (let step = 0; step < 30; step++) {
        const id = notes[Math.floor(rand() * notes.length)]!;
        const r = rand();
        const text = `r${round}s${step}`;
        if (r < 0.25) {
          if (A.store.updateDocument(id, { contentJson: body(text) })) A.last.set(id, text);
        } else if (r < 0.45) {
          if (B.store.updateDocument(id, { contentJson: body(text) })) B.last.set(id, text);
        } else if (r < 0.55) {
          const doc = await webEdit(user, id, text);
          remember(id, doc.title, doc.contentJson);
        } else {
          await (r < 0.8 ? A : B).engine.syncNow();
        }
      }
      faulty = false;
      const final = await waitFor(async () => (await settle(), await converged()), {
        timeout: 30_000,
        interval: 100,
      });

      for (const copy of final.filter((d) => d.conflictOfId && notes.includes(d.conflictOfId))) {
        copies += 1;
        const row = await serverDoc(copy.id);
        const key = documentContentKey(
          row.title.replace(/ \(conflicted copy\)$/, ''),
          row.contentJson,
        );
        expect(
          history.get(copy.conflictOfId!)?.has(key),
          `round ${round}: false conflict ${copy.id}`,
        ).toBe(false);
        expect(['A', 'B']).toContain(row.conflictDevice);
      }
      // Nothing typed on a desktop is lost: on the server at some point, or in that device's copy.
      for (const d of [A, B]) {
        for (const [id, text] of d.last) {
          const landed = history.get(id)?.has(documentContentKey('Plan', body(text)));
          const copied = final.some((c) => c.conflictOfId === id && c.text === text);
          expect(landed || copied, `round ${round}: ${d.name}'s ${text} lost`).toBe(true);
        }
      }
      for (const d of [A, B]) {
        d.engine.stop();
        d.store.close();
      }
    }
    expect(copies).toBeGreaterThan(0);
  }, 180_000);
});
