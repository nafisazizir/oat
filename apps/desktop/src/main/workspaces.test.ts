import {
  type CalendarEvent,
  type CalendarEventInput,
  CalendarEventSchema,
  type Role,
  type SyncPullChange,
} from '@oat/core';
import { LocalStore } from '@oat/local-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MeetingNotes } from './meeting-notes.ts';
import { MeetingPersistence } from './meeting-persistence.ts';
import { ACTIVE_WORKSPACE_KEY, Workspaces, WorkspacesError } from './workspaces.ts';

let store: LocalStore;
let user: string | null;
let changes: number;
let personalWaits: number;
let w: Workspaces;

const ws = (id: string, name: string, kind: 'personal' | 'team', role: Role | null) =>
  ({ op: 'upsert', table: 'workspace', row: { id, name, kind, role } }) as SyncPullChange;

/** One pull page; `workspaceIds` = the workspaces I belong to now (all three unless said). */
function pull(
  rows: SyncPullChange[],
  cursor: string | null = null,
  workspaceIds = ['me', 'design', 'board'],
) {
  store.applyPull(
    { changes: rows, cursor: `c${Math.random()}`, hasMore: false, workspaceIds },
    cursor,
  );
}

beforeEach(() => {
  store = new LocalStore({ path: ':memory:' });
  pull([
    ws('me', 'Personal', 'personal', 'owner'),
    ws('design', 'Design team', 'team', 'member'),
    ws('board', 'Board', 'team', 'viewer'),
  ]);
  user = 'u1';
  changes = 0;
  personalWaits = 0;
  w = new Workspaces({
    store: () => store,
    userId: () => user,
    sync: {
      personalWorkspace: async () => {
        personalWaits++;
        return store.personalWorkspaceId();
      },
    },
    onChange: () => void changes++,
  });
});
afterEach(() => store.close());

describe('Workspaces', () => {
  it('lists personal first, then teams by name, with my role and whether I can create there', () => {
    const s = w.snapshot();
    expect(s.workspaces.map((x) => [x.name, x.role, x.canCreate])).toEqual([
      ['Personal', 'owner', true],
      ['Board', 'viewer', false],
      ['Design team', 'member', true],
    ]);
    // Nothing chosen yet: the personal workspace, where new notes go too.
    expect(s).toMatchObject({ activeId: 'me', targetId: 'me' });
  });

  it('switching is remembered in the account’s database; new notes follow when I can create there', async () => {
    expect(w.setActive('design')).toMatchObject({ activeId: 'design', targetId: 'design' });
    expect(store.getState(ACTIVE_WORKSPACE_KEY)).toBe('design');
    expect(changes).toBe(1);
    w.setActive('design'); // no change, no announcement
    expect(changes).toBe(1);
    expect(await w.newNoteWorkspace()).toBe('design');
    // A fresh Workspaces over the same database (relaunch) keeps the choice.
    const again = new Workspaces({
      store: () => store,
      userId: () => user,
      sync: { personalWorkspace: async () => null },
      onChange: () => {},
    });
    expect(again.snapshot().activeId).toBe('design');
  });

  it('as a viewer, new notes go to my personal workspace (the snapshot says so)', async () => {
    expect(w.setActive('board')).toMatchObject({ activeId: 'board', targetId: 'me' });
    expect(await w.newNoteWorkspace()).toBe('me');
  });

  it('follows role changes and lost workspaces from sync', () => {
    w.setActive('design');
    pull([ws('design', 'Design team', 'team', 'viewer')], 'c-prev');
    expect(w.snapshot()).toMatchObject({ activeId: 'design', targetId: 'me' });
    // Left the workspace: back to personal.
    pull([], 'c', ['me', 'board']);
    expect(w.snapshot()).toMatchObject({ activeId: 'me', targetId: 'me' });
  });

  it('refuses unknown workspaces and works only while signed in', () => {
    expect(() => w.setActive('nope')).toThrow(WorkspacesError);
    user = null;
    expect(w.snapshot()).toEqual({ workspaces: [], activeId: null, targetId: null });
    expect(() => w.setActive('me')).toThrow(WorkspacesError);
  });

  it('a personal workspace pulled without a role is still mine; a team one is not until sync says', () => {
    const fresh = new LocalStore({ path: ':memory:' });
    fresh.applyPull(
      {
        changes: [ws('p', 'P', 'personal', null), ws('t', 'T', 'team', null)],
        cursor: 'c',
        hasMore: false,
        workspaceIds: ['p', 't'],
      },
      null,
    );
    const x = new Workspaces({
      store: () => fresh,
      userId: () => 'u1',
      sync: { personalWorkspace: async () => 'p' },
      onChange: () => {},
    });
    expect(x.setActive('t')).toMatchObject({ activeId: 't', targetId: 'p' });
    fresh.close();
  });

  it('on a fresh database waits for sync to learn the personal workspace', async () => {
    const empty = new LocalStore({ path: ':memory:' });
    const x = new Workspaces({
      store: () => empty,
      userId: () => 'u1',
      sync: {
        personalWorkspace: async () => {
          personalWaits++;
          return null;
        },
      },
      onChange: () => {},
    });
    expect(await x.newNoteWorkspace(10)).toBeNull();
    expect(personalWaits).toBe(1);
    empty.close();
  });
});

