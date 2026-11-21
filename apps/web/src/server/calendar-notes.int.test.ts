/**
 * Meeting notes from calendar events on the web (7.3): `POST /api/calendar/notes {eventId, workspaceId}`
 * against a throwaway database, with a fake calendar lookup. Prefill (title, attendees as `calendar`
 * participants, the meeting key), reuse of the note already made for the meeting (also the desktop's EventKit
 * copy of the same invite), one note per double click, and the deny cases: viewers can't create, another
 * member's private note for the same meeting is never handed out, unknown events 404, anonymous 401.
 */
import { findFirstWorkspaceId } from '@oat/auth';
import type { CalendarEvent, CalendarEventInput } from '@oat/core';
import { CalendarEventSchema } from '@oat/core';
import { document, meeting, membership, participant, workspace } from '@oat/db';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BASE, call, createHarness, denies, type Harness, type TestUser } from './api/test-harness';
import { createCalendarNotesApi } from './calendar-notes';

let h: Harness;
let api: ReturnType<typeof createCalendarNotesApi>;
let owner: TestUser;
let member: TestUser;
let viewer: TestUser;
let team: string;

/** Events each user's (fake) calendar has, by id. */
const calendars = new Map<string, Map<string, CalendarEvent>>();

function event(id: string, overrides: Partial<CalendarEventInput> = {}): CalendarEvent {
  return CalendarEventSchema.parse({
    id,
    source: 'google',
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
    conferenceUrl: 'https://meet.google.com/abc-defg-hij',
    conferenceProvider: 'google_meet',
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
      { name: null, email: 'sam@oat.test', status: 'tentative', isSelf: false, isOrganizer: false },
    ],
    recurrenceId: null,
    icalUid: 'review@oat.test',
    ...overrides,
  } satisfies CalendarEventInput);
}

function give(user: TestUser, ...events: CalendarEvent[]) {
  const map = calendars.get(user.id) ?? new Map<string, CalendarEvent>();
  for (const e of events) map.set(e.id, e);
  calendars.set(user.id, map);
}

/** The workspace made for the user at sign-up (their oldest membership). */
async function ownWorkspace(user: TestUser): Promise<string> {
  return (await findFirstWorkspaceId(h.db, user.id))!;
}

const start = (as: TestUser | null, body: unknown, opts: { origin?: string | null } = {}) =>
  call<{ documentId: string; created: boolean }>(api.notes.POST, 'POST', '/api/calendar/notes', {
    as,
    body,
    ...opts,
  });

beforeAll(async () => {
  h = await createHarness();
  api = createCalendarNotesApi(
    {
      db: () => h.db,
      getSession: (headers) => h.auth.api.getSession({ headers }),
      allowedOrigins: () => [BASE],
    },
    async (userId, eventId) => calendars.get(userId)?.get(eventId) ?? null,
  );
  [owner, member, viewer] = await Promise.all([
    h.signUp('cn-owner'),
    h.signUp('cn-member'),
    h.signUp('cn-viewer'),
  ]);
  team = await h.teamWorkspace(owner, [
    [member, 'member'],
    [viewer, 'viewer'],
  ]);
}, 60_000);

afterAll(async () => {
  await h?.close();
});

