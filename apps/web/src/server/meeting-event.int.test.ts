/**
 * Linking a meeting note to a calendar event (`/api/documents/:id/calendar-event`) against a throwaway
 * database, with a fake calendar lookup: the events around the note's time and the linked one, linking
 * (meeting key, platform, the event's attendees added once), unlinking (attendees kept), and the deny cases:
 * only an event the server would list can be linked, viewers and trashed notes get 403, people who can't read
 * the note get 404, anonymous 401, cross-site cookie writes 403, pages 400.
 */
import { findFirstWorkspaceId } from '@oat/auth';
import type { CalendarEvent, CalendarEventInput } from '@oat/core';
import { CalendarEventSchema } from '@oat/core';
import { document, meeting, participant } from '@oat/db';
import type { LinkEventResult, NoteEventCandidatesDto } from '@oat/services/dto/calendar';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DocumentDetail } from '@/lib/api-types';

import {
  BASE,
  call,
  type CallOptions,
  createHarness,
  denies,
  type Harness,
  type TestUser,
} from './api/test-harness';
import type { EventsNear } from './calendar';
import { createMeetingEventApi, type MeetingEventApi } from './meeting-event';

let h: Harness;
let api: MeetingEventApi;
let owner: TestUser;
let member: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let team: string;

/** What each user's (fake) calendar answers, and the times it was asked about. */
const calendars = new Map<string, EventsNear>();
const asked: Date[] = [];

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

const REVIEW = event('google:cal-work/review_1');
const REVIEW_KEY = 'ical:review@oat.test@2026-11-16T19:00:00.000Z';
const STANDUP = event('google:cal-work/standup', {
  title: 'Daily standup',
  icalUid: 'standup@oat.test',
  start: '2026-11-16T17:30:00.000Z',
  end: '2026-11-16T17:45:00.000Z',
  conferenceUrl: null,
  conferenceProvider: null,
  attendees: [],
});

const give = (user: TestUser, ...events: CalendarEvent[]) =>
  calendars.set(user.id, { connected: true, state: 'ok', events });

beforeAll(async () => {
  h = await createHarness();
  api = createMeetingEventApi(
    {
      db: () => h.db,
      getSession: (headers) => h.auth.api.getSession({ headers }),
      allowedOrigins: () => [BASE],
    },
    async (userId, at) => {
      asked.push(at);
      return calendars.get(userId) ?? { connected: false, state: null, events: [] };
    },
  );
  [owner, member, viewer, outsider] = await Promise.all([
    h.signUp('me-owner'),
    h.signUp('me-member'),
    h.signUp('me-viewer'),
    h.signUp('me-outsider'),
  ]);
  team = await h.teamWorkspace(owner, [
    [member, 'member'],
    [viewer, 'viewer'],
  ]);
  give(owner, STANDUP, REVIEW);
  give(member, REVIEW);
  give(viewer, REVIEW);
}, 60_000);

afterAll(async () => {
  await h?.close();
});

async function note(as: TestUser, body: Record<string, unknown> = {}): Promise<DocumentDetail> {
  const res = await call<DocumentDetail>(h.api.documents.POST, 'POST', '/api/documents', {
    as,
    body: { workspaceId: team, kind: 'meeting', title: 'Pilot sync', ...body },
  });
  expect(res.status, JSON.stringify(res.error)).toBe(201);
  return res.body;
}

const path = (id: string) => `/api/documents/${id}/calendar-event`;
const choices = (as: TestUser | null, id: string, opts: Partial<CallOptions> = {}) =>
  call<NoteEventCandidatesDto>(api.event.GET, 'GET', path(id), { as, params: { id }, ...opts });
const link = (as: TestUser | null, id: string, body: unknown, opts: Partial<CallOptions> = {}) =>
  call<LinkEventResult>(api.event.PUT, 'PUT', path(id), { as, body, params: { id }, ...opts });
