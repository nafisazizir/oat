import {
  type CalendarEvent,
  type CalendarEventInput,
  CalendarEventSchema,
  type Role,
  type SyncPullChange,
} from '@oat/core';
import { LocalStore } from '@oat/local-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MeetingNotes, MeetingNotesError } from './meeting-notes.ts';
import { MeetingPersistence, PersistenceError } from './meeting-persistence.ts';
import {
  ACTIVE_WORKSPACE_KEY,
  CONNECT_ONCE_MESSAGE,
  CREATE_WORKSPACE_MESSAGE,
  newNoteTarget,
  noNoteWorkspaceMessage,
  Workspaces,
  WorkspacesError,
} from './workspaces.ts';

let store: LocalStore;
let user: string | null;
let changes: number;
let waits: number;
let w: Workspaces;

const ws = (id: string, name: string, role: Role | null) =>
  ({ op: 'upsert', table: 'workspace', row: { id, name, role } }) as SyncPullChange;

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

const workspacesOver = (db: LocalStore, awaitWorkspaces = async () => false) =>
  new Workspaces({
    store: () => db,
    userId: () => 'u1',
    sync: { awaitWorkspaces },
    onChange: () => {},
  });

/** A database where I can only view every workspace I am in (D-36: nowhere for a new note). */
function viewOnlyStore() {
  const db = new LocalStore({ path: ':memory:' });
  db.applyPull(
    {
      changes: [ws('board', 'Board', 'viewer'), ws('council', 'Council', 'viewer')],
      cursor: 'c',
      hasMore: false,
      workspaceIds: ['board', 'council'],
    },
    null,
  );
  return db;
}

beforeEach(() => {
  store = new LocalStore({ path: ':memory:' });
  // "me" is the workspace made for me at sign-up: an ordinary one, listed by name like the others.
  pull([
    ws('me', 'Mine', 'owner'),
    ws('design', 'Design team', 'member'),
    ws('board', 'Board', 'viewer'),
  ]);
  user = 'u1';
  changes = 0;
  waits = 0;
  w = new Workspaces({
    store: () => store,
    userId: () => user,
    sync: {
      awaitWorkspaces: async () => {
        waits++;
        return store.firstWorkspaceId() !== null;
      },
    },
    onChange: () => void changes++,
  });
});
afterEach(() => store.close());

describe('Workspaces', () => {
  it('lists my workspaces by name, with my role and whether I can create there', () => {
    const s = w.snapshot();
    expect(s.workspaces).toEqual([
      { id: 'board', name: 'Board', role: 'viewer', canCreate: false },
      { id: 'design', name: 'Design team', role: 'member', canCreate: true },
      { id: 'me', name: 'Mine', role: 'owner', canCreate: true },
    ]);
    // Nothing chosen yet: the first workspace I can create in (not the view-only one listed first),
    // where new notes go too.
    expect(s).toMatchObject({ activeId: 'design', targetId: 'design' });
  });

  it('switching is remembered in the account’s database; new notes follow when I can create there', async () => {
    expect(w.setActive('me')).toMatchObject({ activeId: 'me', targetId: 'me' });
    expect(store.getState(ACTIVE_WORKSPACE_KEY)).toBe('me');
    expect(changes).toBe(1);
    w.setActive('me'); // no change, no announcement
    expect(changes).toBe(1);
    expect(await w.newNoteWorkspace()).toBe('me');
    expect(waits).toBe(0);
    // A fresh Workspaces over the same database (relaunch) keeps the choice.
    expect(workspacesOver(store).snapshot().activeId).toBe('me');
  });

  it('as a viewer of the active workspace, new notes go to the first one I can create in', async () => {
    expect(w.setActive('board')).toMatchObject({ activeId: 'board', targetId: 'design' });
    expect(await w.newNoteWorkspace()).toBe('design');
  });

  it('follows role changes and lost workspaces from sync', () => {
    w.setActive('design');
    pull([ws('design', 'Design team', 'viewer')], 'c-prev');
    // Demoted to viewer there: still shown, but new notes go to the one workspace left where I can create.
    expect(w.snapshot()).toMatchObject({ activeId: 'design', targetId: 'me' });
    // Left the workspace: the first one I can create in becomes active.
    pull([], 'c', ['me', 'board']);
    expect(w.snapshot()).toMatchObject({ activeId: 'me', targetId: 'me' });
    // …and when that one is gone too, the view-only one is all there is: shown, with nowhere to create.
    pull([], 'c2', ['board']);
    expect(w.snapshot()).toMatchObject({ activeId: 'board', targetId: null });
  });

  it('refuses unknown workspaces and works only while signed in', () => {
    expect(() => w.setActive('nope')).toThrow(WorkspacesError);
    user = null;
    expect(w.snapshot()).toEqual({ workspaces: [], activeId: null, targetId: null });
    expect(() => w.setActive('me')).toThrow(WorkspacesError);
  });

  it('a workspace pulled without my role is not mine to create in until sync says (no kind to guess from)', () => {
    const fresh = new LocalStore({ path: ':memory:' });
    fresh.applyPull(
      {
        changes: [ws('p', 'P', null), ws('t', 'T', 'member')],
        cursor: 'c',
        hasMore: false,
        workspaceIds: ['p', 't'],
      },
      null,
    );
    const x = workspacesOver(fresh);
    expect(x.setActive('p')).toMatchObject({ activeId: 'p', targetId: 't' });
    expect(x.snapshot().workspaces.map((s) => [s.id, s.canCreate])).toEqual([
      ['p', false],
      ['t', true],
    ]);
    fresh.close();
  });

  it('on a fresh database waits for sync to bring my workspaces', async () => {
    const empty = new LocalStore({ path: ':memory:' });
    let asked = 0;
    const offline = workspacesOver(empty, async () => {
      asked++;
      return false;
    });
    expect(await offline.newNoteWorkspace(10)).toBeNull();
    expect(asked).toBe(1);
    expect(noNoteWorkspaceMessage(empty)).toBe(CONNECT_ONCE_MESSAGE);

    // The wait is what brings them (first launch, online).
    const online = workspacesOver(empty, async () => {
      empty.applyPull(
        { changes: [ws('w1', 'Mine', 'owner')], cursor: 'c', hasMore: false, workspaceIds: ['w1'] },
        null,
      );
      return true;
    });
    expect(await online.newNoteWorkspace(10)).toBe('w1');
    empty.close();
  });
});

