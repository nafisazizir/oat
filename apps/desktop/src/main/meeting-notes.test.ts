import type { SyncDocumentRow } from '@oat/core';
import { LocalStore } from '@oat/local-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MeetingNotes, MeetingNotesError } from './meeting-notes.ts';

let store: LocalStore;
let open: boolean;
let user: string | null;
let kicks: number;
let changes: number;
let notes: MeetingNotes;

const serverDoc = (patch: Partial<SyncDocumentRow>): SyncDocumentRow => ({
  id: 'd-x',
  workspaceId: 'ws',
  folderId: null,
  ownerId: 'u2',
  kind: 'meeting',
  title: 'Theirs',
  contentJson: { type: 'doc', content: [{ type: 'paragraph' }] },
  visibility: 'private',
  version: 3,
  createdAt: '2026-11-14T09:00:00.000Z',
  updatedAt: '2026-11-14T09:00:00.000Z',
  deletedAt: null,
  conflictOfId: null,
  conflictDevice: null,
  conflictAt: null,
  ...patch,
});

beforeEach(() => {
  store = new LocalStore({ path: ':memory:' });
  store.applyPull(
    {
      changes: [
        {
          op: 'upsert',
          table: 'workspace',
          row: { id: 'ws', name: 'Team', role: 'member' },
        },
        // A teammate's note shared with the workspace, a private one (can't be here normally, but the
        // rule must hold), a trashed one, and a page.
        {
          op: 'upsert',
          table: 'document',
          row: serverDoc({ id: 'd-shared', visibility: 'workspace' }),
        },
        { op: 'upsert', table: 'document', row: serverDoc({ id: 'd-private' }) },
        {
          op: 'upsert',
          table: 'document',
          row: serverDoc({ id: 'd-trash', ownerId: 'u1', deletedAt: '2026-11-14T10:00:00.000Z' }),
        },
        { op: 'upsert', table: 'document', row: serverDoc({ id: 'd-page', kind: 'page' }) },
      ],
      cursor: 'c',
      hasMore: false,
      workspaceIds: ['ws'],
    },
    null,
  );
  store.createMeeting({
    meetingId: 'm1',
    documentId: 'd1',
    workspaceId: 'ws',
    ownerId: 'u1',
    title: 'Standup',
    startedAt: '2026-11-14T15:04:00.000Z',
  });
  store.saveSegment({
    id: 's2',
    meetingId: 'm1',
    source: 'system',
    speakerLabel: null,
    startMs: 4000,
    endMs: 5000,
    text: 'Second',
  });
  store.saveSegment({
    id: 's1',
    meetingId: 'm1',
    source: 'mic',
    speakerLabel: null,
    startMs: 1000,
    endMs: 2000,
    text: 'First',
  });
  open = true;
  user = 'u1';
  kicks = 0;
  changes = 0;
  let n = 0;
  notes = new MeetingNotes({
    store: () => (open ? store : null),
    userId: () => user,
    sync: { kick: () => void kicks++ },
    onChange: () => void changes++,
    newId: () => `p-${++n}`,
  });
});
afterEach(() => store.close());

