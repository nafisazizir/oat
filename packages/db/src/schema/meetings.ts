/** Meetings, participants and transcript segments (SPEC §6, D-19). */
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { template } from './ai.ts';
import { id, timestamps, timestamptz } from './columns.ts';
import { document } from './documents.ts';
import { participantSourceEnum, transcriptSourceEnum } from './enums.ts';

/** A meeting is the recording/transcript side of a `kind = 'meeting'` document (1:1). */
export const meeting = pgTable(
  'meeting',
  {
    id: id(),
    documentId: text('document_id')
      .notNull()
      .unique()
      .references(() => document.id, { onDelete: 'cascade' }),
    calendarEventId: text('calendar_event_id'),
    startedAt: timestamptz('started_at'),
    endedAt: timestamptz('ended_at'),
    /** Free-form app/platform label, e.g. "zoom". */
    platform: text('platform'),
    templateId: text('template_id').references(() => template.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [index('meeting_template_id_idx').on(t.templateId)],
);

export const participant = pgTable(
  'participant',
  {
    /** Not in SPEC §6 / `@oat/core`; a surrogate key so rows can be synced and edited individually. */
    id: id(),
    meetingId: text('meeting_id')
      .notNull()
      .references(() => meeting.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    email: text('email'),
    source: participantSourceEnum('source').notNull(),
    ...timestamps(),
  },
  (t) => [index('participant_meeting_id_idx').on(t.meetingId)],
);

export const transcriptSegment = pgTable(
  'transcript_segment',
  {
    /** Client-generated and stable (D-19): no default, the desktop always supplies it. */
    id: text('id').primaryKey(),
    meetingId: text('meeting_id')
      .notNull()
      .references(() => meeting.id, { onDelete: 'cascade' }),
    source: transcriptSourceEnum('source').notNull(),
    speakerLabel: text('speaker_label'),
    /** Milliseconds on the recording's clock (shared with the local audio archive, D-10). */
    startMs: integer('start_ms').notNull(),
    endMs: integer('end_ms').notNull(),
    text: text('text').notNull(),
    /** Only finals sync (D-19); interim rows exist only if a server-side path ever writes them. */
    isFinal: boolean('is_final').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    // Transcript rendering + range lookups for enhancement/retrieval.
    index('transcript_segment_meeting_start_idx').on(t.meetingId, t.startMs),
    check('transcript_segment_range_ck', sql`${t.startMs} >= 0 and ${t.endMs} >= ${t.startMs}`),
  ],
);