describe('POST /api/calendar/notes', () => {
  it('makes a private meeting note from the event, then reopens it', async () => {
    const review = event('google:cal-work/review_1');
    give(owner, review);
    const ws = await ownWorkspace(owner);
    const first = await start(owner, { eventId: review.id, workspaceId: ws });
    expect(first.status, JSON.stringify(first.error)).toBe(201);
    expect(first.body.created).toBe(true);

    const [doc] = await h.db.select().from(document).where(eq(document.id, first.body.documentId));
    expect(doc).toMatchObject({
      kind: 'meeting',
      title: 'Design review',
      visibility: 'private',
      ownerId: owner.id,
      workspaceId: ws,
      folderId: null,
    });
    const [meet] = await h.db.select().from(meeting).where(eq(meeting.documentId, doc!.id));
    expect(meet).toMatchObject({
      calendarEventId: 'ical:review@oat.test@2026-11-16T19:00:00.000Z',
      platform: 'google_meet',
      startedAt: null,
      endedAt: null,
    });
    const people = await h.db
      .select({ name: participant.name, email: participant.email, source: participant.source })
      .from(participant)
      .where(eq(participant.meetingId, meet!.id))
      .orderBy(asc(participant.createdAt), asc(participant.id));
    expect(people).toEqual(
      expect.arrayContaining([
        { name: 'Jordan Lee', email: 'jordan@oat.test', source: 'calendar' },
        { name: 'sam@oat.test', email: 'sam@oat.test', source: 'calendar' },
      ]),
    );
    expect(people).toHaveLength(2); // not me

    const again = await start(owner, { eventId: review.id, workspaceId: ws });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ documentId: first.body.documentId, created: false });
  });

  it('finds the note the desktop made from the same invite (EventKit id, same meeting key)', async () => {
    const ws = await ownWorkspace(owner);
    const [doc] = await h.db
      .insert(document)
      .values({ workspaceId: ws, ownerId: owner.id, kind: 'meeting', title: 'From the Mac' })
      .returning();
    await h.db.insert(meeting).values({
      documentId: doc!.id,
      calendarEventId: 'ical:standup@oat.test@2026-11-17T17:30:00.000Z',
    });
    const standup = event('google:cal-work/standup_20261117T173000Z', {
      title: 'Daily standup',
      icalUid: 'standup@oat.test',
      start: '2026-11-17T17:30:00.000Z',
      end: '2026-11-17T17:45:00.000Z',
    });
    give(owner, standup);
    const res = await start(owner, { eventId: standup.id, workspaceId: ws });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ documentId: doc!.id, created: false });
  });

  it('a double click makes one note', async () => {
    const lunch = event('google:cal-work/lunch', { icalUid: 'lunch@oat.test', title: 'Lunch' });
    give(owner, lunch);
    const ws = await ownWorkspace(owner);
    const [a, b] = await Promise.all([
      start(owner, { eventId: lunch.id, workspaceId: ws }),
      start(owner, { eventId: lunch.id, workspaceId: ws }),
    ]);
    expect(a.body.documentId).toBe(b.body.documentId);
    expect([a.body.created, b.body.created].sort()).toEqual([false, true]);
  });

  it('reuses a teammate’s shared note for the meeting, never their private one', async () => {
    denies('POST /api/calendar/notes');
    const planning = event('google:cal-team/planning', {
      icalUid: 'planning@oat.test',
      title: 'Planning',
    });
    give(owner, planning);
    give(member, planning);
    // The owner's private note in the team workspace: invisible to the member.
    const mine = await start(owner, { eventId: planning.id, workspaceId: team });
    expect(mine.status).toBe(201);
    const theirs = await start(member, { eventId: planning.id, workspaceId: team });
    expect(theirs.status).toBe(201);
    expect(theirs.body.documentId).not.toBe(mine.body.documentId);
    const [doc] = await h.db.select().from(document).where(eq(document.id, theirs.body.documentId));
    expect(doc!.ownerId).toBe(member.id);

    // Shared with the workspace: a third teammate (even a viewer, who can't create) joins it.
    await h.db
      .update(document)
      .set({ visibility: 'workspace' })
      .where(eq(document.id, mine.body.documentId));
    give(viewer, planning);
    const joined = await start(viewer, { eventId: planning.id, workspaceId: team });
    expect(joined.status).toBe(200);
    expect(joined.body).toEqual({ documentId: mine.body.documentId, created: false });
  });

  it('refuses viewers, other workspaces, unknown events, anonymous and cross-site callers', async () => {
    denies('POST /api/calendar/notes');
    const retro = event('google:cal-team/retro', { icalUid: 'retro@oat.test', title: 'Retro' });
    give(viewer, retro);
    give(member, retro);
    const viewerNote = await start(viewer, { eventId: retro.id, workspaceId: team });
    expect(viewerNote.status).toBe(403);
    const ownerWs = await ownWorkspace(owner);
    const elsewhere = await start(member, { eventId: retro.id, workspaceId: ownerWs });
    expect([403, 404]).toContain(elsewhere.status);
    // Someone else's event id: their calendar, not mine.
    const notMine = await start(owner, { eventId: retro.id, workspaceId: ownerWs });
    expect(notMine.status).toBe(404);
    expect((await start(null, { eventId: retro.id, workspaceId: team })).status).toBe(401);
    expect(
      (
        await start(
          member,
          { eventId: retro.id, workspaceId: team },
          { origin: 'https://evil.example' },
        )
      ).status,
    ).toBe(403);
    expect((await start(member, { eventId: '', workspaceId: team })).status).toBe(400);
    const notes = await h.db
      .select({ id: meeting.id })
      .from(meeting)
      .where(eq(meeting.calendarEventId, 'ical:retro@oat.test@2026-11-16T19:00:00.000Z'));
    expect(notes).toHaveLength(0);
  });
});
