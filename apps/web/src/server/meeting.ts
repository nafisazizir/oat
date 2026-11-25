import 'server-only';

import { type Db, meeting, participant, transcriptSegment } from '@oat/db';
import { and, asc, count, eq, max } from 'drizzle-orm';
import { z } from 'zod';

import type { MeetingInfo, MeetingParticipant } from '@/lib/meeting';

import type { Actor } from './actor';
import { badRequest, forbidden, notFound } from './api/errors';
import { type ApiDeps, apiRoute, readJson } from './api/route';
import { getDocument } from './documents';
import { transcriptLines } from './transcript';

/*
 * The meeting side of a meeting note (3.4): its times and attendees for the document page's header, and the
 * participants API. Read access = the note's (`getDocument`: 404 when the actor can't read it, no existence
 * leak); changing attendees = editing the note (`access.edit`: `@oat/core` `canEditDocument`, so viewers and
 * trashed notes are refused with 403). Attendees sync to the desktop through `change_log` (D-22), like
 * anything else.
 */

/** Most attendees one meeting can have (a calendar invite to a whole company stays usable). */
export const MAX_PARTICIPANTS = 300;

const ParticipantInput = z.strictObject({
  name: z.string().trim().max(200).default(''),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(320)
    .pipe(z.union([z.literal(''), z.email()]))
    .nullish(),
});

export function toParticipant(row: {
  id: string;
  name: string;
  email: string | null;
  source: 'calendar' | 'manual';
}): MeetingParticipant {
  return { id: row.id, name: row.name, email: row.email, source: row.source };
}

/** A meeting note the actor can read, else 404; a page is a 400 (it has no meeting side). */
export async function meetingNote(db: Db, actor: Actor, documentId: string) {
  const doc = await getDocument(db, actor, documentId);
  if (doc.kind !== 'meeting') throw badRequest('Only meeting notes have attendees.');
  return doc;
}

/** The note's times and attendees (and transcript when asked); `null` for a page. */
export async function loadMeetingInfo(
  db: Db,
  actor: Actor,
  documentId: string,
  /** `after`: only lines starting at or after this many ms (live polling fetches what's new). */
  opts: { transcript?: boolean; after?: number; recording?: boolean } = {},
): Promise<MeetingInfo | null> {
  const doc = await getDocument(db, actor, documentId);
  if (doc.kind !== 'meeting') return null;
  const [meet] = await db
    .select({
      id: meeting.id,
      startedAt: meeting.startedAt,
      endedAt: meeting.endedAt,
      calendarEventId: meeting.calendarEventId,
    })
    .from(meeting)
    .where(eq(meeting.documentId, doc.id));
  const participants = meet
    ? await db
        .select({
          id: participant.id,
          name: participant.name,
          email: participant.email,
          source: participant.source,
        })
        .from(participant)
        .where(eq(participant.meetingId, meet.id))
        .orderBy(asc(participant.createdAt), asc(participant.id))
    : [];
  const [lastSegment] =
    opts.recording && meet
      ? await db
          .select({ endMs: max(transcriptSegment.endMs) })
          .from(transcriptSegment)
          .where(eq(transcriptSegment.meetingId, meet.id))
      : [];
  return {
    meetingId: meet?.id ?? null,
    startedAt: meet?.startedAt?.toISOString() ?? null,
    endedAt: meet?.endedAt?.toISOString() ?? null,
    participants: participants.map(toParticipant),
    ...(opts.recording
      ? {
          recording: {
            calendarEventId: meet?.calendarEventId ?? null,
            lastSegmentEndMs: lastSegment?.endMs ?? 0,
          },
        }
      : {}),
    ...(opts.transcript
      ? { transcript: meet ? await transcriptLines(db, meet.id, opts.after) : [] }
      : {}),
  };
}

export async function addParticipant(
  db: Db,
  actor: Actor,
  documentId: string,
  input: z.infer<typeof ParticipantInput>,
): Promise<MeetingParticipant> {
  const doc = await meetingNote(db, actor, documentId);
  if (!doc.access.edit) throw forbidden('You can’t edit this note.');
  const email = input.email || null;
  const name = input.name.replace(/\s+/g, ' ') || email;
  if (!name) throw badRequest('Add a name or an email.');
  return db.transaction(async (tx) => {
    // A note made on the web has no meeting row until it needs one (one per document: unique index).
    await tx.insert(meeting).values({ documentId: doc.id }).onConflictDoNothing({
      target: meeting.documentId,
    });
    const [meet] = await tx
      .select({ id: meeting.id })
      .from(meeting)
      .where(eq(meeting.documentId, doc.id))
      .for('update');
    const [{ n } = { n: 0 }] = await tx
      .select({ n: count() })
      .from(participant)
      .where(eq(participant.meetingId, meet!.id));
    if (n >= MAX_PARTICIPANTS)
      throw badRequest(`A meeting can have at most ${MAX_PARTICIPANTS} attendees.`);
    const [row] = await tx
      .insert(participant)
      .values({ meetingId: meet!.id, name, email, source: 'manual' })
      .returning();
    return toParticipant(row!);
  });
}

export async function removeParticipant(
  db: Db,
  actor: Actor,
  documentId: string,
  participantId: string,
): Promise<void> {
  const doc = await meetingNote(db, actor, documentId);
  if (!doc.access.edit) throw forbidden('You can’t edit this note.');
  const [meet] = await db
    .select({ id: meeting.id })
    .from(meeting)
    .where(eq(meeting.documentId, doc.id));
  const removed = meet
    ? await db
        .delete(participant)
        .where(and(eq(participant.id, participantId), eq(participant.meetingId, meet.id)))
        .returning({ id: participant.id })
    : [];
  // Another note's attendee is "not found" here, never removed.
  if (removed.length === 0) throw notFound('Attendee');
}

type IdParams = { id: string };

/** `/api/documents/[id]/meeting` and `/api/documents/[id]/participants[/participantId]`. */
export function createMeetingApi(deps: ApiDeps) {
  return {
    meeting: {
      GET: apiRoute<IdParams>(deps, async ({ db, actor, params, url }) => {
        const after = Number(url.searchParams.get('after'));
        const info = await loadMeetingInfo(db, actor, params.id, {
          transcript: url.searchParams.get('transcript') === '1',
          recording: url.searchParams.get('recording') === '1',
          ...(Number.isInteger(after) && after > 0 ? { after } : {}),
        });
        if (!info) throw badRequest('Only meeting notes have a meeting side.');
        return info;
      }),
    },
    participants: {
      POST: apiRoute<IdParams>(
        deps,
        async ({ db, actor, params, request }) =>
          addParticipant(db, actor, params.id, await readJson(request, ParticipantInput)),
        { status: 201 },
      ),
    },
    participant: {
      DELETE: apiRoute<IdParams & { participantId: string }>(deps, async ({ db, actor, params }) =>
        removeParticipant(db, actor, params.id, params.participantId),
      ),
    },
  };
}

export type MeetingApi = ReturnType<typeof createMeetingApi>;