describe('MeetingNotes', () => {
  it('marks pending local notes and exposes updated timestamps without marking pulled notes pending', () => {
    const list = notes.list();
    expect(list.find((note) => note.documentId === 'd1')).toMatchObject({
      pending: true,
      updatedAt: store.document('d1')!.updatedAt,
    });
    expect(list.find((note) => note.documentId === 'd-shared')).toMatchObject({
      pending: false,
      updatedAt: store.document('d-shared')!.updatedAt,
    });
  });
  it('lists meeting notes, newest first; nothing while signed out or closed', () => {
    expect(notes.list().map((n) => [n.documentId, n.meetingId, n.title])).toEqual([
      ['d1', 'm1', 'Standup'],
      ['d-shared', null, 'Theirs'],
    ]);
    user = null;
    expect(notes.list()).toEqual([]);
    user = 'u1';
    open = false;
    expect(notes.list()).toEqual([]);
  });

  it('says whose each note is and never lists someone else’s private note (D-36)', () => {
    const list = notes.list();
    // What the sidebar splits on: mine and private → Private; a teammate's shared note → Shared.
    expect(list.map((n) => [n.documentId, n.ownerId, n.visibility])).toEqual([
      ['d1', 'u1', 'private'],
      ['d-shared', 'u2', 'workspace'],
    ]);
    // `d-private` is a teammate's private note that should never have been synced here: not listed.
    expect(store.meetingNotes().some((n) => n.documentId === 'd-private')).toBe(true);
    expect(list.some((n) => n.documentId === 'd-private')).toBe(false);
  });

  it('opens a note by document or by meeting id, with workspace and edit rights', async () => {
    const byDoc = await notes.get({ documentId: 'd1' });
    expect(byDoc).toMatchObject({
      documentId: 'd1',
      meetingId: 'm1',
      workspaceName: 'Team',
      title: 'Standup',
      editable: true,
      recordedHere: false,
      trashed: false,
      startedAt: '2026-11-14T15:04:00.000Z',
      endedAt: null,
      participants: [],
    });
    expect(await notes.get({ meetingId: 'm1' })).toEqual(byDoc);
    expect(await notes.get({ documentId: 'd-shared' })).toMatchObject({
      editable: true,
      meetingId: null,
    });
    expect((await notes.get({ documentId: 'd-private' }))?.editable).toBe(false);
    expect(await notes.get({ documentId: 'd-trash' })).toMatchObject({
      editable: false,
      trashed: true,
    });
    expect(await notes.get({ documentId: 'd-page' })).toBeNull();
    expect(await notes.get({ documentId: 'nope' })).toBeNull();
    expect(await notes.get({ meetingId: 'nope' })).toBeNull();
  });

  it('reads the stored transcript in time order', () => {
    expect(notes.transcript('d1')).toEqual([
      { id: 's1', source: 'mic', speaker: null, startMs: 1000, endMs: 2000, text: 'First' },
      { id: 's2', source: 'system', speaker: null, startMs: 4000, endMs: 5000, text: 'Second' },
    ]);
    expect(notes.transcript('d-shared')).toEqual([]);
    expect(() => notes.transcript('d-page')).toThrow(MeetingNotesError);
  });

  it('autosaves notes and titles into the outbox; only titles announce a change', () => {
    const before = store.outboxSize();
    const content = {
      type: 'doc' as const,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Ship it' }] }],
    };
    const base = { title: 'Standup', contentJson: store.document('d1')!.contentJson };
    expect(notes.save('d1', base, { contentJson: content }).conflict).toBeNull();
    expect(store.document('d1')?.contentJson).toEqual(content);
    expect(kicks).toBe(1);
    expect(changes).toBe(0);
    notes.save('d1', { title: 'Standup', contentJson: content }, { title: '  Weekly   sync ' });
    expect(store.document('d1')?.title).toBe('Weekly sync');
    expect(changes).toBe(1);
    // Saving the same again is a no-op (nothing queued, nothing announced).
    notes.save(
      'd1',
      { title: 'Weekly sync', contentJson: content },
      {
        title: 'Weekly sync',
        contentJson: content,
      },
    );
    expect(kicks).toBe(2);
    expect(store.outbox().filter((e) => e.table === 'document')).toHaveLength(1);
    expect(store.outboxSize()).toBe(before);
  });

  it('refuses edits of notes I can’t edit, and missing notes', () => {
    const base = { title: 'Theirs', contentJson: { type: 'doc' as const } };
    expect(() => notes.save('d-private', base, { title: 'x' })).toThrow(
      'You can’t edit this note.',
    );
    expect(() => notes.save('d-trash', base, { title: 'x' })).toThrow('You can’t edit this note.');
    expect(() => notes.save('nope', base, { title: 'x' })).toThrow('This note isn’t on this Mac.');
    open = false;
    expect(() => notes.save('d1', base, { title: 'x' })).toThrow(/aren’t available/);
  });

  it('a pull that lands between typing and saving is never overwritten: my edit becomes a conflicted copy', () => {
    const para = (text: string) => ({
      type: 'doc' as const,
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    });
    // A teammate's shared note, fully synced (nothing waiting in the outbox). The editor opened it as it was…
    const base = { title: 'Theirs', contentJson: store.document('d-shared')!.contentJson };
    // …while I typed (still in the autosave debounce), sync pulled a teammate's edit of the note.
    store.applyPull(
      {
        changes: [
          {
            op: 'upsert',
            table: 'document',
            row: serverDoc({
              id: 'd-shared',
              visibility: 'workspace',
              title: 'Theirs',
              contentJson: para('Edited on the web'),
              version: 4,
              updatedAt: '2026-11-14T15:10:00.000Z',
            }),
          },
        ],
        cursor: 'c2',
        hasMore: false,
        workspaceIds: ['ws'],
      },
      'c',
    );
    const result = notes.save('d-shared', base, { contentJson: para('Typed on this Mac') });
    // The newer note stays as it is…
    expect(store.document('d-shared')).toMatchObject({
      contentJson: para('Edited on the web'),
      version: 4,
    });
    // …and my text is kept as a private page, queued for the server.
    expect(result.conflict).toEqual({
      documentId: expect.any(String),
      title: 'Theirs (conflicted copy)',
    });
    const copy = store.document(result.conflict!.documentId)!;
    expect(copy).toMatchObject({
      kind: 'page',
      visibility: 'private',
      ownerId: 'u1',
      conflictOfId: 'd-shared', // a 3.5 conflicted copy: listed, comparable, resolvable
    });
    expect(copy.contentJson).toEqual(para('Typed on this Mac'));
    expect(store.outbox().some((e) => e.rowId === copy.id)).toBe(true);
    expect(changes).toBe(1);

    // Building on the newer note again is a normal save.
    const next = notes.save(
      'd-shared',
      { title: 'Theirs', contentJson: para('Edited on the web') },
      { contentJson: para('Edited on the web, then here') },
    );
    expect(next.conflict).toBeNull();
    expect(store.document('d-shared')?.contentJson).toEqual(para('Edited on the web, then here'));
  });

  it('my own save coming back normalised (key order, block ids) is not a conflict', () => {
    const typed = {
      type: 'doc' as const,
      content: [{ type: 'paragraph', content: [{ text: 'Hi', type: 'text' }] }],
    };
    notes.save(
      'd1',
      { title: 'Standup', contentJson: store.document('d1')!.contentJson },
      {
        contentJson: typed,
      },
    );
    // Pushed and acknowledged: the server's copy (same text, keys reordered, a block id) replaces the row.
    const sent = store.takePushBatch(100);
    store.applyPushResults(
      sent,
      sent.map((e) => ({ version: e.version, status: 'ok' as const })),
    );
    const normalised = {
      type: 'doc' as const,
      content: [
        { type: 'paragraph', attrs: { id: 'b1' }, content: [{ type: 'text', text: 'Hi' }] },
      ],
    };
    store.applyPull(
      {
        changes: [
          {
            op: 'upsert',
            table: 'document',
            row: serverDoc({ id: 'd-shared', visibility: 'workspace', contentJson: normalised }),
          },
        ],
        cursor: 'c3',
        hasMore: false,
        workspaceIds: ['ws'],
      },
      'c',
    );
    const result = notes.save(
      'd1',
      { title: 'Standup', contentJson: typed },
      {
        contentJson: { ...typed, content: [...typed.content, { type: 'paragraph' }] },
      },
    );
    expect(result.conflict).toBeNull();
    expect(
      store.documents().filter((d) => d.kind === 'page' && d.title.endsWith('(conflicted copy)')),
    ).toEqual([]);
  });

  it('continuing a recording: only editable notes whose audio is on this Mac', async () => {
    expect(await notes.cannotContinue('m1')).toMatch(/recorded on another device/);
    const here = new MeetingNotes({
      store: () => store,
      userId: () => 'u1',
      sync: { kick: () => {} },
      onChange: () => {},
      hasAudio: async (id) => id === 'm1',
    });
    expect(await here.cannotContinue('m1')).toBeNull();
    expect((await here.get({ documentId: 'd1' }))?.recordedHere).toBe(true);
    expect(await here.cannotContinue('nope')).toMatch(/isn’t on this Mac/);
    // Not mine to edit (as another user): refused even with the audio here.
    const asOther = new MeetingNotes({
      store: () => store,
      userId: () => 'u9',
      sync: { kick: () => {} },
      onChange: () => {},
      hasAudio: async () => true,
    });
    expect(await asOther.cannotContinue('m1')).toMatch(/can’t add/);
  });

  it('adds and removes participants (synced)', async () => {
    const p = notes.addParticipant('d1', { name: ' Ada Lovelace ', email: 'Ada@Example.com ' });
    expect(p).toEqual({
      id: 'p-1',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      source: 'manual',
    });
    expect((await notes.get({ documentId: 'd1' }))?.participants).toEqual([p]);
    expect(store.outbox().some((e) => e.table === 'participant' && e.rowId === 'p-1')).toBe(true);
    expect(changes).toBe(1);
    expect(() => notes.removeParticipant('d1', 'other')).toThrow(MeetingNotesError);
    notes.removeParticipant('d1', 'p-1');
    expect((await notes.get({ documentId: 'd1' }))?.participants).toEqual([]);
    expect(store.outbox().find((e) => e.rowId === 'p-1')?.op).toBe('delete');
    expect(changes).toBe(2);
    // A note without a recording (made on the web) gets attendees on the web.
    expect(() => notes.addParticipant('d-shared', { name: 'X', email: null })).toThrow(
      /on the web/,
    );
  });
});
