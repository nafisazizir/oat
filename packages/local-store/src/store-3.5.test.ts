/** 3.5 additions to the local store and engine: search, conflicted copies, backfill, lagging, notify. */
import type { SyncDocumentRow, SyncPullResponse } from '@oat/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MIGRATIONS } from './migrations.ts';
import { openDatabase } from './open.ts';
import { HIGHLIGHT_END, HIGHLIGHT_START, LocalStore, stripConflictSuffix } from './store.ts';
import { SyncEngine, SyncTransportError } from './sync-engine.ts';

const body = (...paragraphs: string[]) => ({
  type: 'doc' as const,
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
});

const row = (patch: Partial<SyncDocumentRow> = {}): SyncDocumentRow => ({
  id: 'd1',
  workspaceId: 'ws',
  folderId: null,
  ownerId: 'u1',
  kind: 'page',
  title: 'Plan',
  contentJson: body('first'),
  visibility: 'workspace',
  version: 1,
  createdAt: '2026-11-14T10:00:00.000Z',
  updatedAt: '2026-11-14T10:00:00.000Z',
  deletedAt: null,
  conflictOfId: null,
  conflictDevice: null,
  conflictAt: null,
  ...patch,
});

const page = (
  changes: SyncPullResponse['changes'],
  cursor = 'c',
  hasMore = false,
): SyncPullResponse => ({
  changes: [
    { op: 'upsert', table: 'workspace', row: { id: 'ws', name: 'W', kind: 'team' } },
    ...changes,
  ],
  cursor,
  hasMore,
  workspaceIds: ['ws'],
});

let store: LocalStore;
beforeEach(() => {
  store = new LocalStore({
    path: ':memory:',
    deviceName: 'Test Mac',
    log: { warn: () => {}, error: () => {} },
  });
});
afterEach(() => store.close());

describe('search (FTS5 trigram)', () => {
  beforeEach(() => {
    store.applyPull(
      page([
        {
          op: 'upsert',
          table: 'document',
          row: row({
            id: 'p1',
            title: 'Budget review',
            contentJson: body('Café latte numbers', 'Q3 forecast'),
          }),
        },
        {
          op: 'upsert',
          table: 'document',
          row: row({ id: 'm1', kind: 'meeting', title: 'Standup', contentJson: body('notes') }),
        },
        {
          op: 'upsert',
          table: 'meeting',
          row: {
            id: 'mt1',
            documentId: 'm1',
            calendarEventId: null,
            startedAt: null,
            endedAt: null,
            platform: null,
            templateId: null,
          },
        },
        {
          op: 'upsert',
          table: 'transcript_segment',
          row: {
            id: 's1',
            meetingId: 'mt1',
            source: 'system',
            speakerLabel: null,
            startMs: 61_000,
            endMs: 64_000,
            text: 'we should revisit the forecast next week',
          },
        },
        {
          op: 'upsert',
          table: 'document',
          row: row({ id: 'gone', title: 'Old forecast', deletedAt: '2026-11-14T11:00:00.000Z' }),
        },
      ]),
      null,
    );
  });

  it('finds notes by title and body, and transcript segments, case/accent-insensitive substrings', () => {
    expect(store.search('budget').map((h) => h.documentId)).toEqual(['p1']);
    expect(store.search('CAFE').map((h) => [h.documentId, h.in])).toEqual([['p1', 'note']]);
    const hits = store.search('forecast');
    expect(hits.map((h) => [h.documentId, h.in]).sort()).toEqual([
      ['m1', 'transcript'],
      ['p1', 'note'],
    ]);
    const seg = hits.find((h) => h.in === 'transcript')!;
    expect(seg).toMatchObject({
      segmentId: 's1',
      startMs: 61_000,
      title: 'Standup',
      kind: 'meeting',
    });
    expect(seg.snippet).toContain(`${HIGHLIGHT_START}forecast${HIGHLIGHT_END}`);
    expect(store.search('orecas').length).toBe(2); // substring
    expect(store.search('forecast numbers').map((h) => h.documentId)).toEqual(['p1']); // all words
  });

  it('ignores words under 3 characters, quotes, trashed notes; follows edits and deletes', () => {
    expect(store.search('q3')).toEqual([]);
    expect(store.search('"forecast"').length).toBe(2);
    expect(store.search('old').map((h) => h.documentId)).toEqual([]); // only in the trashed note
    store.updateDocument('p1', { title: 'Hiring plan', contentJson: body('interviews') });
    expect(store.search('budget')).toEqual([]);
    expect(store.search('interview').map((h) => h.documentId)).toEqual(['p1']);
    store.deleteSegment('s1');
    expect(store.search('revisit')).toEqual([]);
  });

  it('migration 2 indexes rows written before it', () => {
    const { db } = openDatabase(':memory:', undefined, MIGRATIONS.slice(0, 1));
    db.exec(`INSERT INTO workspace VALUES ('ws', 'W', 'team');
      INSERT INTO document (id, workspace_id, owner_id, kind, title, content_json, created_at, updated_at)
      VALUES ('x', 'ws', 'u', 'page', 'Roadmap', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"launch"}]}]}', 'a', 'a');`);
    for (const sql of MIGRATIONS.slice(1)) db.exec(sql);
    const n = (q: string) =>
      (
        db.prepare(`SELECT count(*) AS n FROM document_fts WHERE document_fts MATCH ?`).get(q) as {
          n: number;
        }
      ).n;
    expect(n('"launch"')).toBe(1);
    expect(n('"roadmap"')).toBe(1);
    db.close();
  });
});

