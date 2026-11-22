import type { SyncDocumentRow, SyncPullResponse } from '@oat/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalStore } from './store.ts';

let store: LocalStore;
let clock = Date.parse('2026-11-14T10:00:00Z');
const warnings: string[] = [];

beforeEach(() => {
  warnings.length = 0;
  let n = 0;
  store = new LocalStore({
    path: ':memory:',
    now: () => clock,
    newId: () => `copy-${++n}`,
    log: { warn: (m) => warnings.push(m), error: () => {} },
  });
});
afterEach(() => store.close());

const page = (changes: SyncPullResponse['changes'], extra: Partial<SyncPullResponse> = {}) => ({
  changes,
  cursor: 'c1',
  hasMore: false,
  workspaceIds: ['ws'],
  ...extra,
});

function withWorkspace() {
  store.applyPull(
    page([
      {
        op: 'upsert',
        table: 'workspace',
        row: { id: 'ws', name: 'Me', role: 'owner' },
      },
    ]),
    null,
  );
}

function meeting(id = 'm1', doc = 'd1') {
  store.createMeeting({
    meetingId: id,
    documentId: doc,
    workspaceId: 'ws',
    ownerId: 'u1',
    title: 'Standup',
    startedAt: '2026-11-14T10:00:00.000Z',
  });
}

const seg = (id: string, text = `text ${id}`, meetingId = 'm1') => ({
  id,
  meetingId,
  source: 'mic' as const,
  speakerLabel: null,
  startMs: 0,
  endMs: 10,
  text,
});

const serverDoc = (patch: Partial<SyncDocumentRow> = {}): SyncDocumentRow => ({
  id: 'd1',
  workspaceId: 'ws',
  folderId: null,
  ownerId: 'u1',
  kind: 'meeting',
  title: 'Standup',
  contentJson: { type: 'doc', content: [{ type: 'paragraph' }] },
  visibility: 'private',
  version: 0,
  createdAt: '2026-11-14T10:00:00.000Z',
  updatedAt: '2026-11-14T10:00:00.000Z',
  deletedAt: null,
  conflictOfId: null,
  conflictDevice: null,
  conflictAt: null,
  ...patch,
});

describe('meeting read-through cache', () => {
  it('preserves sync state and all workspaces, writes no outbox, and protects local copies', () => {
    withWorkspace();
    store.setState('read-through-test', 'unchanged');
    expect(store.cacheMeeting(serverDoc(), { id: 'ws', name: 'Me', role: 'owner' }, [])).toBe(true);
    expect(store.outboxSize()).toBe(0);
    expect(store.getState('read-through-test')).toBe('unchanged');
    expect(
      store.cacheMeeting(
        serverDoc({ title: 'Stale', version: 0 }),
        { id: 'ws', name: 'Old', role: 'viewer' },
        [],
      ),
    ).toBe(false);
    expect(store.document('d1')?.title).not.toBe('Stale');
    expect(store.workspace('ws')?.role).toBe('owner');
  });
  it('rolls back the whole cache when a child does not belong to the document', () => {
    expect(() =>
      store.cacheMeeting(serverDoc(), { id: 'ws', name: 'Me', role: 'owner' }, [
        { op: 'upsert', table: 'transcript_segment', row: seg('foreign') },
      ]),
    ).toThrow('Invalid meeting cache child.');
    expect(store.document('d1')).toBeUndefined();
    expect(store.workspace('ws')).toBeUndefined();
    expect(store.outboxSize()).toBe(0);
  });
});

