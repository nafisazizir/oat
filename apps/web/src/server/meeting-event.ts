import 'server-only';

import { calendarEventKey, notePrefill } from '@oat/calendar';
import { type Db, meeting, participant } from '@oat/db';
import type { LinkEventResult, NoteEventCandidates } from '@oat/services/dto/calendar';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Actor } from './actor';
import { forbidden, notFound } from './api/errors';
import { type ApiDeps, apiRoute, readJson } from './api/route';
import type { EventsNear } from './calendar';
import { MAX_PARTICIPANTS, meetingNote, toParticipant } from './meeting';

/*
 * Linking a meeting note to a calendar event after the fact (the header's date pill): the events of the
 * user's own connected calendar around the note's time, and setting / clearing `meeting.calendar_event_id`.
 *
 *   GET    /api/documents/:id/calendar-event              NoteEventCandidates
 *   PUT    /api/documents/:id/calendar-event { eventId }  LinkEventResult
 *   DELETE /api/documents/:id/calendar-event              204
 *
 * The server reads the event itself (never trusts a title or attendees sent by the browser) and only links
 * one of the candidates it would list. Linking stores the meeting key (`calendarEventKey`, as "Start notes"
 * does), fills `platform` when the note has none, and adds the event's attendees the note doesn't have yet
 * (source `calendar`); the title and body are left alone. Unlinking clears the key and keeps the attendees.
 *
 * Authz: all three need to edit the note (`access.edit`: `@oat/core` `canEditDocument`; a note the actor
 * can't read is a 404, a viewer or a trashed note a 403).
 */

/** The actor's events around a time (`listEventsNear`); injected so int tests use a fake calendar. */
export type EventsNearLookup = (userId: string, at: Date) => Promise<EventsNear>;

const LinkEventBody = z.strictObject({ eventId: z.string().min(1).max(1024) });

async function editableMeetingNote(db: Db, actor: Actor, documentId: string) {
  const doc = await meetingNote(db, actor, documentId);
  if (!doc.access.edit) throw forbidden('You can’t edit this note.');
  const [meet] = await db
    .select({
      id: meeting.id,
      startedAt: meeting.startedAt,
      calendarEventId: meeting.calendarEventId,
    })
    .from(meeting)
    .where(eq(meeting.documentId, doc.id));
  return { doc, meet: meet ?? null };
}

/** When the note's meeting happened: its recording's start, else now (a note not recorded yet). */
const noteTime = (meet: { startedAt: Date | null } | null) => meet?.startedAt ?? new Date();

export async function noteEventCandidates(
  db: Db,
  actor: Actor,
  documentId: string,
  near: EventsNearLookup,
): Promise<NoteEventCandidates> {
  const { meet } = await editableMeetingNote(db, actor, documentId);
  const found = await near(actor.userId, noteTime(meet));
  const key = meet?.calendarEventId ?? null;
  return {
    connected: found.connected,
    state: found.state,
    linked: key !== null,
    linkedEventId:
      (key && found.events.find((e) => calendarEventKey(e) === key || e.id === key)?.id) || null,
    events: found.events,
  };
}

export async function linkNoteEvent(
  db: Db,
  actor: Actor,
  documentId: string,
  eventId: string,
  near: EventsNearLookup,
): Promise<LinkEventResult> {
  const { doc, meet } = await editableMeetingNote(db, actor, documentId);
  const event = (await near(actor.userId, noteTime(meet))).events.find((e) => e.id === eventId);
  if (!event) throw notFound('Event');
  const prefill = notePrefill(event);
  return db.transaction(async (tx) => {
    // A note made on the web has no meeting row until it needs one (one per document: unique index).
    await tx.insert(meeting).values({ documentId: doc.id }).onConflictDoNothing({
      target: meeting.documentId,
    });
    const [row] = await tx
      .select({ id: meeting.id, platform: meeting.platform })
      .from(meeting)
      .where(eq(meeting.documentId, doc.id))
      .for('update');
    await tx
      .update(meeting)
      .set({
        calendarEventId: prefill.calendarEventKey,
        platform: row!.platform ?? event.conferenceProvider,
      })
      .where(eq(meeting.id, row!.id));

    const people = () =>
      tx
        .select({
          id: participant.id,
          name: participant.name,
          email: participant.email,
          source: participant.source,
        })
        .from(participant)
        .where(eq(participant.meetingId, row!.id))
        .orderBy(asc(participant.createdAt), asc(participant.id));
    const existing = await people();
    const emails = new Set(existing.flatMap((p) => (p.email ? [p.email.toLowerCase()] : [])));
    const names = new Set(existing.map((p) => p.name.toLowerCase()));
    const fresh = prefill.participants
      .filter((p) => (p.email ? !emails.has(p.email) : !names.has(p.name.toLowerCase())))
      .slice(0, Math.max(0, MAX_PARTICIPANTS - existing.length));
    if (fresh.length > 0) {
      await tx.insert(participant).values(
        fresh.map((p) => ({
          meetingId: row!.id,
          name: p.name,
          email: p.email,
          source: 'calendar' as const,
        })),
      );
    }
    return {
      calendarEventId: prefill.calendarEventKey,
      participants: (fresh.length > 0 ? await people() : existing).map(toParticipant),
    };
  });
}

export async function unlinkNoteEvent(db: Db, actor: Actor, documentId: string): Promise<void> {
  const { meet } = await editableMeetingNote(db, actor, documentId);
  if (!meet?.calendarEventId) return;
  await db.update(meeting).set({ calendarEventId: null }).where(eq(meeting.id, meet.id));
}

type IdParams = { id: string };

/** `/api/documents/[id]/calendar-event`. */
export function createMeetingEventApi(deps: ApiDeps, near: EventsNearLookup) {
  return {
    event: {
      GET: apiRoute<IdParams>(deps, async ({ db, actor, params }) => {
        const result = await noteEventCandidates(db, actor, params.id, near);
        return Response.json(result, { headers: { 'cache-control': 'private, no-store' } });
      }),
      PUT: apiRoute<IdParams>(deps, async ({ db, actor, params, request }) => {
        const { eventId } = await readJson(request, LinkEventBody);
        return linkNoteEvent(db, actor, params.id, eventId, near);
      }),
      DELETE: apiRoute<IdParams>(deps, async ({ db, actor, params }) =>
        unlinkNoteEvent(db, actor, params.id),
      ),
    },
  };
}

export type MeetingEventApi = ReturnType<typeof createMeetingEventApi>;
