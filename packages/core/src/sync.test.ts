import { describe, expect, it } from 'vitest';

import {
  diffLines,
  documentContentKey,
  documentLines,
  sameDocumentContent,
  syncBackfillResponseSchema,
  syncConflictResolveSchema,
  syncDocumentRowSchema,
  syncEventSchema,
  SYNC_PULL_TABLES,
  SYNC_PUSH_TABLES,
  syncPullChangeSchema,
  syncPullResponseSchema,
  syncPushEntrySchema,
  syncPushRequestSchema,
  syncPushResultSchema,
} from './sync.ts';

const segment = {
  id: 'seg-1',
  meetingId: 'm-1',
  source: 'mic',
  speakerLabel: null,
  startMs: 100,
  endMs: 900,
  text: 'hello',
};

const doc = {
  id: 'd-1',
  workspaceId: 'w-1',
  folderId: null,
  ownerId: 'u-1',
  kind: 'meeting',
  title: 'Standup',
  contentJson: { type: 'doc', content: [] },
  visibility: 'private',
  version: 2,
  createdAt: '2026-11-14T10:00:00.000Z',
  updatedAt: '2026-11-14T10:00:00.000Z',
  deletedAt: null,
};

describe('sync protocol', () => {
  it('pull tables are the push tables plus workspace, parents first', () => {
    expect(SYNC_PUSH_TABLES).toEqual(['document', 'meeting', 'participant', 'transcript_segment']);
    expect(SYNC_PULL_TABLES[0]).toBe('workspace');
  });

  it('accepts upserts per table and deletes by id', () => {
    for (const entry of [
      { version: 1, op: 'upsert', table: 'transcript_segment', row: segment },
      {
        version: 2,
        op: 'upsert',
        table: 'document',
        baseVersion: 0,
        row: {
          id: 'd-1',
          workspaceId: 'w-1',
          kind: 'meeting',
          title: '',
          contentJson: { type: 'doc' },
        },
      },
      {
        version: 3,
        op: 'upsert',
        table: 'meeting',
        row: {
          id: 'm-1',
          documentId: 'd-1',
          calendarEventId: null,
          startedAt: '2026-11-14T10:00:00Z',
          endedAt: null,
          platform: null,
        },
      },
      {
        version: 4,
        op: 'upsert',
        table: 'participant',
        row: { id: 'p', meetingId: 'm-1', name: 'Ada', email: null, source: 'manual' },
      },
      { version: 5, op: 'delete', table: 'transcript_segment', id: 'seg-1' },
    ]) {
      expect(syncPushEntrySchema.safeParse(entry).success, JSON.stringify(entry)).toBe(true);
    }
  });

  it('rejects bad entries', () => {
    const bad = [
      { version: 0, op: 'upsert', table: 'transcript_segment', row: segment },
      { version: 1, op: 'upsert', table: 'transcript_segment', row: { ...segment, endMs: 50 } },
      { version: 1, op: 'upsert', table: 'transcript_segment', row: { ...segment, text: '' } },
      {
        version: 1,
        op: 'upsert',
        table: 'transcript_segment',
        row: { ...segment, isFinal: false },
      },
      { version: 1, op: 'upsert', table: 'workspace', row: { id: 'w', name: 'x' } },
      { version: 1, op: 'delete', table: 'workspace', id: 'w' },
      {
        version: 1,
        op: 'upsert',
        table: 'document',
        row: { id: 'd', workspaceId: 'w', kind: 'page', title: '', contentJson: { type: 'doc' } },
      }, // no baseVersion
    ];
    for (const entry of bad) {
      expect(syncPushEntrySchema.safeParse(entry).success, JSON.stringify(entry)).toBe(false);
    }
  });

  it('push envelope: 1..500 entries with versions', () => {
    expect(syncPushRequestSchema.safeParse({ entries: [] }).success).toBe(false);
    expect(syncPushRequestSchema.safeParse({ entries: [{ version: 1, junk: true }] }).success).toBe(
      true,
    );
    expect(syncPushRequestSchema.safeParse({ entries: [{ op: 'upsert' }] }).success).toBe(false);
    expect(
      syncPushRequestSchema.safeParse({
        entries: Array.from({ length: 501 }, (_, i) => ({ version: i + 1 })),
      }).success,
    ).toBe(false);
  });

  it('results and pull pages', () => {
    expect(syncPushResultSchema.parse({ version: 1, status: 'ok' })).toEqual({
      version: 1,
      status: 'ok',
    });
    expect(
      syncPushResultSchema.safeParse({ version: 1, status: 'conflict', row: doc }).success,
    ).toBe(true);
    expect(
      syncPullResponseSchema.safeParse({
        changes: [
          { op: 'upsert', table: 'document', row: doc },
          { op: 'delete', table: 'workspace', id: 'w-2' },
        ],
        cursor: '1.2',
        hasMore: false,
        workspaceIds: ['w-1'],
      }).success,
    ).toBe(true);
    expect(
      syncPullChangeSchema.safeParse({ op: 'upsert', table: 'folder', row: { id: 'f' } }).success,
    ).toBe(false);
  });
});

