/**
 * Desktop bridge channels for the local audio archive's storage settings (task 3.8, D-10, D-24, D-28, D-30):
 * how much space recordings use, per-meeting list, delete a meeting's audio, reveal it in Finder, and the
 * retention policy (enforced by a main-process sweeper). Spread into `bridgeContract` (`bridge.ts`).
 *
 * Paths never cross the bridge: the renderer names a meeting, main resolves (and validates) its folder.
 * Transcripts and notes are never touched by any of these channels: only `.opus` files + their rows.
 */
import { z } from 'zod';

/** Same rule as `meetingIdSchema` in `bridge.ts` / `@oat/audio` archive paths: a plain folder name. */
const storageMeetingIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);

/** Upper bounds keep a typo from turning into "delete everything" or an overflow. */
export const RETENTION_MAX_DAYS = 3650;
export const RETENTION_MIN_GB = 0.1;
export const RETENTION_MAX_GB = 10_000;

/**
 * - `forever` (default): never delete automatically.
 * - `age`: delete a meeting's audio once its newest recording is older than `days`.
 * - `size`: keep the archive's total at or under `gb` (decimal GB), deleting the oldest meetings first.
 */
export const retentionPolicySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('forever') }),
  z.strictObject({ kind: z.literal('age'), days: z.number().int().min(1).max(RETENTION_MAX_DAYS) }),
  z.strictObject({
    kind: z.literal('size'),
    gb: z.number().min(RETENTION_MIN_GB).max(RETENTION_MAX_GB),
  }),
]);
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = { kind: 'forever' };

/** Longest title sent (main clamps; synced titles may be longer). */
export const STORAGE_TITLE_MAX = 200;
/** Most meetings listed (newest first); totals always cover every meeting. */
export const STORAGE_LIST_MAX = 10_000;

/**
 * One meeting's audio on this Mac (the signed-in account's, D-30), summed over its parts and sources.
 * - `recording`: being recorded right now (can't be deleted).
 * - `complete` / `partial`: playable audio (`partial` = some part was repaired after a crash/disk error, or
 *   was left `recording` by a crash).
 */
export const storageMeetingSchema = z.object({
  meetingId: z.string(),
  /** The note's title in the signed-in account; `null` if this account doesn't know the meeting. */
  title: z.string().max(STORAGE_TITLE_MAX).nullable(),
  /** Wall clock (Unix ms) of the first recording session. */
  startedAt: z.number(),
  /** Wall clock (Unix ms) of the latest audio activity (what age-based retention looks at). */
  lastActivityAt: z.number(),
  bytes: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  /** Recording sessions with audio (D-24). */
  parts: z.number().int().nonnegative(),
  status: z.enum(['recording', 'complete', 'partial']),
  /** `false` while the meeting is being recorded (or its files are still being closed). */
  deletable: z.boolean(),
});
export type StorageMeeting = z.infer<typeof storageMeetingSchema>;

export const sweepResultSchema = z.object({
  /** Wall clock (Unix ms) the sweep finished. */
  at: z.number(),
  reason: z.enum(['launch', 'sign-in', 'interval', 'recording', 'policy']),
  meetings: z.number().int().nonnegative(),
  freedBytes: z.number().int().nonnegative(),
  /** Meetings the sweeper wanted but couldn't delete (recording, too recent, I/O error). */
  skipped: z.number().int().nonnegative(),
});
export type SweepResult = z.infer<typeof sweepResultSchema>;