describe('conflicted copies', () => {
  beforeEach(() => {
    store.applyPull(page([{ op: 'upsert', table: 'document', row: row() }]), null);
  });

  it('a real conflict files our text as a copy with device and time; resolving keeps either side', () => {
    store.updateDocument('d1', { contentJson: body('mine') });
    const [entry] = store.takePushBatch(10);
    const outcome = store.applyPushResults(
      [entry!],
      [
        {
          version: entry!.version,
          status: 'conflict',
          row: row({ version: 2, contentJson: body('theirs') }),
        },
      ],
    );
    expect(outcome).toMatchObject({ conflicts: 1, adopted: 0 });
    const [conflict] = store.conflicts();
    expect(conflict!.copy).toMatchObject({
      title: 'Plan (conflicted copy)',
      conflictOfId: 'd1',
      conflictDevice: 'Test Mac',
      version: 0,
    });
    expect(conflict!.copy.conflictAt).not.toBeNull();
    expect(conflict!.original).toMatchObject({ id: 'd1', version: 2, contentJson: body('theirs') });
    // The copy is pushed as a create that says what it copies.
    const [copyEntry] = store.takePushBatch(10);
    expect(copyEntry).toMatchObject({ table: 'document', row: { conflictOf: 'd1' } });

    expect(store.resolveConflict(conflict!.copy.id, 'copy')).toBe(true);
    expect(store.document('d1')).toMatchObject({
      title: 'Plan',
      contentJson: body('mine'),
      version: 2,
    });
    expect(store.document(conflict!.copy.id)).toBeUndefined();
    expect(store.conflicts()).toEqual([]);
    // Queued: the original's edit (on version 2) and the copy's delete.
    expect(store.outbox().map((e) => [e.table, e.rowId, e.op])).toEqual([
      ['document', 'd1', 'upsert'],
      ['document', conflict!.copy.id, 'delete'],
    ]);
    expect(store.resolveConflict('d1', 'copy')).toBe(false); // not a copy
  });

  it('a conflict that is our own unacknowledged write is adopted, not copied', () => {
    store.updateDocument('d1', { contentJson: body('v2 mine') });
    const [first] = store.takePushBatch(10); // sent; the answer is lost
    expect(first).toMatchObject({ baseVersion: 1 });
    store.updateDocument('d1', { contentJson: body('v3 mine') });
    const [second] = store.takePushBatch(10);
    expect(second).toMatchObject({ baseVersion: 1 });
    const outcome = store.applyPushResults(
      [second!],
      [
        {
          version: second!.version,
          status: 'conflict',
          row: row({ version: 2, contentJson: body('v2 mine') }),
        },
      ],
    );
    expect(outcome).toMatchObject({ conflicts: 0, adopted: 1, copies: [] });
    expect(store.conflicts()).toEqual([]);
    expect(store.document('d1')).toMatchObject({ version: 2, contentJson: body('v3 mine') });
    const [again] = store.takePushBatch(10);
    expect(again).toMatchObject({ baseVersion: 2, row: { contentJson: body('v3 mine') } });
    store.applyPushResults(
      [again!],
      [
        {
          version: again!.version,
          status: 'ok',
          row: row({ version: 3, contentJson: body('v3 mine') }),
        },
      ],
    );
    expect(store.outboxSize()).toBe(0);
  });

  it('strips the suffix only when present', () => {
    expect(stripConflictSuffix('A (conflicted copy)')).toBe('A');
    expect(stripConflictSuffix('A')).toBe('A');
  });
});

