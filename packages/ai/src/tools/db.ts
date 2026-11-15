/**
 * {@link AssistantData} over Postgres (Drizzle). Retrieval is injected (`search`): it is `searchChunks` from
 * `@oat/indexing`, which depends on `@oat/ai`, so this package can't import it.
 *
 * `listMeetings` applies the read rule in SQL (member of the workspace, live document in a live workspace,
 * owner or not private) so `limit` holds; the tools re-check every row with `@oat/core` anyway.
 */
import type { PermissionContext } from '@oat/core';
import { type Db, document, meeting, participant, transcriptSegment, workspace } from '@oat/db';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import type {
  AssistantData,
  DocumentRecord,
  MeetingRecord,
  ParticipantRecord,
  SearchHit,
  SearchRequest,
} from './types.ts';

export type SearchFn = (
  permissions: PermissionContext,
  query: string,
  request: SearchRequest,
) => Promise<SearchHit[]>;

const documentColumns = {
  id: document.id,
  workspaceId: document.workspaceId,
  folderId: document.folderId,
  ownerId: document.ownerId,
  kind: document.kind,
  title: document.title,
  visibility: document.visibility,
  shareToken: document.shareToken,
  deletedAt: document.deletedAt,
  version: document.version,
  createdAt: document.createdAt,
  updatedAt: document.updatedAt,
};

const meetingColumns = {
  id: meeting.id,
  documentId: meeting.documentId,
  startedAt: meeting.startedAt,
  endedAt: meeting.endedAt,
  platform: meeting.platform,
};

/** `%`/`_`/`\` escaped for ILIKE. */
const likeEscape = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

const MAX_IDS = 500;

export function createDbAssistantData(db: Db, options: { search: SearchFn }): AssistantData {
  async function participantsOf(meetingIds: readonly string[]) {
    const out = new Map<string, ParticipantRecord[]>();
    if (meetingIds.length === 0) return out;
    const rows = await db
      .select({
        meetingId: participant.meetingId,
        name: participant.name,
        email: participant.email,
      })
      .from(participant)
      .where(inArray(participant.meetingId, [...meetingIds]))
      .orderBy(asc(participant.createdAt), asc(participant.id));
    for (const row of rows) {
      out.set(row.meetingId, [
        ...(out.get(row.meetingId) ?? []),
        { name: row.name, email: row.email },
      ]);
    }
    return out;
  }

  return {
    search: options.search,

    async documents(ids) {
      const unique = [...new Set(ids)].slice(0, MAX_IDS);
      if (unique.length === 0) return [];
      const rows = await db
        .select({ ...documentColumns, contentJson: document.contentJson })
        .from(document)
        .innerJoin(workspace, eq(workspace.id, document.workspaceId))
        // A soft-deleted workspace is gone for everyone: its documents count as missing.
        .where(and(inArray(document.id, unique), isNull(workspace.deletedAt)));
      return rows satisfies DocumentRecord[];
    },

    async meeting(by) {
      const [row] = await db
        .select(meetingColumns)
        .from(meeting)
        .where('id' in by ? eq(meeting.id, by.id) : eq(meeting.documentId, by.documentId));
      if (!row) return undefined;
      const participants = (await participantsOf([row.id])).get(row.id) ?? [];
      return { ...row, participants } satisfies MeetingRecord;
    },

    async segments(meetingId, range, limit) {
      return db
        .select({
          id: transcriptSegment.id,
          meetingId: transcriptSegment.meetingId,
          source: transcriptSegment.source,
          speakerLabel: transcriptSegment.speakerLabel,
          startMs: transcriptSegment.startMs,
          endMs: transcriptSegment.endMs,
          text: transcriptSegment.text,
        })
        .from(transcriptSegment)
        .where(
          and(
            eq(transcriptSegment.meetingId, meetingId),
            eq(transcriptSegment.isFinal, true),
            range.fromMs !== undefined ? gte(transcriptSegment.startMs, range.fromMs) : undefined,
            range.toMs !== undefined ? lt(transcriptSegment.startMs, range.toMs) : undefined,
          ),
        )
        .orderBy(asc(transcriptSegment.startMs), asc(transcriptSegment.id))
        .limit(Math.max(1, limit));
    },

    async segmentsByIds(ids) {
      const unique = [...new Set(ids)].slice(0, MAX_IDS);
      if (unique.length === 0) return [];
      return db
        .select({
          id: transcriptSegment.id,
          meetingId: transcriptSegment.meetingId,
          source: transcriptSegment.source,
          speakerLabel: transcriptSegment.speakerLabel,
          startMs: transcriptSegment.startMs,
          endMs: transcriptSegment.endMs,
          text: transcriptSegment.text,
        })
        .from(transcriptSegment)
        .where(and(inArray(transcriptSegment.id, unique), eq(transcriptSegment.isFinal, true)));
    },

    async listMeetings(permissions, filter) {
      const userId = permissions.userId;
      if (userId === null || !permissions.memberships.has(filter.workspaceId)) return [];
      // "When": the start time, else when the note was created.
      const when = sql<Date>`coalesce(${meeting.startedAt}, ${document.createdAt})`;
      const attendee = filter.attendee ? `%${likeEscape(filter.attendee)}%` : undefined;
      const rows = await db
        .select({ document: documentColumns, meeting: meetingColumns })
        .from(meeting)
        .innerJoin(document, eq(document.id, meeting.documentId))
        .innerJoin(workspace, eq(workspace.id, document.workspaceId))
        .where(
          and(
            eq(document.workspaceId, filter.workspaceId),
            isNull(document.deletedAt),
            isNull(workspace.deletedAt),
            or(eq(document.ownerId, userId), ne(document.visibility, 'private')),
            filter.folderId ? eq(document.folderId, filter.folderId) : undefined,
            filter.from ? gte(when, filter.from) : undefined,
            filter.to ? lt(when, filter.to) : undefined,
            attendee
              ? exists(
                  db
                    .select({ one: sql`1` })
                    .from(participant)
                    .where(
                      and(
                        eq(participant.meetingId, meeting.id),
                        or(ilike(participant.name, attendee), ilike(participant.email, attendee)),
                      ),
                    ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(when), desc(meeting.id))
        .limit(filter.limit);
      const participants = await participantsOf(rows.map((r) => r.meeting.id));
      return rows.map((r) => ({
        document: r.document,
        meeting: { ...r.meeting, participants: participants.get(r.meeting.id) ?? [] },
      }));
    },
  };
}
