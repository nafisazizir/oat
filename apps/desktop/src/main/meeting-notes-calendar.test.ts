/**
 * 7.3: meeting notes made from calendar events on the desktop (`MeetingNotes.fromEvent`), found again by the
 * meeting key, recordable before anything was recorded, and the first recording becoming their start.
 */
import { CalendarEventSchema, type CalendarEvent, type CalendarEventInput } from '@oat/core';
import type { SyncDocumentRow } from '@oat/core';
import { LocalStore } from '@oat/local-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MeetingNotes, MeetingNotesError } from './meeting-notes.ts';
import { MeetingPersistence } from './meeting-persistence.ts';

let store: LocalStore;
let user: string | null;
let workspace: string | null;
let kicks: number;
let changes: number;
let calendar: Map<string, CalendarEvent>;
let notes: MeetingNotes;

function event(overrides: Partial<CalendarEventInput> = {}): CalendarEvent {
  return CalendarEventSchema.parse({
    id: 'eventkit:review',
    source: 'eventkit',
    calendar: { id: 'cal-work', title: 'Work', color: '#3B82F6' },
    title: 'Design review',
    start: '2026-11-16T19:00:00.000Z',
    end: '2026-11-16T19:30:00.000Z',
    allDay: false,
    allDayStart: null,
    allDayEnd: null,
    timeZone: null,
    location: null,
    url: null,
    conferenceUrl: 'https://us02web.zoom.us/j/81234567890',
    conferenceProvider: 'zoom',
    status: 'confirmed',
    attendees: [
      { name: 'Me', email: 'me@oat.test', status: 'accepted', isSelf: true, isOrganizer: false },
      {
        name: 'Jordan Lee',
        email: 'jordan@oat.test',
        status: 'accepted',
        isSelf: false,
        isOrganizer: true,
      },
      { name: 'Sam', email: 'sam@oat.test', status: 'accepted', isSelf: false, isOrganizer: false },
    ],
    recurrenceId: null,
    icalUid: 'review@oat.test',
    ...overrides,
  } satisfies CalendarEventInput);
}

const serverDoc = (patch: Partial<SyncDocumentRow>): SyncDocumentRow => ({
  id: 'd-x',
  workspaceId: 'ws',
  folderId: null,
  ownerId: 'u2',
  kind: 'meeting',
  title: 'Theirs',
  contentJson: { type: 'doc', content: [{ type: 'paragraph' }] },
  visibility: 'workspace',
  version: 1,
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
          row: { id: 'ws', name: 'Me', role: 'owner' },
        },
      ],
      cursor: 'c',
      hasMore: false,
      workspaceIds: ['ws'],
    },
    null,
  );
  user = 'u1';
  workspace = 'ws';
  kicks = 0;
  changes = 0;
  calendar = new Map();
  let n = 0;
  notes = new MeetingNotes({
    store: () => store,
    userId: () => user,
    sync: { kick: () => void kicks++ },
    newNoteWorkspace: async () => workspace,
    onChange: () => void changes++,
    calendarEvent: (key) => calendar.get(key) ?? null,
    newId: () => `id-${++n}`,
  });
});
afterEach(() => store.close());

