/**
 * Desktop IPC channels of transcript resilience (task 2.7), spread into `bridgeContract` (`bridge.ts`): the
 * back-fill of STT outages from the local audio archive and the "Oat quit unexpectedly" recovery note of a
 * meeting. Changes are announced with `meetings:changed` (the windows reload what they show). (No imports
 * from `bridge.ts`: it imports this module.)
 */
import { z } from 'zod';

/** Same rule as `meetingIdSchema` in bridge.ts (audio archive folder names). */
const meetingId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const ms = z.number().nonnegative();

export const transcriptBackfillStatusSchema = z.object({
  meetingId: z.string(),
  /** Audio still to be transcribed from the archive (both sources added up). */
  pendingMs: ms,
  /** Audio already filled in. */
  doneMs: ms,
  /** Audio given up on (`error` says why). */
  failedMs: ms,
  /** Segments added so far. */
  segments: z.number().int().nonnegative(),
  /** A job of this meeting is being transcribed right now. */
  running: z.boolean(),
  /** A pending job failed and waits to retry (`error` says why). */
  retrying: z.boolean(),
  error: z.string().max(500).nullable(),
  /** The app quit unexpectedly while recording this meeting: when that was found out (Unix ms)… */
  recoveredAt: z.number().nullable(),
  /** …and how far (wall clock, Unix ms) the saved recording reaches. */
  savedUntil: z.number().nullable(),
});
export type TranscriptBackfillStatus = z.infer<typeof transcriptBackfillStatusSchema>;

export const transcriptInvokeChannels = {
  /** Back-fill progress and crash-recovery note of a meeting (local to this Mac). */
  'meeting:transcript-status': {
    request: z.strictObject({ meetingId }),
    response: transcriptBackfillStatusSchema,
  },
} as const;
