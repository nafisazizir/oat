/**
 * Desktop IPC channels of the meeting note view (task 3.4), spread into `bridgeContract` (`bridge.ts`).
 * Everything reads and writes the signed-in user's local database (`@oat/local-store`); sync (2.6) carries
 * the writes to the server. Kept in its own module so the meeting channels evolve without touching the
 * rest of the contract. (No imports from `bridge.ts`: it imports this module.)
 */
import { z } from 'zod';

import { noteCalendarEventSchema } from './bridge-calendar.ts';

const documentId = z.string().min(1).max(100);
/** Same rule as `meetingIdSchema` in bridge.ts (audio archive folder names). */
const meetingId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const iso = z.string().max(40);

export const MAX_MEETING_TITLE = 200;
export const MAX_PARTICIPANT_NAME = 200;

/** One meeting note in the desktop's list. */
export const meetingNoteSummarySchema = z.object({
  documentId,
  meetingId: z.string().nullable(),
  workspaceId: z.string(),
  title: z.string(),
  visibility: z.enum(['private', 'workspace', 'link']),
  /** Recording start (null: a note made on the web, never recorded). */
  startedAt: iso.nullable(),
  endedAt: iso.nullable(),
  createdAt: iso,
});
export type MeetingNoteSummary = z.infer<typeof meetingNoteSummarySchema>;

export const meetingParticipantSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  source: z.enum(['calendar', 'manual']),
});
export type MeetingParticipant = z.infer<typeof meetingParticipantSchema>;

/** TipTap JSON (canonical, D-4); its schema is checked by the server when it syncs. */
export const noteContentSchema = z.looseObject({ type: z.literal('doc') });

/** A meeting note opened in the desktop view: header, my notes, participants (no transcript). */
export const meetingNoteSchema = z.object({
  documentId,
  meetingId: z.string().nullable(),
  workspaceId: z.string(),
  workspaceName: z.string().nullable(),
  title: z.string(),
  contentJson: noteContentSchema,
  visibility: z.enum(['private', 'workspace', 'link']),
  /** The local copy may be edited (the server still decides when it syncs). */
  editable: z.boolean(),
  /**
   * Recording on this Mac can add to this meeting (D-24): its audio is here, or nothing was recorded yet
   * (a note made from a calendar event or on the web).
   */
  recordedHere: z.boolean(),
  trashed: z.boolean(),
  startedAt: iso.nullable(),
  endedAt: iso.nullable(),
  updatedAt: iso,
  participants: z.array(meetingParticipantSchema).max(1000),
  /** The calendar event it was made from, while the calendar has it (7.3). */
  calendarEvent: noteCalendarEventSchema.nullable().default(null),
});
export type MeetingNote = z.infer<typeof meetingNoteSchema>;

/** A stored (final) transcript segment, on the meeting clock. */
export const storedSegmentSchema = z.object({
  id: z.string().min(1).max(64),
  source: z.enum(['mic', 'system']),
  speaker: z.string().nullable(),
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  text: z.string().max(10_000),
  /** Filled in on this Mac from the audio archive after a transcription outage (2.7; not synced). */
  backfilled: z.boolean().optional(),
});
export type StoredSegment = z.infer<typeof storedSegmentSchema>;

export const meetingInvokeChannels = {
  /** Meeting notes on this Mac, newest first. */
  'meetings:list': {
    request: z.undefined(),
    response: z.object({ notes: z.array(meetingNoteSummarySchema).max(500) }),
  },
  /** One note by document or by meeting id (the recording's); `null` when it isn't on this Mac. */
  'meeting:get': {
    request: z.union([z.strictObject({ documentId }), z.strictObject({ meetingId })]),
    response: meetingNoteSchema.nullable(),
  },
  /** The note's stored transcript (finals), in time order. */
  'meeting:transcript': {
    request: z.strictObject({ documentId }),
    response: z.object({ segments: z.array(storedSegmentSchema).max(200_000) }),
  },
  /**
   * Autosave of the title and/or my notes. `base` is the title + notes the editor's state was built on: when
   * the stored note no longer matches it (sync pulled an edit while I typed), nothing is overwritten — the
   * edit is kept as a "conflicted copy" page (D-19) and `conflict` names it.
   */
  'meeting:save': {
    request: z.strictObject({
      documentId,
      base: z.strictObject({ title: z.string().max(1000), contentJson: noteContentSchema }),
      title: z.string().max(MAX_MEETING_TITLE).optional(),
      contentJson: noteContentSchema.optional(),
    }),
    response: z.object({
      updatedAt: iso,
      conflict: z.object({ documentId: z.string(), title: z.string() }).nullable(),
    }),
  },
  'meeting:add-participant': {
    request: z.strictObject({
      documentId,
      name: z.string().trim().min(1).max(MAX_PARTICIPANT_NAME),
      email: z.email().max(320).nullable(),
    }),
    response: meetingParticipantSchema,
  },
  'meeting:remove-participant': {
    request: z.strictObject({ documentId, participantId: z.string().min(1).max(100) }),
    response: z.undefined(),
  },
} as const;

export const meetingSendChannels = {
  /** The window wrote what it had pending, answering `notes:flush` (quit waits for it, ≤ 1 s). */
  'notes:flushed': z.object({ id: z.number().int().nonnegative() }),
} as const;

export const meetingSubscribeChannels = {
  /**
   * Meeting notes on this Mac changed (a recording created one, sync pulled changes, a participant was
   * added…): windows reload what they show. `seq` +1 per change.
   */
  'meetings:changed': z.object({ seq: z.number().int().nonnegative() }),
  /** The app is about to quit: write pending note edits now, then send `notes:flushed` with this id. */
  'notes:flush': z.object({ id: z.number().int().nonnegative() }),
} as const;