// D-36: no workspace is a fallback of last resort; with none I can create in, I am asked to make one.
describe('view-only everywhere', () => {
  it('there is no target; it is known at once (no waiting on sync) and the message asks for a workspace', async () => {
    const db = viewOnlyStore();
    let asked = 0;
    const x = workspacesOver(db, async () => {
      asked++;
      return true;
    });
    expect(x.snapshot()).toMatchObject({ activeId: 'board', targetId: null });
    expect(x.setActive('council')).toMatchObject({ activeId: 'council', targetId: null });
    expect(await x.newNoteWorkspace(10_000)).toBeNull();
    expect(asked).toBe(0);
    expect(noNoteWorkspaceMessage(db)).toBe(CREATE_WORKSPACE_MESSAGE);
    expect(noNoteWorkspaceMessage(null)).toBe(CONNECT_ONCE_MESSAGE);
    db.close();
  });

  it('a recording and "Start notes" are refused with that message, and nothing is written', async () => {
    const db = viewOnlyStore();
    const x = workspacesOver(db);
    const p = new MeetingPersistence({
      store: () => db,
      userId: () => 'u1',
      sync: { kick() {} },
      newNoteWorkspace: (t) => x.newNoteWorkspace(t),
    });
    const refused = await p.beginMeeting('m1', Date.now()).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(PersistenceError);
    expect((refused as Error).message).toBe(CREATE_WORKSPACE_MESSAGE);

    const notes = new MeetingNotes({
      store: () => db,
      userId: () => 'u1',
      sync: { kick() {} },
      newNoteWorkspace: (t) => x.newNoteWorkspace(t),
      onChange() {},
    });
    const noNote = await notes.fromEvent(event('a')).catch((e: unknown) => e);
    expect(noNote).toBeInstanceOf(MeetingNotesError);
    expect(noNote).toMatchObject({ code: 'unavailable', message: CREATE_WORKSPACE_MESSAGE });

    expect(db.documents()).toEqual([]);
    expect(db.outboxSize()).toBe(0);

    // A workspace of my own arrives (created on the web; joining one makes sync pull from the start
    // again): both work, and land there.
    db.applyPull(
      {
        changes: [
          ws('board', 'Board', 'viewer'),
          ws('council', 'Council', 'viewer'),
          ws('mine', 'Mine', 'owner'),
        ],
        cursor: 'c2',
        hasMore: false,
        workspaceIds: ['board', 'council', 'mine'],
      },
      null,
    );
    await p.beginMeeting('m1', Date.now());
    const made = await notes.fromEvent(event('a'));
    expect(db.documents().map((d) => d.workspaceId)).toEqual(['mine', 'mine']);
    expect(db.document(made.documentId)?.workspaceId).toBe('mine');
    db.close();
  });

  it('newNoteTarget: the active workspace if I can create there, else the first where I can, else none', () => {
    const list = w.snapshot().workspaces;
    const by = (id: string) => list.find((x) => x.id === id)!;
    expect(newNoteTarget(list, by('me'))?.id).toBe('me');
    expect(newNoteTarget(list, by('board'))?.id).toBe('design');
    expect(newNoteTarget(list, null)?.id).toBe('design');
    expect(newNoteTarget([by('board')], by('board'))).toBeNull();
    expect(newNoteTarget([], undefined)).toBeNull();
  });
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

describe('new notes land in the target workspace', () => {
  it('"New meeting note" (recording) creates in the active workspace, or as a viewer in the first I can create in', async () => {
    let n = 0;
    const p = new MeetingPersistence({
      store: () => store,
      userId: () => user,
      newId: () => `doc-${++n}`,
      sync: { kick() {} },
      newNoteWorkspace: (t) => w.newNoteWorkspace(t),
    });
    w.setActive('me');
    await p.beginMeeting('m1', Date.now());
    expect(store.document('doc-1')).toMatchObject({
      workspaceId: 'me',
      visibility: 'private',
      ownerId: 'u1',
    });
    w.setActive('board');
    await p.beginMeeting('m2', Date.now());
    expect(store.document('doc-2')?.workspaceId).toBe('design');
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
    w.setActive('me');
    const a = await notes.fromEvent(event('a'));
    expect(store.document(a.documentId)?.workspaceId).toBe('me');
    w.setActive('board');
    const b = await notes.fromEvent(event('b'));
    expect(store.document(b.documentId)?.workspaceId).toBe('design');
    expect((await notes.get({ documentId: a.documentId }))?.workspaceName).toBe('Mine');

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