export const storageSummarySchema = z.object({
  /** Bytes of the signed-in account's audio files on this Mac. */
  totalBytes: z.number().int().nonnegative(),
  /** That account's meetings with audio on this Mac, newest first (at most `STORAGE_LIST_MAX`). */
  meetings: z.array(storageMeetingSchema).max(STORAGE_LIST_MAX),
  /** Its meetings with audio, including any not listed. */
  meetingCount: z.number().int().nonnegative(),
  /** Its meetings whose audio was deleted (rows kept for the "Audio deleted" hint). */
  deletedMeetings: z.number().int().nonnegative(),
  /**
   * Audio of other accounts on this Mac (and old recordings no account has claimed): an aggregate only,
   * no titles and no actions (D-30).
   */
  otherAccounts: z.object({
    meetings: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  }),
  /** This account's policy on this Mac. */
  policy: retentionPolicySchema,
  lastSweep: sweepResultSchema.nullable(),
});
export type StorageSummary = z.infer<typeof storageSummarySchema>;

/** What a policy would delete now (dry run), with the same safety rules as the sweeper. */
export const retentionPreviewSchema = z.object({
  meetings: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  meetingIds: z.array(z.string()).max(STORAGE_LIST_MAX),
  /** Over the cap even after deleting everything allowed (recent or active recordings are kept). */
  overCapAfter: z.boolean(),
});
export type RetentionPreview = z.infer<typeof retentionPreviewSchema>;

/**
 * Read-only audio hint for the meeting view / playback (3.7):
 * - `available`: audio on this Mac; `recording`: being recorded;
 * - `deleted`: this Mac had audio and it was deleted (user or retention);
 * - `other-device`: the meeting was recorded, but not on this Mac (or this Mac's index lost it);
 * - `none`: no recording at all (e.g. a note without a meeting, or every file failed).
 */
export const AUDIO_AVAILABILITY = [
  'available',
  'recording',
  'deleted',
  'other-device',
  'none',
] as const;
export const audioAvailabilitySchema = z.object({
  meetingId: z.string(),
  status: z.enum(AUDIO_AVAILABILITY),
  bytes: z.number().int().nonnegative(),
  parts: z.number().int().nonnegative(),
});
export type AudioAvailability = z.infer<typeof audioAvailabilitySchema>;

const none = z.undefined();
const meetingRequest = z.strictObject({ meetingId: storageMeetingIdSchema });

/** Invoke channels (spread into `bridgeContract.invoke`). */
export const storageInvokeChannels = {
  /**
   * The signed-in account's audio: total, per-meeting list, its retention policy and last sweep, plus an
   * aggregate of other accounts' audio. Signed out: nothing listed, everything in the aggregate.
   */
  'storage:list': { request: none, response: storageSummarySchema },
  /**
   * Deletes a meeting's audio files and marks its rows `deleted`; transcript and note untouched.
   * `invalid_state` while that meeting is being recorded; `unauthorized` signed out. Only the signed-in
   * account's rows are touched.
   */
  'storage:delete-audio': {
    request: meetingRequest,
    response: z.object({
      /** Every file was removed (or was already gone). */
      deleted: z.boolean(),
      freedBytes: z.number().int().nonnegative(),
      /** There was nothing left to delete (e.g. a sweep got there first). */
      alreadyGone: z.boolean(),
    }),
  },
  /** Reveals the meeting's audio folder in Finder (`shown: false` if it no longer exists). */
  'storage:show': { request: meetingRequest, response: z.object({ shown: z.boolean() }) },
  /** Dry run: what the policy would delete right now. */
  'storage:preview-policy': {
    request: z.strictObject({ policy: retentionPolicySchema }),
    response: retentionPreviewSchema,
  },
  /** Saves the policy and sweeps with it; resolves with the new summary. */
  'storage:set-policy': {
    request: z.strictObject({ policy: retentionPolicySchema }),
    response: storageSummarySchema,
  },
  /** Audio hint for one meeting (3.7: "Audio deleted" / "Audio on another device"). */
  'storage:audio-status': { request: meetingRequest, response: audioAvailabilitySchema },
} as const;

/** Push channels (spread into `bridgeContract.subscribe`): the archive changed (sweep, delete, recording). */
export const storageSubscribeChannels = {
  'storage:changed': z.object({ seq: z.number().int().nonnegative() }),
} as const;