describe('new notes land in the target workspace', () => {
  it('"New meeting note" (recording) creates in the active team workspace, or personal as a viewer', async () => {
    let n = 0;
    const p = new MeetingPersistence({
      store: () => store,
      userId: () => user,
      newId: () => `doc-${++n}`,
      sync: { kick() {}, personalWorkspace: async () => 'me' },
      newNoteWorkspace: (t) => w.newNoteWorkspace(t),
    });
    w.setActive('design');
    await p.beginMeeting('m1', Date.now());
    expect(store.document('doc-1')).toMatchObject({
      workspaceId: 'design',
      visibility: 'private',
      ownerId: 'u1',
    });
    w.setActive('board');
    await p.beginMeeting('m2', Date.now());
    expect(store.document('doc-2')?.workspaceId).toBe('me');
  });

  it('calendar "Start notes" creates in the target workspace; a viewer’s notes are view-only', async () => {
    let n = 0;
    const notes = new MeetingNotes({
      store: () => store,
      userId: () => user,
      sync: { kick() {} },
      newNoteWorkspace: (t) => w.newNoteWorkspace(t),
      onChange() {},
      newId: () => `id-${++n}`,
    });
    const event = (id: string): CalendarEvent =>
      CalendarEventSchema.parse({
        id: `eventkit:${id}`,
        source: 'eventkit',
        calendar: { id: 'c', title: 'Work', color: '#3B82F6' },
        title: `Event ${id}`,
        start: '2026-11-16T19:00:00.000Z',
        end: '2026-11-16T19:30:00.000Z',
        allDay: false,
        allDayStart: null,
        allDayEnd: null,
        timeZone: null,
        location: null,
        url: null,
        conferenceUrl: null,
        conferenceProvider: null,
        status: 'confirmed',
        attendees: [],
        recurrenceId: null,
        icalUid: `${id}@oat.test`,
      } satisfies CalendarEventInput);
    w.setActive('design');
    const a = await notes.fromEvent(event('a'));
    expect(store.document(a.documentId)?.workspaceId).toBe('design');
    w.setActive('board');
    const b = await notes.fromEvent(event('b'));
    expect(store.document(b.documentId)?.workspaceId).toBe('me');
    expect((await notes.get({ documentId: a.documentId }))?.workspaceName).toBe('Design team');

    // A note shared with the Board workspace is view-only for me there (my role is synced).
    pull(
      [
        {
          op: 'upsert',
          table: 'document',
          row: {
            id: 'shared',
            workspaceId: 'board',
            folderId: null,
            ownerId: 'u2',
            kind: 'meeting',
            title: 'Board sync',
            contentJson: { type: 'doc' },
            visibility: 'workspace',
            version: 1,
            createdAt: '2026-11-15T09:00:00.000Z',
            updatedAt: '2026-11-15T09:00:00.000Z',
            deletedAt: null,
            conflictOfId: null,
            conflictDevice: null,
            conflictAt: null,
          },
        },
      ],
      'c',
    );
    expect((await notes.get({ documentId: 'shared' }))?.editable).toBe(false);
  });
});