describe('outbox triggers', () => {
  it('enqueue inserts, updates and deletes; one entry per row with a fresh version', () => {
    withWorkspace();
    expect(store.outboxSize()).toBe(0); // remote writes never echo
    meeting();
    expect(store.outbox().map((e) => [e.table, e.rowId, e.op])).toEqual([
      ['document', 'd1', 'upsert'],
      ['meeting', 'm1', 'upsert'],
    ]);
    store.saveSegment(seg('s1'));
    const first = store.outbox().find((e) => e.rowId === 's1')!.version;
    expect(store.saveSegment(seg('s1'))).toBe('unchanged');
    expect(store.outbox().find((e) => e.rowId === 's1')!.version).toBe(first); // no churn
    expect(store.saveSegment(seg('s1', 'edited'))).toBe('updated');
    const second = store.outbox().find((e) => e.rowId === 's1')!.version;
    expect(second).toBeGreaterThan(first);
    expect(store.outbox().filter((e) => e.rowId === 's1')).toHaveLength(1);
    store.deleteSegment('s1');
    expect(store.outbox().find((e) => e.rowId === 's1')).toMatchObject({ op: 'delete' });
  });

  it('a segment id belongs to one meeting', () => {
    withWorkspace();
    meeting('m1', 'd1');
    meeting('m2', 'd2');
    store.saveSegment(seg('s1'));
    expect(() => store.saveSegment(seg('s1', 'x', 'm2'))).toThrow(/another meeting/);
  });

  it('createMeeting is idempotent; updates that change nothing enqueue nothing', () => {
    withWorkspace();
    meeting();
    const before = store.outbox();
    meeting();
    expect(store.updateMeeting('m1', { startedAt: '2026-11-14T10:00:00.000Z' })).toBe(false);
    expect(store.updateDocument('d1', { title: 'Standup' })).toBe(false);
    expect(store.outbox()).toEqual(before);
    expect(store.updateMeeting('m1', { endedAt: '2026-11-14T10:30:00.000Z' })).toBe(true);
    expect(store.meeting('m1')!.endedAt).toBe('2026-11-14T10:30:00.000Z');
  });
});

