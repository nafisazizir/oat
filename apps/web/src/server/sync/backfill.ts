import 'server-only';

import {
  canReadDocument,
  MAX_BACKFILL_LIMIT,
  type SyncBackfillResponse,
  type SyncPullChange,
} from '@oat/core';
import { type Db, document, meeting, participant, transcriptSegment } from '@oat/db';
import { and, asc, eq, gt, ne } from 'drizzle-orm';

import type { Actor } from '../actor';
import { badRequest, notFound } from '../api/errors';
import { toSyncMeeting } from './pull';

/*
 * `GET /api/sync/backfill?document=<id>&after=<token>` (3.5): the current subtree of a document a client
 * has just seen for the first time — its meeting and participants on the first page, then final segments
 * by id. Their change-log rows may be older than the client's cursor (the note became readable later:
 * shared, made visible to the workspace), so a cursor pull would never send them. Same read rule as the
 * pull (`canReadDocument`); anything unreadable is a 404, as if it didn't exist.
 */

const AFTER = /^s:([^\s]{1,64})$/;

export async function backfillDocument(
  db: Db,
  actor: Actor,
  documentId: string,
  after: string | null,
  limit = MAX_BACKFILL_LIMIT,
): Promise<SyncBackfillResponse> {
  let afterSegment: string | null = null;
  if (after !== null) {
    const m = AFTER.exec(after);
    if (!m) throw badRequest('Invalid backfill token.');
    afterSegment = m[1]!;
  }
  const size = Math.min(Math.max(1, limit), MAX_BACKFILL_LIMIT);
  const [doc] = await db.select().from(document).where(eq(document.id, documentId));
  if (!doc || !canReadDocument(actor.ctx, doc)) throw notFound('Document');
  const [m] = await db.select().from(meeting).where(eq(meeting.documentId, doc.id));
  if (!m) return { changes: [], next: null };

  const changes: SyncPullChange[] = [];
  if (afterSegment === null) {
    changes.push({ op: 'upsert', table: 'meeting', row: toSyncMeeting(m) });
    const people = await db
      .select()
      .from(participant)
      .where(eq(participant.meetingId, m.id))
      .orderBy(asc(participant.id));
    for (const p of people) {
      changes.push({
        op: 'upsert',
        table: 'participant',
        row: { id: p.id, meetingId: p.meetingId, name: p.name, email: p.email, source: p.source },
      });
    }
  }
  const segments = await db
    .select()
    .from(transcriptSegment)
    .where(
      and(
        eq(transcriptSegment.meetingId, m.id),
        eq(transcriptSegment.isFinal, true),
        ne(transcriptSegment.text, ''),
        afterSegment === null ? undefined : gt(transcriptSegment.id, afterSegment),
      ),
    )
    .orderBy(asc(transcriptSegment.id))
    .limit(size + 1);
  const more = segments.length > size;
  const pageRows = more ? segments.slice(0, size) : segments;
  for (const s of pageRows) {
    changes.push({
      op: 'upsert',
      table: 'transcript_segment',
      row: {
        id: s.id,
        meetingId: s.meetingId,
        source: s.source,
        speakerLabel: s.speakerLabel,
        startMs: s.startMs,
        endMs: s.endMs,
        text: s.text,
      },
    });
  }
  return { changes, next: more ? `s:${pageRows.at(-1)!.id}` : null };
}
