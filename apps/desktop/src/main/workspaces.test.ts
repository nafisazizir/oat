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
  NO_WORKSPACE_MESSAGE,
  noNoteWorkspaceReason,
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

const workspacesOver = (
  db: LocalStore,
  awaitWorkspaces: (timeoutMs?: number) => Promise<boolean> = async () => false,
) =>
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

  it('the default is remembered: a workspace that arrives later and sorts earlier doesn’t take over', () => {
    expect(store.getState(ACTIVE_WORKSPACE_KEY)).toBeNull();
    expect(w.snapshot().activeId).toBe('design');
    expect(store.getState(ACTIVE_WORKSPACE_KEY)).toBe('design');
    expect(changes).toBe(0); // nothing to announce: it is what was already shown
    // I join "Alpha" (sorts before "Design team"; joining restarts the pull from the beginning).
    pull(
      [
        ws('alpha', 'Alpha', 'owner'),
        ws('me', 'Mine', 'owner'),
        ws('design', 'Design team', 'member'),
        ws('board', 'Board', 'viewer'),
      ],
      null,
      ['alpha', 'me', 'design', 'board'],
    );
    expect(w.snapshot().workspaces.map((x) => x.id)).toEqual(['alpha', 'board', 'design', 'me']);
    expect(w.snapshot()).toMatchObject({ activeId: 'design', targetId: 'design' });
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

// Review (step A) #2: synced with no workspace at all is not "check your connection".
describe('in no workspace at all', () => {
  /** Synced, then removed from my only workspace (or its owner deleted it): the pull drops it. */
  function emptiedStore() {
    const db = new LocalStore({ path: ':memory:' });
    db.applyPull(
      { changes: [ws('w1', 'Team', 'member')], cursor: 'c', hasMore: false, workspaceIds: ['w1'] },
      null,
    );
    db.applyPull({ changes: [], cursor: 'c2', hasMore: false, workspaceIds: [] }, 'c');
    return db;
  }

  // The ordering behind "You’re not in a workspace any more" right after sign-in (storage.spec, ~1 in 5):
  // the server's list of my workspaces arrives with every pull page, their rows come from the change log.
  it('a pull that names my workspace before its row arrives is not "in no workspace"', async () => {
    // The last page of the first pull, while the transaction that made my workspace is held back (D-22).
    const lagging = new LocalStore({ path: ':memory:' });
    lagging.applyPull(
      { changes: [], cursor: 'c1', hasMore: false, workspaceIds: ['w1'], lagging: true },
      null,
    );
    expect(lagging.workspaces()).toEqual([]);
    expect(lagging.hasPulled()).toBe(false);
    expect(noNoteWorkspaceReason(lagging)).toBe('unknown');
    expect(noNoteWorkspaceMessage(lagging)).not.toBe(NO_WORKSPACE_MESSAGE);
    expect(workspacesOver(lagging).snapshot()).toMatchObject({ workspaces: [], synced: false });
    // A start now waits for sync (the full wait, not the 1.5 s re-check) and gets the workspace.
    const waits: (number | undefined)[] = [];
    const started = new Workspaces({
      store: () => lagging,
      userId: () => 'me',
      sync: {
        awaitWorkspaces: async (timeoutMs) => {
          waits.push(timeoutMs);
          // The retry after `lagging` brings the row.
          lagging.applyPull(
            {
              changes: [ws('w1', 'My workspace', 'owner')],
              cursor: 'c2',
              hasMore: false,
              workspaceIds: ['w1'],
            },
            'c1',
          );
          return true;
        },
      },
      onChange: () => {},
    });
    expect(await started.newNoteWorkspace(10_000)).toBe('w1');
    expect(waits).toEqual([10_000]);
    expect(lagging.hasPulled()).toBe(true);
    lagging.close();

    // Synced and in none, then I join one: the pull restarts from the beginning before any row is applied.
    const joined = emptiedStore();
    expect(noNoteWorkspaceReason(joined)).toBe('none');
    expect(
      joined.applyPull({ changes: [], cursor: 'c3', hasMore: false, workspaceIds: ['w2'] }, 'c2'),
    ).toEqual({ restart: true });
    expect(joined.workspaces()).toEqual([]);
    expect(joined.hasPulled()).toBe(false);
    expect(noNoteWorkspaceReason(joined)).toBe('unknown');
    joined.applyPull(
      {
        changes: [ws('w2', 'Joined', 'member')],
        cursor: 'c4',
        hasMore: false,
        workspaceIds: ['w2'],
      },
      null,
    );
    expect(joined.hasPulled()).toBe(true);
    expect(workspacesOver(joined).snapshot()).toMatchObject({ targetId: 'w2', synced: true });
    joined.close();
  });

  it('never synced vs synced-and-none are told apart', () => {
    const fresh = new LocalStore({ path: ':memory:' });
    expect(fresh.hasPulled()).toBe(false);
    expect(noNoteWorkspaceReason(fresh)).toBe('unknown');
    expect(noNoteWorkspaceMessage(fresh)).toBe(CONNECT_ONCE_MESSAGE);
    expect(workspacesOver(fresh).snapshot()).toMatchObject({ workspaces: [], synced: false });
    // The first pull is still paging: not known yet.
    fresh.applyPull({ changes: [], cursor: 'c', hasMore: true, workspaceIds: [] }, null);
    expect(fresh.hasPulled()).toBe(false);
    expect(noNoteWorkspaceReason(fresh)).toBe('unknown');
    fresh.close();

    const db = emptiedStore();
    expect(db.workspaces()).toEqual([]);
    expect(db.hasPulled()).toBe(true);
    expect(noNoteWorkspaceReason(db)).toBe('none');
    expect(noNoteWorkspaceMessage(db)).toBe(NO_WORKSPACE_MESSAGE);
    expect(workspacesOver(db).snapshot()).toEqual({
      workspaces: [],
      activeId: null,
      targetId: null,
      synced: true,
    });
    expect(noNoteWorkspaceReason(null)).toBe('unknown');
    db.close();
  });

  it('a start is refused with the create-a-workspace ask after a short re-check, not the full wait', async () => {
    const db = emptiedStore();
    const waits: (number | undefined)[] = [];
    const x = workspacesOver(db, async (timeoutMs?: number) => {
      waits.push(timeoutMs);
      return false;
    });
    expect(await x.newNoteWorkspace()).toBeNull();
    expect(await x.newNoteWorkspace(10_000)).toBeNull();
    expect(await x.newNoteWorkspace(10)).toBeNull();
    expect(waits).toEqual([1_500, 1_500, 10]);

    const p = new MeetingPersistence({
      store: () => db,
      userId: () => 'u1',
      sync: { kick() {} },
      workspaceTimeoutMs: 10,
      newNoteWorkspace: (t) => x.newNoteWorkspace(t),
    });
    const refused = await p.prepareMeeting('m1', Date.now()).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(PersistenceError);
    expect((refused as Error).message).toBe(NO_WORKSPACE_MESSAGE);
    expect(db.documents()).toEqual([]);
    expect(db.outboxSize()).toBe(0);
    db.close();
  });

  it('the re-check finds a workspace created meanwhile', async () => {
    const db = emptiedStore();
    const x = workspacesOver(db, async () => {
      db.applyPull(
        {
          changes: [ws('w2', 'Mine', 'owner')],
          cursor: 'c3',
          hasMore: false,
          workspaceIds: ['w2'],
        },
        null,
      );
      return true;
    });
    expect(await x.newNoteWorkspace()).toBe('w2');
    db.close();
  });
});

// Review (step A) #7: a row without my role is "not known yet", not "view-only".
describe('roles not known yet', () => {
  it('says to connect, not that I can only view', () => {
    const db = new LocalStore({ path: ':memory:' });
    db.applyPull(
      { changes: [ws('old', 'Old', null)], cursor: 'c', hasMore: false, workspaceIds: ['old'] },
      null,
    );
    expect(workspacesOver(db).snapshot()).toMatchObject({ activeId: 'old', targetId: null });
    expect(noNoteWorkspaceReason(db)).toBe('unknown');
    expect(noNoteWorkspaceMessage(db)).toBe(CONNECT_ONCE_MESSAGE);
    // Once every role is known and all are view-only, it is.
    db.applyPull(
      {
        changes: [ws('old', 'Old', 'viewer')],
        cursor: 'c2',
        hasMore: false,
        workspaceIds: ['old'],
      },
      'c',
    );
    expect(noNoteWorkspaceReason(db)).toBe('view-only');
    db.close();
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
    const refused = await p.prepareMeeting('m1', Date.now()).catch((e: unknown) => e);
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
    const begin = await p.prepareMeeting('m1', Date.now());
    begin(Date.now());
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
    const begin = await p.prepareMeeting('m1', Date.now());
    begin(Date.now());
    expect(store.document('doc-1')).toMatchObject({
      workspaceId: 'me',
      visibility: 'private',
      ownerId: 'u1',
    });
    w.setActive('board');
    const beginNext = await p.prepareMeeting('m2', Date.now());
    beginNext(Date.now());
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