describe('backfill', () => {
  const meeting = {
    id: 'mt',
    documentId: 'm',
    calendarEventId: null,
    startedAt: null,
    endedAt: null,
    platform: null,
    templateId: null,
  };
  const segment = {
    id: 's',
    meetingId: 'mt',
    source: 'mic' as const,
    speakerLabel: null,
    startMs: 0,
    endMs: 1,
    text: 'hi',
  };

  it('queues meeting notes first seen after the initial pull, not during it', () => {
    store.applyPull(
      page(
        [{ op: 'upsert', table: 'document', row: row({ id: 'a', kind: 'meeting' }) }],
        'c1',
        true,
      ),
      null,
    );
    store.applyPull(
      page([{ op: 'upsert', table: 'document', row: row({ id: 'b', kind: 'meeting' }) }], 'c2'),
      'c1',
    );
    expect(store.backfillQueue()).toEqual([]);
    store.applyPull(
      page(
        [
          { op: 'upsert', table: 'document', row: row({ id: 'm', kind: 'meeting' }) },
          { op: 'upsert', table: 'document', row: row({ id: 'p', kind: 'page' }) },
          { op: 'upsert', table: 'document', row: row({ id: 'a', kind: 'meeting', version: 2 }) },
        ],
        'c3',
      ),
      'c2',
    );
    expect(store.backfillQueue()).toEqual(['m']);
    store.applyBackfill('m', {
      changes: [{ op: 'upsert', table: 'meeting', row: meeting }],
      next: 'p2',
    });
    expect(store.nextBackfill()).toEqual({ documentId: 'm', after: 'p2' });
    store.applyBackfill('m', {
      changes: [{ op: 'upsert', table: 'transcript_segment', row: segment }],
      next: null,
    });
    expect(store.backfillQueue()).toEqual([]);
    expect(store.segments('mt').map((s) => s.text)).toEqual(['hi']);
    expect(store.outboxSize()).toBe(0); // no echo
    expect(store.search('hi')).toEqual([]); // under 3 chars
  });

  it('the engine fetches queued subtrees after the pull; 404 drops the entry', async () => {
    store.applyPull(page([], 'c0'), null);
    store.applyPull(
      page([{ op: 'upsert', table: 'document', row: row({ id: 'm', kind: 'meeting' }) }], 'c1'),
      'c0',
    );
    store.queueBackfill('gone');
    const calls: [string, string | null][] = [];
    const engine = new SyncEngine({
      store,
      setTimer: () => () => {},
      transport: {
        push: async () => ({ results: [] }),
        pull: async (cursor) => ({ changes: [], cursor, hasMore: false, workspaceIds: ['ws'] }),
        backfill: async (id, after) => {
          calls.push([id, after]);
          if (id === 'gone') throw new SyncTransportError(404, 'not found');
          return after === null
            ? { changes: [{ op: 'upsert', table: 'meeting', row: meeting }], next: 'x' }
            : {
                changes: [{ op: 'upsert', table: 'transcript_segment', row: segment }],
                next: null,
              };
        },
      },
    });
    engine.start();
    await engine.syncNow();
    expect(calls).toEqual([
      ['m', null],
      ['m', 'x'],
      ['gone', null],
    ]);
    expect(store.backfillQueue()).toEqual([]);
    expect(store.segments('mt')).toHaveLength(1);
    expect(engine.status.state).toBe('idle');
  });
});

