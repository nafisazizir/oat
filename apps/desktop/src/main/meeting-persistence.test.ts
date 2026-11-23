import { LocalStore } from '@oat/local-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MeetingPersistence, meetingTitle, PersistenceError } from './meeting-persistence.ts';

let store: LocalStore;
let kicks: number;
let workspace: string | null;
let user: string | null;
let p: MeetingPersistence;

beforeEach(() => {
  store = new LocalStore({ path: ':memory:' });
  store.applyPull(
    {
      changes: [
        {
          op: 'upsert',
          table: 'workspace',
          row: { id: 'ws', name: 'Me', role: 'owner' },
        },
      ],
      cursor: 'c',
      hasMore: false,
      workspaceIds: ['ws'],
    },
    null,
  );
  kicks = 0;
  workspace = 'ws';
  user = 'u1';
  let n = 0;
  p = new MeetingPersistence({
    store: () => store,
    userId: () => user,
    newId: () => `doc-${++n}`,
    sync: { kick: () => void kicks++ },
    newNoteWorkspace: async () => workspace,
  });
});
afterEach(() => store.close());

const T0 = Date.parse('2026-11-14T15:04:00Z');
const live = (id: string, text: string, isFinal = true) => ({
  id,
  source: 'mic' as const,
  startMs: 1000.4,
  endMs: 1999.6,
  text,
  isFinal,
});

describe('MeetingPersistence', () => {
  it('creates the meeting + its document once (resuming reuses them)', async () => {
    await p.prepareMeeting('m1', T0);
    expect(store.meeting('m1')?.startedAt).toBeNull();
    p.beginMeeting('m1', T0);
    await p.prepareMeeting('m1', T0 + 60_000);
    p.beginMeeting('m1', T0 + 60_000);
    expect(store.documents()).toHaveLength(1);
    expect(store.meeting('m1')).toMatchObject({
      documentId: 'doc-1',
      startedAt: '2026-11-14T15:04:00.000Z',
    });
    expect(store.document('doc-1')).toMatchObject({
      kind: 'meeting',
      title: meetingTitle(T0),
      ownerId: 'u1',
      workspaceId: 'ws',
    });
    expect(meetingTitle(T0)).toMatch(/^Meeting, Nov 14, /);
    expect(kicks).toBe(2);
  });

  it('refuses without a user or a known workspace', async () => {
    user = null;
    await expect(p.prepareMeeting('m1', T0)).rejects.toBeInstanceOf(PersistenceError);
    user = 'u1';
    workspace = null;
    // My workspaces are on this Mac, but none takes a new note (view-only everywhere): create one (D-36).
    await expect(p.prepareMeeting('m1', T0)).rejects.toThrow(/Create a workspace of your own/);
    expect(store.documents()).toHaveLength(0);
    expect(kicks).toBe(0);
  });

  it('refuses on a database that never synced (no workspace known yet)', async () => {
    const empty = new LocalStore({ path: ':memory:' });
    const fresh = new MeetingPersistence({
      store: () => empty,
      userId: () => 'u1',
      sync: { kick: () => void kicks++ },
      newNoteWorkspace: async () => null,
    });
    await expect(fresh.prepareMeeting('m1', T0)).rejects.toThrow(/connect once/);
    await expect(fresh.prepareMeeting('m1', T0)).rejects.toBeInstanceOf(PersistenceError);
    expect(empty.documents()).toHaveLength(0);
    empty.close();
  });

  it('stores finals (rounded to ms), skips interims, deletes on retraction, kicks only on change', async () => {
    await p.prepareMeeting('m1', T0);
    p.beginMeeting('m1', T0);
    kicks = 0;
    p.saveSegment('m1', live('s1', 'interim', false));
    expect(store.segments('m1')).toHaveLength(0);
    p.saveSegment('m1', live('s1', 'final words'));
    expect(store.segments('m1')).toEqual([
      {
        id: 's1',
        meetingId: 'm1',
        source: 'mic',
        speakerLabel: null,
        startMs: 1000,
        endMs: 2000,
        text: 'final words',
      },
    ]);
    p.saveSegment('m1', live('s1', 'final words'));
    expect(kicks).toBe(1);
    p.saveSegment('m1', live('s1', ''));
    expect(store.segments('m1')).toHaveLength(0);
    expect(kicks).toBe(2);
    p.saveSegment('m1', live('nope', '')); // retraction of something never stored
    expect(kicks).toBe(2);
  });

  it('stamps the end of the meeting', async () => {
    await p.prepareMeeting('m1', T0);
    p.beginMeeting('m1', T0);
    p.endMeeting('m1', T0 + 120_000);
    expect(store.meeting('m1')!.endedAt).toBe('2026-11-14T15:06:00.000Z');
    p.endMeeting('unknown', T0);
  });
});