describe('push', () => {
  it('batches parents first and joins current rows', () => {
    withWorkspace();
    meeting();
    store.saveSegment(seg('s1'));
    store.updateDocument('d1', { title: 'Renamed' }); // re-enqueued after the segment
    const batch = store.takePushBatch(10);
    expect(batch.map((e) => e.table)).toEqual(['document', 'meeting', 'transcript_segment']);
    expect(batch[0]).toMatchObject({
      op: 'upsert',
      baseVersion: 0,
      row: { id: 'd1', title: 'Renamed', workspaceId: 'ws', kind: 'meeting' },
    });
    expect(batch[1]).toMatchObject({ row: { id: 'm1', documentId: 'd1' } });
    expect(batch[1]!.op === 'upsert' && 'templateId' in batch[1]!.row).toBe(false);
    expect(store.takePushBatch(1)).toHaveLength(1);
  });

  it('acks by version: an edit made while the push was in flight stays queued', () => {
    withWorkspace();
    meeting();
    store.saveSegment(seg('s1'));
    const batch = store.takePushBatch(10);
    store.saveSegment(seg('s1', 'newer text')); // while the request is in flight
    const outcome = store.applyPushResults(
      batch,
      batch.map((e) => ({
        version: e.version,
        status: 'ok' as const,
        ...(e.table === 'document' ? { row: serverDoc({ version: 0 }) } : {}),
      })),
    );
    expect(outcome.acknowledged).toBe(3);
    expect(store.outbox().map((e) => e.rowId)).toEqual(['s1']);
    const next = store.takePushBatch(10);
    expect(next[0]).toMatchObject({ row: { text: 'newer text' } });
  });

  it('stores the server version on ack, and the server row when not edited since', () => {
    withWorkspace();
    meeting();
    const [docEntry] = store.takePushBatch(1);
    store.applyPushResults(
      [docEntry!],
      [
        {
          version: docEntry!.version,
          status: 'ok',
          row: serverDoc({
            version: 3,
            contentJson: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'b1' } }] },
          }),
        },
      ],
    );
    expect(store.document('d1')).toMatchObject({ version: 3 });
    expect(store.document('d1')!.contentJson).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { id: 'b1' } }],
    });
    // Edited after the push: only the version is taken.
    store.updateDocument('d1', { title: 'Mine' });
    const [again] = store.takePushBatch(1);
    store.updateDocument('d1', { title: 'Mine, later' });
    store.applyPushResults(
      [again!],
      [{ version: again!.version, status: 'ok', row: serverDoc({ version: 4, title: 'Mine' }) }],
    );
    expect(store.document('d1')).toMatchObject({ version: 4, title: 'Mine, later' });
    expect(store.outbox().map((e) => e.rowId)).toContain('d1');
  });

  it('conflict: keeps the server copy and files ours as a conflicted copy', () => {
    withWorkspace();
    meeting();
    store.updateDocument('d1', { title: 'Our title' });
    const batch = store.takePushBatch(10);
    const docEntry = batch.find((e) => e.table === 'document')!;
    const outcome = store.applyPushResults(batch, [
      {
        version: docEntry.version,
        status: 'conflict',
        row: serverDoc({ title: 'Theirs', version: 5 }),
      },
    ]);
    expect(outcome).toMatchObject({ conflicts: 1, copies: ['copy-1'] });
    expect(store.document('d1')).toMatchObject({ title: 'Theirs', version: 5 });
    expect(store.document('copy-1')).toMatchObject({
      title: 'Our title (conflicted copy)',
      kind: 'page',
      version: 0,
    });
    const queued = store.outbox().map((e) => `${e.table}:${e.rowId}`);
    expect(queued).toContain('document:copy-1');
    expect(queued).not.toContain('document:d1');
  });

  it('conflict with identical text makes no copy', () => {
    withWorkspace();
    meeting();
    const [docEntry] = store.takePushBatch(1);
    const outcome = store.applyPushResults(
      [docEntry!],
      [{ version: docEntry!.version, status: 'conflict', row: serverDoc({ version: 2 }) }],
    );
    expect(outcome.copies).toEqual([]);
    expect(store.documents()).toHaveLength(1);
  });

  it('rejected entries are parked (kept, skipped, counted), never dropped; unknown versions ignored', () => {
    withWorkspace();
    meeting();
    store.saveSegment(seg('s1'));
    const batch = store.takePushBatch(10);
    const segEntry = batch.find((e) => e.table === 'transcript_segment')!;
    const outcome = store.applyPushResults(batch, [
      { version: segEntry.version, status: 'rejected', code: 'forbidden', message: 'no' },
      { version: 9999, status: 'ok' },
    ]);
    expect(outcome.rejected).toBe(1);
    expect(outcome.acknowledged).toBe(0);
    expect(store.outbox().map((e) => [e.rowId, e.parked])).toEqual([
      ['d1', false],
      ['m1', false],
      ['s1', true],
    ]);
    expect(store.outboxSize()).toBe(2);
    expect(store.parkedCount()).toBe(1);
    expect(store.takePushBatch(10).map((e) => e.table)).toEqual(['document', 'meeting']);
    expect(warnings.join()).toMatch(/parked 1 .*transcript_segment s1: forbidden/);
    // Editing the row again queues a fresh (unparked) entry.
    store.saveSegment(seg('s1', 'edited'));
    expect(store.parkedCount()).toBe(0);
    expect(store.outboxSize()).toBe(3);
  });

  it('parked entries come back after a while, or when their note changes on the server', () => {
    withWorkspace();
    meeting();
    store.saveSegment(seg('s1'));
    store.saveSegment(seg('s2'));
    const versions = store
      .outbox()
      .filter((e) => e.table === 'transcript_segment')
      .map((e) => e.version);
    store.park(versions, 'note in the trash');
    expect(store.parkedCount()).toBe(2);
    expect(store.unparkOlderThan(clock - 1)).toBe(0); // too recent
    // An echo of the note as we know it changes nothing…
    store.applyPull(page([{ op: 'upsert', table: 'document', row: serverDoc() }]), 'c0');
    expect(store.parkedCount()).toBe(2);
    // …a newer version (restored from the trash, edited elsewhere) retries its children.
    store.applyPull(
      page([{ op: 'upsert', table: 'document', row: serverDoc({ version: 3 }) }]),
      'c1',
    );
    expect(store.parkedCount()).toBe(0);
    store.park(versions, 'again');
    expect(store.unparkOlderThan(clock + 1)).toBe(2);
  });

  it('caps a batch by bytes as well as by count (an oversized entry goes alone)', () => {
    withWorkspace();
    meeting();
    for (let i = 0; i < 10; i++) store.saveSegment(seg(`s${i}`, 'x'.repeat(1000)));
    store.updateDocument('d1', {
      contentJson: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'y'.repeat(5000) }] }],
      },
    });
    const first = store.takePushBatch(500, 3000);
    expect(first.map((e) => e.table)).toEqual(['document']); // > 3000 bytes on its own
    store.applyPushResults(
      first,
      first.map((e) => ({ version: e.version, status: 'ok' as const })),
    );
    const next = store.takePushBatch(500, 3000);
    expect(next.length).toBeGreaterThan(1);
    expect(JSON.stringify(next).length).toBeLessThanOrEqual(3000 + next.length);
  });

  it('drops upsert entries whose row is gone', () => {
    withWorkspace();
    meeting();
    store.saveSegment(seg('s1'));
    // Simulate a row vanishing without a trigger (e.g. remote delete raced): remove it remotely.
    store.applyPull(page([{ op: 'delete', table: 'transcript_segment', id: 's1' }]), 'c0');
    expect(store.outbox().map((e) => e.rowId)).not.toContain('s1');
  });
});

