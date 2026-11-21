/**
 * Migration 5 (D-36: `workspace.kind` is gone) on an existing local store: the upgrade must not wipe the file
 * (a wipe means re-downloading everything and losing whatever wasn't pushed yet), must keep every row where
 * it was and must leave sync exactly where it stood.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MIGRATIONS, SCHEMA_VERSION } from './migrations.ts';
import { openDatabase } from './open.ts';
import { LocalStore } from './store.ts';

const FIXTURE = readFileSync(new URL('./fixtures/v4-two-kinds.sql', import.meta.url), 'utf8');
/** The schema the fixture was written for: the last one with `workspace.kind`. */
const BEFORE = 4;

let dir: string;
let file: string;
const errors: string[] = [];
const log = { warn: () => {}, error: (m: string) => errors.push(m) };

/** A file as the previous app version left it: migrations 1–4, then the fixture rows. */
function oldStore(): void {
  const { db } = openDatabase(file, log, MIGRATIONS.slice(0, BEFORE));
  db.exec(FIXTURE);
  db.close();
}

const rows = (sql: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
};

beforeEach(() => {
  errors.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'oat-local-store-m5-'));
  file = join(dir, 'oat.db');
  oldStore();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('local-store migration 5 (one kind of workspace)', () => {
  it('the fixture really is an old store: version 4, with a `personal` row and queued writes', () => {
    expect(rows('PRAGMA user_version')).toEqual([{ user_version: BEFORE }]);
    expect(rows('SELECT id, kind FROM workspace ORDER BY id')).toEqual([
      { id: 'ws-acme', kind: 'team' },
      { id: 'ws-board', kind: 'team' },
      { id: 'ws-own', kind: 'personal' },
    ]);
    expect(rows('SELECT count(*) AS n FROM outbox')).toEqual([{ n: 3 }]);
    expect(BEFORE).toBeLessThan(SCHEMA_VERSION);
  });

  it('upgrades in place: no wipe, every row where it was, the column gone', () => {
    const outboxBefore = rows(
      'SELECT version, table_name, row_id, op FROM outbox ORDER BY version',
    );
    const store = new LocalStore({ path: file, log });
    try {
      expect(store.wiped).toBeNull();
      expect(errors).toEqual([]);

      // Same workspaces under the same ids, with my roles; nothing says "personal" any more.
      expect(store.workspaces()).toEqual([
        { id: 'ws-acme', name: 'Acme', role: 'member' },
        { id: 'ws-board', name: 'Board', role: 'viewer' },
        { id: 'ws-own', name: 'Personal', role: 'owner' },
      ]);

      // Every document still in its workspace, with its content, version and meeting.
      expect(
        store.documents().map((d) => [d.id, d.workspaceId, d.ownerId, d.title, d.version]),
      ).toEqual([
        ['doc-synced', 'ws-own', 'u1', 'Synced standup', 3],
        ['doc-acme', 'ws-acme', 'u2', 'Acme weekly', 1],
        ['doc-offline', 'ws-own', 'u1', 'Offline recording', 0],
      ]);
      expect(store.meetingOfDocument('doc-synced')).toMatchObject({
        id: 'm-synced',
        calendarEventId: 'gcal:abc',
      });
      expect(store.segments('m-synced').map((s) => [s.id, s.text])).toEqual([
        ['seg-1', 'Morning, quick round on the pelican budget.'],
        ['seg-2', 'I finished the export flow yesterday.'],
      ]);
      expect(store.segments('m-offline').map((s) => s.text)).toEqual([
        'This was said while offline.',
      ]);

      // What wasn't pushed yet is still queued, entry for entry (nothing was re-enqueued or dropped).
      expect(store.outboxSize()).toBe(3);
      expect(
        store.outbox().map((e) => ({
          version: e.version,
          table_name: e.table,
          row_id: e.rowId,
          op: e.op,
        })),
      ).toEqual(outboxBefore);

      // Sync resumes from its cursor (no re-download), and the user's active workspace is remembered.
      expect(store.pullCursor()).toBe('cursor-42');
      expect(store.getState('pull.workspaces')).toBe('["ws-acme","ws-board","ws-own"]');
      expect(store.getState('desktop.activeWorkspace')).toBe('ws-own');

      // Local search still finds the old notes and transcript.
      expect(store.search('pelican').map((h) => h.documentId)).toContain('doc-synced');
    } finally {
      store.close();
    }
    expect(rows('PRAGMA user_version')).toEqual([{ user_version: SCHEMA_VERSION }]);
    expect(rows('PRAGMA table_info(workspace)').map((c) => c.name)).toEqual(['id', 'name', 'role']);
    expect(rows('PRAGMA foreign_key_check')).toEqual([]);
    expect(rows('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  });

  it('keeps working afterwards: a pull renames the former personal workspace, new notes are queued', () => {
    const store = new LocalStore({ path: file, log });
    try {
      // The server's rename ("Personal" → "<First name>’s workspace") arrives as an ordinary row, without `kind`.
      store.applyPull(
        {
          changes: [
            {
              op: 'upsert',
              table: 'workspace',
              row: { id: 'ws-own', name: 'Ada’s workspace', role: 'owner' },
            },
          ],
          cursor: 'cursor-43',
          hasMore: false,
          workspaceIds: ['ws-acme', 'ws-board', 'ws-own'],
        },
        'cursor-42',
      );
      expect(store.workspace('ws-own')).toEqual({
        id: 'ws-own',
        name: 'Ada’s workspace',
        role: 'owner',
      });
      expect(store.documents('ws-own').map((d) => d.id)).toEqual(['doc-synced', 'doc-offline']);
      expect(store.outboxSize()).toBe(3);

      store.createMeeting({
        meetingId: 'm-new',
        documentId: 'doc-new',
        workspaceId: 'ws-own',
        ownerId: 'u1',
        title: 'After the upgrade',
        startedAt: '2026-11-21T09:00:00.000Z',
      });
      expect(store.outboxSize()).toBe(5);
    } finally {
      store.close();
    }
  });

  it('reopening the upgraded file is a no-op', () => {
    new LocalStore({ path: file, log }).close();
    const store = new LocalStore({ path: file, log });
    try {
      expect(store.wiped).toBeNull();
      expect(store.outboxSize()).toBe(3);
      expect(store.workspaces()).toHaveLength(3);
    } finally {
      store.close();
    }
  });
});