describe('backfill is best-effort (D-28)', () => {
  const meeting = {
    id: 'mt',
    documentId: 'c',
    calendarEventId: null,
    startedAt: null,
    endedAt: null,
    platform: null,
    templateId: null,
  };

  it('4xx drops the entry; 5xx strikes it and stops this run; network stops; runs never fail', async () => {
    store.applyPull(page([], 'c0'), null);
    for (const id of ['a', 'b', 'c']) {
      store.applyPull(
        page([{ op: 'upsert', table: 'document', row: row({ id, kind: 'meeting' }) }], `c-${id}`),
        'x',
      );
    }
    expect(store.backfillQueue()).toEqual(['a', 'b', 'c']);
    const calls: string[] = [];
    let network = false;
    const engine = new SyncEngine({
      store,
      setTimer: () => () => {},
      transport: {
        push: async () => ({ results: [] }),
        pull: async (cursor) => ({ changes: [], cursor, hasMore: false, workspaceIds: ['ws'] }),
        backfill: async (id) => {
          calls.push(id);
          if (network) throw new SyncTransportError(0, 'offline');
          if (id === 'a') throw new SyncTransportError(400, 'stale token');
          if (id === 'b') throw new SyncTransportError(503, 'busy');
          return { changes: [{ op: 'upsert', table: 'meeting', row: meeting }], next: null };
        },
      },
    });
    engine.start();
    await engine.syncNow();
    expect(calls).toEqual(['a', 'b']); // a dropped, b struck → stop for this run
    expect(engine.status.state).toBe('idle');
    expect(store.backfillQueue()).toEqual(['c', 'b']); // b went to the back, never blocks c
    await engine.syncNow();
    expect(calls.slice(2)).toEqual(['c', 'b']);
    expect(store.meeting('mt')).toBeDefined();
    network = true;
    await engine.syncNow();
    expect(engine.status.state).toBe('idle');
    expect(store.backfillQueue()).toEqual(['b']); // no strike for network trouble
    network = false;
    for (let i = 0; i < 3; i++) await engine.syncNow(); // strikes 3..5 → dropped
    expect(store.backfillQueue()).toEqual([]);
  });
});

describe('engine: lagging pulls and SSE notify', () => {
  it('a lagging pull is retried soon (doubling, capped by the interval); notify() resets a backoff', async () => {
    const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    let lagging = true;
    let offline = false;
    let pulls = 0;
    const engine = new SyncEngine({
      store,
      intervalMs: 60_000,
      laggingRetryMs: 2_000,
      setTimer: (fn, ms) => {
        const t = { fn, ms, cancelled: false };
        timers.push(t);
        return () => (t.cancelled = true);
      },
      random: () => 0.5,
      transport: {
        push: async () => ({ results: [] }),
        pull: async (cursor) => {
          pulls += 1;
          if (offline) throw new SyncTransportError(0, 'down');
          return { changes: [], cursor, hasMore: false, workspaceIds: ['ws'], lagging };
        },
      },
    });
    const last = () => timers.filter((t) => !t.cancelled).at(-1)!;
    engine.start();
    await engine.syncNow();
    expect(last().ms).toBe(2_000);
    await engine.syncNow();
    expect(last().ms).toBe(4_000);
    lagging = false;
    await engine.syncNow();
    expect(last().ms).toBe(60_000);

    offline = true;
    await engine.syncNow();
    expect(engine.status.state).toBe('offline');
    offline = false;
    const before = pulls;
    engine.notify();
    expect(last().ms).toBe(150);
    last().fn();
    await engine.idle();
    expect(pulls).toBe(before + 1);
    expect(engine.status.state).toBe('idle');
  });
});