describe('pull', () => {
  it('applies upserts without echo and stores the cursor', () => {
    withWorkspace();
    store.applyPull(
      page(
        [
          { op: 'upsert', table: 'document', row: serverDoc({ id: 'd9' }) },
          {
            op: 'upsert',
            table: 'meeting',
            row: {
              id: 'm9',
              documentId: 'd9',
              calendarEventId: null,
              startedAt: null,
              endedAt: null,
              platform: null,
              templateId: null,
            },
          },
          { op: 'upsert', table: 'transcript_segment', row: seg('s9', 'remote', 'm9') },
          {
            op: 'upsert',
            table: 'participant',
            row: { id: 'p9', meetingId: 'm9', name: 'Ada', email: null, source: 'manual' },
          },
        ],
        { cursor: 'c2' },
      ),
      'c1',
    );
    expect(store.outboxSize()).toBe(0);
    expect(store.segments('m9').map((s) => s.text)).toEqual(['remote']);
    expect(store.participants('m9')).toHaveLength(1);
    expect(store.pullCursor()).toBe('c2');
  });

  it('children may arrive before parents within a page; orphans are dropped', () => {
    withWorkspace();
    store.applyPull(
      page([
        { op: 'upsert', table: 'transcript_segment', row: seg('s1', 'a', 'm1') },
        {
          op: 'upsert',
          table: 'meeting',
          row: {
            id: 'm1',
            documentId: 'd1',
            calendarEventId: null,
            startedAt: null,
            endedAt: null,
            platform: null,
            templateId: null,
          },
        },
        { op: 'upsert', table: 'document', row: serverDoc() },
        { op: 'upsert', table: 'transcript_segment', row: seg('orphan', 'b', 'nope') },
      ]),
      'c0',
    );
    expect(store.segments('m1')).toHaveLength(1);
    expect(store.segments('nope')).toHaveLength(0);
  });

  it('a pending local edit wins over a remote upsert; a remote delete wins over it', () => {
    withWorkspace();
    meeting();
    store.saveSegment(seg('s1', 'local'));
    store.applyPull(
      page([{ op: 'upsert', table: 'transcript_segment', row: seg('s1', 'remote') }]),
      'c0',
    );
    expect(store.segments('m1')[0]!.text).toBe('local');
    store.applyPull(page([{ op: 'delete', table: 'document', id: 'd1' }]), 'c1');
    expect(store.document('d1')).toBeUndefined();
    expect(store.segments('m1')).toHaveLength(0); // cascade
    expect(store.outboxSize()).toBe(0); // nothing left to push for rows that are gone
  });

  it('drops workspaces the user left, with their content', () => {
    withWorkspace();
    store.applyPull(
      page(
        [
          {
            op: 'upsert',
            table: 'workspace',
            row: { id: 'team', name: 'T', role: 'member' },
          },
        ],
        {
          workspaceIds: ['ws', 'team'],
        },
      ),
      null,
    );
    store.applyPull(
      page(
        [{ op: 'upsert', table: 'document', row: serverDoc({ id: 'td', workspaceId: 'team' }) }],
        {
          workspaceIds: ['ws', 'team'],
        },
      ),
      'c1',
    );
    expect(store.document('td')).toBeDefined();
    store.applyPull(page([], { workspaceIds: ['ws'] }), 'c1');
    expect(store.document('td')).toBeUndefined();
    expect(store.workspaces().map((w) => w.id)).toEqual(['ws']);
  });

  it('keeps my role per workspace (3.9) and follows changes to it; an older pull scope restarts', () => {
    withWorkspace();
    const team = (role: 'member' | 'viewer') =>
      page([{ op: 'upsert', table: 'workspace', row: { id: 'team', name: 'T', role } }], {
        workspaceIds: ['ws', 'team'],
      });
    store.applyPull(team('member'), null);
    expect(store.workspace('team')).toEqual({
      id: 'team',
      name: 'T',
      role: 'member',
    });
    store.applyPull(team('viewer'), 'c1');
    expect(store.workspace('team')?.role).toBe('viewer');
    // A database whose cursor was made under scope 2 (no roles) pulls from the start again.
    store.setState('pull.scope', '2');
    expect(store.pullCursor()).toBeNull();
  });

  it('joining a workspace restarts the pull from the beginning', () => {
    withWorkspace();
    const r = store.applyPull(
      page([{ op: 'upsert', table: 'document', row: serverDoc({ id: 'x' }) }], {
        workspaceIds: ['ws', 'new-team'],
        cursor: 'c9',
      }),
      'c1',
    );
    expect(r.restart).toBe(true);
    expect(store.document('x')).toBeUndefined(); // nothing applied
    expect(store.pullCursor()).toBeNull();
    // From the beginning, the new workspace is known: no further restart.
    expect(store.applyPull(page([], { workspaceIds: ['ws', 'new-team'] }), null).restart).toBe(
      false,
    );
  });

  it('a remote workspace delete drops it', () => {
    withWorkspace();
    meeting();
    store.applyPull(page([{ op: 'delete', table: 'workspace', id: 'ws' }]), 'c1');
    expect(store.workspaces()).toEqual([]);
    expect(store.documents()).toEqual([]);
  });

  it('finds the first workspace', () => {
    expect(store.firstWorkspaceId()).toBeNull();
    withWorkspace();
    expect(store.firstWorkspaceId()).toBe('ws');
  });
});

