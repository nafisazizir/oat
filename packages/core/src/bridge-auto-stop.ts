/**
 * Desktop IPC channels of auto-stop + auto-enhance (task 7.5), spread into `bridgeContract` (`bridge.ts`):
 * - the "Stopping… Keep recording" toast and the "Meeting over?" question (`@oat/detection` `autoStop`);
 * - the desktop settings "Stop recording automatically when the meeting ends" (+ in-person);
 * - the grace period after a stop: the meeting's end is written (and synced, which starts the post-meeting
 *   pipeline, 8.3) only after it, so "Continue recording" meanwhile never starts a run;
 * - the post-meeting pipeline's status for the meeting header (the web API's `GET /api/documents/:id/pipeline`).
 * Kept in its own module like `bridge-calendar.ts` (no imports from `bridge.ts`).
 */
import { z } from 'zod';

const documentId = z.string().min(1).max(100);
const meetingId = z.string().min(1).max(100);

export const autoStopSettingsSchema = z.object({
  /** "Stop recording automatically when the meeting ends" (default on). */
  enabled: z.boolean(),
  /** Also in-person recordings (no meeting app), after 10 min of silence (default off). */
  inPerson: z.boolean(),
});
export type AutoStopSettingsSnapshot = z.infer<typeof autoStopSettingsSchema>;

/** What auto-stop shows: `stopping` = the undo toast (stops at `stopAt`), `ask` = "Meeting over?". */
export const autoStopNoticeSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(['stopping', 'ask']),
  /** `meeting_ended`: the call ended; `silence`: nothing heard for a while. */
  reason: z.enum(['meeting_ended', 'silence']),
  /** Wall clock (Unix ms). */
  at: z.number(),
  stopAt: z.number().nullable(),
});
export type AutoStopNoticeSnapshot = z.infer<typeof autoStopNoticeSchema>;

/** A stopped meeting whose end is held back for the grace period. */
export const meetingGraceSchema = z.object({
  meetingId,
  /** When recording stopped (Unix ms): the meeting's end once written. */
  endedAt: z.number(),
  /** When the end is written (Unix ms) unless recording continues first. */
  dueAt: z.number(),
});
export type MeetingGrace = z.infer<typeof meetingGraceSchema>;

export const PIPELINE_RUN_STATES = ['waiting', 'queued', 'running', 'completed', 'failed'] as const;

/** The post-meeting pipeline (8.3) as the meeting header shows it. */
export const pipelineStatusSchema = z.object({
  run: z
    .object({
      status: z.enum(PIPELINE_RUN_STATES),
      currentStep: z.enum(['enhance', 'index', 'notion']).nullable(),
      error: z.string().max(500).nullable(),
      retryable: z.boolean(),
      /** Steps done, e.g. `{ step: 'enhance', outcome: 'skipped', reason: 'transcript too short' }`. */
      steps: z
        .array(
          z.object({
            step: z.string().max(32),
            outcome: z.string().max(32),
            reason: z.string().max(200).optional(),
          }),
        )
        .max(20),
    })
    .nullable(),
  meetingEnded: z.boolean(),
  canRun: z.boolean(),
});
export type PipelineStatus = z.infer<typeof pipelineStatusSchema>;

export const autoStopInvokeChannels = {
  'autostop:get': { request: z.undefined(), response: autoStopNoticeSchema.nullable() },
  /** Answer the notice: `keep` = "Keep recording" / "Keep going"; `stop` = "Stop recording" now. */
  'autostop:respond': {
    request: z.strictObject({
      id: z.string().min(1).max(64),
      action: z.enum(['keep', 'stop']),
    }),
    response: z.undefined(),
  },
  'autostop:get-settings': { request: z.undefined(), response: autoStopSettingsSchema },
  'autostop:set-settings': {
    request: z.strictObject({ enabled: z.boolean().optional(), inPerson: z.boolean().optional() }),
    response: autoStopSettingsSchema,
  },
  'grace:get': { request: z.undefined(), response: meetingGraceSchema.nullable() },
  /** End the meeting now (skip the rest of the grace period): its notes are finished right away. */
  'grace:finish-now': { request: z.strictObject({ meetingId }), response: z.undefined() },
  /** The note's post-meeting run (read access). `unavailable` offline. */
  'pipeline:get': { request: z.strictObject({ documentId }), response: pipelineStatusSchema },
  /** "Retry" a failed run (owner/editor). */
  'pipeline:retry': { request: z.strictObject({ documentId }), response: pipelineStatusSchema },
} as const;

export const autoStopSubscribeChannels = {
  'autostop:changed': z.object({ notice: autoStopNoticeSchema.nullable() }),
  'grace:changed': z.object({ grace: meetingGraceSchema.nullable() }),
} as const;
