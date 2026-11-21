import 'server-only';

import { notePrefill } from '@oat/calendar';
import { type CalendarEvent, canReadDocument } from '@oat/core';
import { type Db, document, meeting, participant } from '@oat/db';
import { emptyDoc } from '@oat/editor';
import type { StartNotesResult } from '@oat/services/dto/calendar';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Actor } from './actor';
import { notFound } from './api/errors';
import { type ApiDeps, apiRoute, readJson } from './api/route';
import { normalizeTitle, prepareContent } from './documents';
import { workspaceForCreate } from './folders';

/*
 * Meeting notes from calendar events on the web (7.3): Home → Upcoming → "Start notes". The server reads the
 * event itself from the user's connected calendar (never trusts a title or attendees sent by the browser),
 * then returns the note already made for that meeting — mine first, else one shared with me — or makes a new
 * private one in the chosen workspace: the event's title, `meeting.calendar_event_id` = the meeting key
 * (`calendarEventKey`: iCal UID + start, so the desktop's EventKit copy of the same invite finds it too) and
 * the attendees (source `calendar`). Nothing is recorded: `started_at` stays empty until a desktop records.
 *
 * Authz: creating = `workspaceForCreate` (member, not a viewer: `@oat/core` `createInWorkspace`); reusing =
 * `canReadDocument` on the existing note (another member's private note for the same meeting is never
 * returned). One creation per user and meeting at a time (advisory lock), so a double click makes one note.
 */

export type FindCalendarEvent = (userId: string, eventId: string) => Promise<CalendarEvent | null>;

const StartNotesInput = z.strictObject({
  eventId: z.string().min(1).max(1024),
  workspaceId: z.string().min(1).max(100),
});

export type { StartNotesResult } from '@oat/services/dto/calendar';

export async function startNotesFromEvent(
  db: Db,
  actor: Actor,
  event: CalendarEvent,
  workspaceId: string,
): Promise<StartNotesResult> {
  const prefill = notePrefill(event);
  const keys = [...new Set([prefill.calendarEventKey, event.id])];
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`calendar-notes|${actor.userId}|${prefill.calendarEventKey}`}, 0))`,
    );
    const candidates = await tx
      .select({ doc: document })
      .from(meeting)
      .innerJoin(document, eq(document.id, meeting.documentId))
      .where(
        and(
          inArray(meeting.calendarEventId, keys),
          eq(document.kind, 'meeting'),
          isNull(document.deletedAt),
        ),
      );
    const readable = candidates.map((c) => c.doc).filter((d) => canReadDocument(actor.ctx, d));
    const existing = readable.find((d) => d.ownerId === actor.userId) ?? readable[0];
    if (existing) return { documentId: existing.id, created: false };

    const ws = await workspaceForCreate(tx, actor, workspaceId);
    const [doc] = await tx
      .insert(document)
      .values({
        workspaceId: ws.id,
        folderId: null,
        ownerId: actor.userId,
        kind: 'meeting',
        title: normalizeTitle(prefill.title),
        visibility: 'private',
        ...prepareContent(emptyDoc()),
      })
      .returning({ id: document.id });
    const [meet] = await tx
      .insert(meeting)
      .values({
        documentId: doc!.id,
        calendarEventId: prefill.calendarEventKey,
        platform: event.conferenceProvider,
      })
      .returning({ id: meeting.id });
    if (prefill.participants.length > 0) {
      await tx.insert(participant).values(
        prefill.participants.map((p) => ({
          meetingId: meet!.id,
          name: p.name,
          email: p.email,
          source: 'calendar' as const,
        })),
      );
    }
    return { documentId: doc!.id, created: true };
  });
}

/** `POST /api/calendar/notes {eventId, workspaceId}` → 201 `{documentId, created: true}` / 200 reused. */
export function createCalendarNotesApi(deps: ApiDeps, findEvent: FindCalendarEvent) {
  return {
    notes: {
      POST: apiRoute(deps, async ({ db, actor, request }) => {
        const input = await readJson(request, StartNotesInput);
        const event = await findEvent(actor.userId, input.eventId);
        if (!event) throw notFound('Event');
        const result = await startNotesFromEvent(db, actor, event, input.workspaceId);
        return Response.json(result, {
          status: result.created ? 201 : 200,
          headers: { 'cache-control': 'no-store' },
        });
      }),
    },
  };
}