describe('pull scope', () => {
  it('an older scope restarts the cursor', () => {
    store.setState('pull.cursor', 'c5');
    store.setState('pull.scope', '0');
    expect(store.pullCursor()).toBeNull();
    store.setState('pull.cursor', 'c6');
    expect(store.pullCursor()).toBe('c6');
    clock += 1;
  });
});

describe('meeting notes (3.4)', () => {
  it('lists live meeting documents newest first, with or without a meeting row', () => {
    withWorkspace();
    meeting('m1', 'd1');
    store.createMeeting({
      meetingId: 'm2',
      documentId: 'd2',
      workspaceId: 'ws',
      ownerId: 'u1',
      title: 'Later',
      startedAt: '2026-11-14T12:00:00.000Z',
    });
    // From the web: a meeting note without a recording, a page, a trashed note.
    store.applyPull(
      page([
        {
          op: 'upsert',
          table: 'document',
          row: serverDoc({ id: 'd3', title: 'Web note', createdAt: '2026-11-14T11:00:00.000Z' }),
        },
        { op: 'upsert', table: 'document', row: serverDoc({ id: 'd4', kind: 'page' }) },
        {
          op: 'upsert',
          table: 'document',
          row: serverDoc({ id: 'd5', deletedAt: '2026-11-14T11:30:00.000Z' }),
        },
      ]),
      'c1',
    );
    const notes = store.meetingNotes();
    expect(notes.map((n) => [n.documentId, n.meetingId, n.title])).toEqual([
      ['d2', 'm2', 'Later'],
      ['d3', null, 'Web note'],
      ['d1', 'm1', 'Standup'],
    ]);
    expect(notes[0]).toMatchObject({ startedAt: '2026-11-14T12:00:00.000Z', endedAt: null });
    expect(store.meetingNotes(1)).toHaveLength(1);
    expect(store.meetingOfDocument('d2')?.id).toBe('m2');
    expect(store.meetingOfDocument('d3')).toBeUndefined();
  });

  it('saves a local conflicted copy (3.4) of the same kind as a push conflict makes (3.5)', () => {
    withWorkspace();
    meeting('m1', 'd1');
    const content = { type: 'doc' as const, content: [{ type: 'paragraph' }] };
    const id = store.saveConflictedCopy('d1', 'u1', { title: 'Standup', contentJson: content });
    expect(store.document(id)).toMatchObject({
      kind: 'page',
      visibility: 'private',
      title: 'Standup (conflicted copy)',
      ownerId: 'u1',
      version: 0,
      contentJson: content,
      conflictOfId: 'd1',
    });
    expect(store.conflict(id)?.original?.id).toBe('d1');
    expect(store.outbox().some((e) => e.table === 'document' && e.rowId === id)).toBe(true);
    expect(() =>
      store.saveConflictedCopy('nope', 'u1', { title: '', contentJson: content }),
    ).toThrow();
  });
});
