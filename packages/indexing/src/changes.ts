/**
 * Change log → index jobs (D-19/D-22). The worker follows `change_log` instead of being called from write
 * paths, so every writer is covered with no coupling: the web API, the desktop sync push (2.6/3.5, which is
 * where transcript segments arrive), Better Auth, seeds and FK cascades.
 */
import { type Change, chunk, type Db, meeting, type SyncedTable, transcriptSegment } from '@oat/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { IndexJob } from './queue.ts';

/** The change-log tables that affect chunks. */
export const INDEXED_TABLES: readonly SyncedTable[] = ['document', 'meeting', 'transcript_segment'];

/**
 * Jobs for a page of changes, always `document:<id>`: one queue key per document, so a rename and a
 * transcript update of the same meeting can never run concurrently and overwrite each other's chunks.
 * - `document` upsert → that document. Deletes need nothing: chunks cascade with the row, and a soft delete
 *   (trash) is an upsert; search filters trash at query time.
 * - `meeting` upsert → its document.
 * - `transcript_segment` upsert → its meeting's document; delete → the documents whose chunks cite it (the
 *   log only carries the id, and the row is gone). A segment deleted by its meeting's cascade cites a
 *   document that is gone too: nothing to do.
 */
export async function jobsForChanges(db: Db, changes: readonly Change[]): Promise<IndexJob[]> {
  const documents = new Set<string>();
  const meetings = new Set<string>();
  const upsertedSegments = new Set<string>();
  const deletedSegments = new Set<string>();

  for (const c of changes) {
    if (c.tableName === 'document' && c.op === 'upsert') documents.add(c.rowId);
    else if (c.tableName === 'meeting' && c.op === 'upsert') meetings.add(c.rowId);
    else if (c.tableName === 'transcript_segment') {
      (c.op === 'upsert' ? upsertedSegments : deletedSegments).add(c.rowId);
    }
  }

  if (meetings.size > 0) {
    const rows = await db
      .select({ documentId: meeting.documentId })
      .from(meeting)
      .where(inArray(meeting.id, [...meetings]));
    for (const r of rows) documents.add(r.documentId);
  }
  if (upsertedSegments.size > 0) {
    const ids = [...upsertedSegments];
    const rows = await db
      .select({ id: transcriptSegment.id, documentId: meeting.documentId })
      .from(transcriptSegment)
      .innerJoin(meeting, eq(meeting.id, transcriptSegment.meetingId))
      .where(inArray(transcriptSegment.id, ids));
    for (const r of rows) documents.add(r.documentId);
    // Upserted then deleted before we looked: treat like a delete.
    const found = new Set(rows.map((r) => r.id));
    for (const id of ids) if (!found.has(id)) deletedSegments.add(id);
  }
  if (deletedSegments.size > 0) {
    const rows = await db
      .selectDistinct({ documentId: chunk.documentId })
      .from(chunk)
      .where(
        and(
          eq(chunk.source, 'transcript'),
          sql`${chunk.refIds} && ${sql.param([...deletedSegments])}::text[]`,
        ),
      );
    for (const r of rows) documents.add(r.documentId);
  }
  return [...documents].map((id) => ({ kind: 'document' as const, id }));
}