describe('MeetingNotes.fromEvent', () => {
  it('makes a private note with the title, the meeting key and the attendees but me', async () => {
    const review = event();
    const result = await notes.fromEvent(review);
    expect(result).toEqual({ documentId: 'id-2', meetingId: 'id-1', created: true });
    expect(store.meeting('id-1')).toMatchObject({
      documentId: 'id-2',
      calendarEventId: 'ical:review@oat.test@2026-11-16T19:00:00.000Z',
      platform: 'zoom',
      startedAt: null,
      endedAt: null,
    });
    expect(store.document('id-2')).toMatchObject({
      title: 'Design review',
      visibility: 'private',
      ownerId: 'u1',
      workspaceId: 'ws',
    });
    expect(store.participants('id-1').map((p) => [p.name, p.email, p.source])).toEqual([
      ['Jordan Lee', 'jordan@oat.test', 'calendar'],
      ['Sam', 'sam@oat.test', 'calendar'],
    ]);
    expect(kicks).toBe(1);
    expect(changes).toBe(1);

    // The header shows the event (time + join link) while the calendar has it.
    calendar.set('ical:review@oat.test@2026-11-16T19:00:00.000Z', review);
    const note = await notes.get({ documentId: 'id-2' });
    expect(note).toMatchObject({
      title: 'Design review',
      startedAt: null,
      recordedHere: true, // nothing recorded yet: recording here may start it
      calendarEvent: {
        title: 'Design review',
        start: '2026-11-16T19:00:00.000Z',
        end: '2026-11-16T19:30:00.000Z',
        conferenceUrl: 'https://us02web.zoom.us/j/81234567890',
        conferenceProvider: 'zoom',
      },
    });
    expect(note?.participants.every((p) => p.source === 'calendar')).toBe(true);
    expect(await notes.cannotContinue('id-1')).toBeNull();
  });

  it('reopens the note already made for the meeting — also from the other source — and dedupes double clicks', async () => {
    const [a, b] = await Promise.all([notes.fromEvent(event()), notes.fromEvent(event())]);
    expect(a).toEqual(b);
    const google = event({
      id: 'google:cal-work/review',
      source: 'google',
      title: 'Design review (Google copy)',
    });
    expect(await notes.fromEvent(google)).toEqual({ ...a, created: false });
    expect(notes.findByCalendarKeys(['eventkit:review'])).toBeNull(); // keyed by the meeting, not the id
    expect(store.meetingNotes()).toHaveLength(1);
  });

  it('prefers my note, then a teammate’s shared one; trashed notes don’t count', async () => {
    store.applyPull(
      {
        changes: [
          { op: 'upsert', table: 'document', row: serverDoc({ id: 'd-theirs' }) },
          {
            op: 'upsert',
            table: 'meeting',
            row: {
              id: 'm-theirs',
              documentId: 'd-theirs',
              calendarEventId: 'ical:review@oat.test@2026-11-16T19:00:00.000Z',
              startedAt: null,
              endedAt: null,
              platform: null,
              templateId: null,
            },
          },
        ],
        cursor: 'c2',
        hasMore: false,
        workspaceIds: ['ws'],
      },
      'c',
    );
    expect(await notes.fromEvent(event())).toEqual({
      documentId: 'd-theirs',
      meetingId: 'm-theirs',
      created: false,
    });
    // Their never-recorded note isn't recordable here (their Mac may be starting it): D-24.
    expect((await notes.get({ documentId: 'd-theirs' }))?.recordedHere).toBe(false);
    expect(await notes.cannotContinue('m-theirs')).toMatch(/another device/);
    store.applyPull(
      {
        changes: [
          {
            op: 'upsert',
            table: 'document',
            row: serverDoc({ id: 'd-theirs', deletedAt: '2026-11-15T00:00:00.000Z' }),
          },
        ],
        cursor: 'c3',
        hasMore: false,
        workspaceIds: ['ws'],
      },
      'c2',
    );
    const mine = await notes.fromEvent(event());
    expect(mine.created).toBe(true);
    expect(notes.findByCalendarKeys(['ical:review@oat.test@2026-11-16T19:00:00.000Z'])).toBe(
      mine.documentId,
    );
  });

  it('an untitled event gets the default title; no workspace yet is a clear error', async () => {
    const untitled = await notes.fromEvent(event({ title: '', icalUid: null, id: 'eventkit:x' }));
    expect(store.document(untitled.documentId)?.title).toMatch(/^Meeting, Nov 16, /);
    expect(store.meeting(untitled.meetingId)?.calendarEventId).toBe('eventkit:x');
    workspace = null;
    await expect(notes.fromEvent(event({ id: 'eventkit:y', icalUid: 'y@x' }))).rejects.toThrow(
      MeetingNotesError,
    );
  });

  it('the first recording into a calendar note is its start; then it is a recorded note', async () => {
    const { meetingId, documentId } = await notes.fromEvent(event());
    const persistence = new MeetingPersistence({
      store: () => store,
      sync: { kick: () => {} },
      newNoteWorkspace: async () => 'ws',
      userId: () => user,
    });
    const start = Date.parse('2026-11-16T19:02:00.000Z');
    await persistence.prepareMeeting(meetingId, start);
    expect(await notes.cannotContinue(meetingId)).toBeNull();
    persistence.beginMeeting(meetingId, start);
    expect(store.meeting(meetingId)).toMatchObject({
      startedAt: '2026-11-16T19:02:00.000Z',
      endedAt: null,
    });
    store.saveSegment({
      id: 's1',
      meetingId,
      source: 'mic',
      speakerLabel: null,
      startMs: 0,
      endMs: 1000,
      text: 'Hello',
    });
    // Recorded (start set, a transcript) but no audio on this Mac: like a note recorded elsewhere.
    expect((await notes.get({ documentId }))?.recordedHere).toBe(false);
    expect(await notes.cannotContinue(meetingId)).toMatch(/another device/);
    // A second begin (resume) keeps the first start.
    persistence.beginMeeting(meetingId, Date.parse('2026-11-16T19:20:00.000Z'));
    expect(store.meeting(meetingId)?.startedAt).toBe('2026-11-16T19:02:00.000Z');
  });
});