const unlink = (as: TestUser | null, id: string, opts: Partial<CallOptions> = {}) =>
  call(api.event.DELETE, 'DELETE', path(id), { as, params: { id }, ...opts });

const meetingOf = async (documentId: string) =>
  (await h.db.select().from(meeting).where(eq(meeting.documentId, documentId)))[0];
const peopleOf = async (meetingId: string) =>
  (
    await h.db
      .select({ name: participant.name, email: participant.email, source: participant.source })
      .from(participant)
      .where(eq(participant.meetingId, meetingId))
  ).sort((a, b) => a.name.localeCompare(b.name));

describe('/api/documents/:id/calendar-event', () => {
  it('lists the events around the note’s recording, links one, then unlinks it', async () => {
    const doc = await note(owner);
    const startedAt = new Date('2026-11-16T19:02:00.000Z');
    await h.db.insert(meeting).values({ documentId: doc.id, startedAt, platform: 'zoom' });

    const before = await choices(owner, doc.id);
    expect(before.status, JSON.stringify(before.error)).toBe(200);
    expect(before.body).toMatchObject({
      connected: true,
      state: 'ok',
      linked: false,
      linkedEventId: null,
    });
    expect(before.body.events.map((e) => [e.id, e.title, e.start])).toEqual([
      [STANDUP.id, 'Daily standup', '2026-11-16T17:30:00.000Z'],
      [REVIEW.id, 'Design review', '2026-11-16T19:00:00.000Z'],
    ]);
    // Asked about the recording's time, not now.
    expect(asked.at(-1)).toEqual(startedAt);

    const linked = await link(owner, doc.id, { eventId: REVIEW.id });
    expect(linked.status, JSON.stringify(linked.error)).toBe(200);
    expect(linked.body.calendarEventId).toBe(REVIEW_KEY);
    expect(linked.body.participants.map((p) => [p.name, p.email, p.source])).toEqual(
      expect.arrayContaining([
        ['Jordan Lee', 'jordan@oat.test', 'calendar'],
        ['sam@oat.test', 'sam@oat.test', 'calendar'],
      ]),
    );
    expect(linked.body.participants).toHaveLength(2); // not me
    // The note's own platform is kept (a recording knows better than the invite).
    expect(await meetingOf(doc.id)).toMatchObject({
      calendarEventId: REVIEW_KEY,
      platform: 'zoom',
    });

    const after = await choices(owner, doc.id);
    expect(after.body).toMatchObject({ linked: true, linkedEventId: REVIEW.id });

    // Linking again adds nobody twice.
    const again = await link(owner, doc.id, { eventId: REVIEW.id });
    expect(again.body.participants).toHaveLength(2);

    expect((await unlink(owner, doc.id)).status).toBe(204);
    const meet = await meetingOf(doc.id);
    expect(meet!.calendarEventId).toBeNull();
    // The attendees stay.
    expect(await peopleOf(meet!.id)).toHaveLength(2);
    expect((await choices(owner, doc.id)).body).toMatchObject({
      linked: false,
      linkedEventId: null,
    });
    // Unlinking an unlinked note is fine.
    expect((await unlink(owner, doc.id)).status).toBe(204);
  });

  it('links a note that has no meeting side yet, keeping the attendees it has', async () => {
    const doc = await note(owner);
    expect(await meetingOf(doc.id)).toBeUndefined();
    const linked = await link(owner, doc.id, { eventId: REVIEW.id });
    expect(linked.status, JSON.stringify(linked.error)).toBe(200);
    const meet = await meetingOf(doc.id);
    expect(meet).toMatchObject({ calendarEventId: REVIEW_KEY, platform: 'google_meet' });

    // Someone already on the note (by email, whatever the case) isn't added again.
    const other = await note(owner);
    const [row] = await h.db.insert(meeting).values({ documentId: other.id }).returning();
    await h.db.insert(participant).values({
      meetingId: row!.id,
      name: 'Jordan',
      email: 'Jordan@oat.test',
      source: 'manual',
    });
    expect((await link(owner, other.id, { eventId: REVIEW.id })).status).toBe(200);
    expect(await peopleOf(row!.id)).toEqual([
      { name: 'Jordan', email: 'Jordan@oat.test', source: 'manual' },
      { name: 'sam@oat.test', email: 'sam@oat.test', source: 'calendar' },
    ]);
  });

  it('says a linked event is linked even when the calendar no longer lists it', async () => {
    const doc = await note(owner);
    await h.db.insert(meeting).values({ documentId: doc.id, calendarEventId: 'ical:gone@x@y' });
    expect((await choices(owner, doc.id)).body).toMatchObject({
      linked: true,
      linkedEventId: null,
    });
  });

  it('reports a calendar that isn’t connected, and refuses to link without one', async () => {
    const doc = await note(outsider, {
      workspaceId: await findFirstWorkspaceId(h.db, outsider.id),
    });
    const res = await choices(outsider, doc.id);
    expect(res.body).toEqual({
      connected: false,
      state: null,
      linked: false,
      linkedEventId: null,
      events: [],
    });
    expect((await link(outsider, doc.id, { eventId: REVIEW.id })).status).toBe(404);
  });

  it('deny: anonymous 401, unreadable 404, viewers and trashed notes 403, cross-site 403, unknown events 404, pages 400', async () => {
    denies(
      'GET /api/documents/[id]/calendar-event',
      'PUT /api/documents/[id]/calendar-event',
      'DELETE /api/documents/[id]/calendar-event',
    );
    const shared = await note(owner, { visibility: 'workspace' });
    const secret = await note(owner);
    const body = { eventId: REVIEW.id };

    // Anonymous.
    expect((await choices(null, shared.id)).status).toBe(401);
    expect((await link(null, shared.id, body)).status).toBe(401);
    expect((await unlink(null, shared.id)).status).toBe(401);

    // Can't read the note: 404, whether it exists or not.
    for (const u of [member, viewer, outsider]) {
      expect((await choices(u, secret.id)).status).toBe(404);
      expect((await link(u, secret.id, body)).status).toBe(404);
      expect((await unlink(u, secret.id)).status).toBe(404);
    }
    expect((await link(outsider, shared.id, body)).status).toBe(404);

    // A viewer reads the shared note but can't change (or browse events for) it.
    expect((await choices(viewer, shared.id)).status).toBe(403);
    expect((await link(viewer, shared.id, body)).status).toBe(403);
    expect((await unlink(viewer, shared.id)).status).toBe(403);
    expect(await meetingOf(shared.id)).toBeUndefined();

    // A member who can edit it links from their own calendar only.
    expect((await link(member, shared.id, { eventId: STANDUP.id })).status).toBe(404);
    expect((await link(member, shared.id, body)).status).toBe(200);

    // Cross-site cookie writes.
    expect((await link(owner, shared.id, body, { origin: 'https://evil.test' })).status).toBe(403);
    expect((await unlink(owner, shared.id, { origin: 'https://evil.test' })).status).toBe(403);
    expect((await meetingOf(shared.id))!.calendarEventId).toBe(REVIEW_KEY);

    // Bad input.
    expect((await link(owner, shared.id, {})).status).toBe(400);
    expect((await link(owner, shared.id, { eventId: 'google:nope' })).status).toBe(404);

    // A page has no meeting side.
    const page = await note(owner, { kind: 'page' });
    expect((await choices(owner, page.id)).status).toBe(400);
    expect((await link(owner, page.id, body)).status).toBe(400);

    // Trashed: read-only.
    await h.db.update(document).set({ deletedAt: new Date() }).where(eq(document.id, shared.id));
    expect((await link(owner, shared.id, body)).status).toBe(403);
    expect((await unlink(owner, shared.id)).status).toBe(403);
  });
});
