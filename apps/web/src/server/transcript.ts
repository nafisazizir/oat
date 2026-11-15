import 'server-only';

import { type Db, meeting, transcriptSegment } from '@oat/db';
import { and, asc, eq } from 'drizzle-orm';

import type { TranscriptLine } from '@/lib/transcript';

import type { Actor } from './actor';
import { getDocument } from './documents';

/** Longest transcript the in-app reader renders (a few hours of speech). */
const MAX_LINES = 5000;

/**
 * The final transcript of a meeting note, for the document page's transcript reader (6.4: citation and search
 * deep links `?t=<seconds>&seg=<id>`). Read access is checked through the documents API (`getDocument`: 404
 * when the actor can't read it); a page or a meeting without a recording has no transcript (`null`).
 */
export async function loadTranscript(
  db: Db,
  actor: Actor,
  documentId: string,
): Promise<TranscriptLine[] | null> {
  const doc = await getDocument(db, actor, documentId);
  if (doc.kind !== 'meeting') return null;
  const [meet] = await db
    .select({ id: meeting.id })
    .from(meeting)
    .where(eq(meeting.documentId, doc.id));
  if (!meet) return null;
  const rows = await db
    .select({
      id: transcriptSegment.id,
      source: transcriptSegment.source,
      speakerLabel: transcriptSegment.speakerLabel,
      startMs: transcriptSegment.startMs,
      text: transcriptSegment.text,
    })
    .from(transcriptSegment)
    .where(and(eq(transcriptSegment.meetingId, meet.id), eq(transcriptSegment.isFinal, true)))
    .orderBy(asc(transcriptSegment.startMs), asc(transcriptSegment.id))
    .limit(MAX_LINES);
  return rows.map((s) => ({
    id: s.id,
    source: s.source,
    speaker: s.source === 'mic' ? 'Me' : s.speakerLabel?.trim() || 'Them',
    startMs: s.startMs,
    text: s.text,
  }));
}