describe('sameDocumentContent', () => {
  it('ignores key order, block ids and empty attrs', () => {
    const a = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }],
    };
    const b = {
      content: [
        { attrs: { id: 'blk1' }, content: [{ text: 'x', type: 'text' }], type: 'paragraph' },
      ],
      type: 'doc',
    };
    expect(sameDocumentContent(a, b)).toBe(true);
    const h = (attrs: object) => ({ type: 'doc', content: [{ type: 'heading', attrs }] });
    expect(sameDocumentContent(h({ level: 1, id: 'a' }), h({ id: 'b', level: 1 }))).toBe(true);
    expect(sameDocumentContent(a, { type: 'doc', content: [] })).toBe(false);
    expect(sameDocumentContent(h({ level: 1 }), h({ level: 2 }))).toBe(false);
  });
});

describe('3.5 protocol additions', () => {
  const doc = (text: string, id?: string) => ({
    type: 'doc',
    content: [
      { type: 'paragraph', ...(id ? { attrs: { id } } : {}), content: [{ type: 'text', text }] },
    ],
  });

  it('documentContentKey matches sameDocumentContent and the server title rule', () => {
    expect(documentContentKey('  A  title ', doc('x'))).toBe(
      documentContentKey('A title', doc('x', 'b1')),
    );
    expect(documentContentKey('A', doc('x'))).not.toBe(documentContentKey('A', doc('y')));
    expect(documentContentKey('A', doc('x'))).not.toBe(documentContentKey('B', doc('x')));
  });

  it('push: device name and conflictOf are optional; rows default the conflict fields', () => {
    expect(
      syncPushRequestSchema.safeParse({ entries: [{ version: 1 }], device: { name: ' Mac ' } }).data
        ?.device,
    ).toEqual({ name: 'Mac' });
    expect(
      syncPushRequestSchema.safeParse({ entries: [{ version: 1 }], device: { name: '' } }).success,
    ).toBe(false);
    const entry = {
      version: 1,
      op: 'upsert',
      table: 'document',
      baseVersion: 0,
      row: {
        id: 'c',
        workspaceId: 'w',
        kind: 'page',
        title: 't',
        contentJson: doc('x'),
        conflictOf: 'd',
      },
    };
    expect(syncPushEntrySchema.safeParse(entry).success).toBe(true);
    const row = syncDocumentRowSchema.parse({
      id: 'd',
      workspaceId: 'w',
      folderId: null,
      ownerId: 'u',
      kind: 'page',
      title: '',
      contentJson: doc('x'),
      visibility: 'private',
      version: 1,
      createdAt: '2026-11-14T10:00:00.000Z',
      updatedAt: '2026-11-14T10:00:00.000Z',
      deletedAt: null,
    });
    expect(row).toMatchObject({ conflictOfId: null, conflictDevice: null, conflictAt: null });
  });

  it('pull lagging, backfill pages, events and conflict resolution', () => {
    expect(
      syncPullResponseSchema.parse({
        changes: [],
        cursor: null,
        hasMore: false,
        workspaceIds: [],
        lagging: true,
      }).lagging,
    ).toBe(true);
    expect(syncBackfillResponseSchema.parse({ changes: [], next: null })).toEqual({
      changes: [],
      next: null,
    });
    expect(syncEventSchema.parse({ seq: '1.2', tables: ['document'], ids: ['d'] }).ids).toEqual([
      'd',
    ]);
    expect(syncConflictResolveSchema.safeParse({ keep: 'copy' }).success).toBe(true);
    expect(syncConflictResolveSchema.safeParse({ keep: 'both' }).success).toBe(false);
  });
});

describe('compare helpers', () => {
  it('documentLines flattens blocks, lists and headings', () => {
    const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Agenda' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Hello ' },
            { type: 'text', text: 'world' },
          ],
        },
        { type: 'bulletList', content: [{ type: 'listItem', content: [p('one')] }] },
        {
          type: 'taskList',
          content: [{ type: 'taskItem', attrs: { checked: true }, content: [p('done')] }],
        },
        { type: 'paragraph' },
      ],
    };
    expect(documentLines(doc)).toEqual(['## Agenda', 'Hello world', '• one', '☑ done']);
  });

  it('diffLines marks what the other side lacks', () => {
    const d = diffLines(['a', 'b', 'c'], ['a', 'x', 'c', 'd']);
    expect(d.left.map((l) => l.changed)).toEqual([false, true, false]);
    expect(d.right.map((l) => l.changed)).toEqual([false, true, false, true]);
  });
});
