/**
 * Desktop IPC channels of first-run onboarding (task 9.2), spread into `bridgeContract` (`bridge.ts`):
 * - the permission walkthrough: microphone and system audio (the sidecar's `permissions`, which never
 *   prompts) and the Mac's calendars (EventKit, `calendar status`); a request runs only from the user's "Allow"
 *   click, and a denied permission can only be fixed in System Settings (opened at the right pane);
 * - a short test recording (levels for Me / Them + a live transcript line) that is never saved;
 * - whether this account finished setup on this Mac, and the first-meeting guide card.
 * Kept in its own module like `bridge-calendar.ts` (no imports from `bridge.ts`).
 */
import { z } from 'zod';

import { eventkitStateSchema, googleCalendarStateSchema } from './bridge-calendar.ts';

/**
 * A macOS privacy permission as the sidecar reports it (`oat-audio permissions`). `unknown`: the status can't be
 * read (system audio without the TCC preflight, no sidecar); the request (or the first capture) decides.
 */
export const PERMISSION_STATES = [
  'granted',
  'denied',
  'not_determined',
  'restricted',
  'unknown',
] as const;
export const permissionStateSchema = z.enum(PERMISSION_STATES);
export type PermissionState = z.infer<typeof permissionStateSchema>;

/** The permissions onboarding walks through. */
export const PERMISSION_KINDS = ['microphone', 'system_audio', 'calendar'] as const;
export const permissionKindSchema = z.enum(PERMISSION_KINDS);
export type PermissionKind = z.infer<typeof permissionKindSchema>;

export const permissionsSnapshotSchema = z.object({
  microphone: permissionStateSchema,
  systemAudio: permissionStateSchema,
  /** macOS 14.4+ (process taps); below it Oat can't record the other side of a call. */
  systemAudioSupported: z.boolean(),
  /**
   * The Mac's calendars (EventKit), as the calendar service sees them: `off` = this build/config reads no Mac
   * calendar (dev without `OAT_CALENDAR`); `write_only` counts as not enough (Oat needs to read events).
   */
  calendar: eventkitStateSchema,
  /** Google Calendar through the web app (7.4). */
  google: googleCalendarStateSchema,
});
export type PermissionsSnapshot = z.infer<typeof permissionsSnapshotSchema>;

/** Setup state of the signed-in account on this Mac (`<userData>/onboarding.json`). */
export const onboardingStateSchema = z.object({
  /** Show the walkthrough now: this account never finished (or skipped) it on this Mac. */
  needed: z.boolean(),
  /** The first-meeting guide card shows until dismissed (after finishing setup). */
  guide: z.boolean(),
});
export type OnboardingState = z.infer<typeof onboardingStateSchema>;

/**
 * The test recording: `starting` (audio + transcription opening) → `running` (`durationMs`, or until stopped) →
 * `done`; `error` = the audio couldn't start (or stopped by itself). Nothing is saved.
 */
export const TEST_RECORDING_STATUSES = ['idle', 'starting', 'running', 'done', 'error'] as const;
const levelSchema = z.object({ rmsDb: z.number(), peakDb: z.number() });
export const testRecordingSchema = z.object({
  /** +1 per change; windows ignore older pushes. */
  seq: z.number().int().nonnegative(),
  status: z.enum(TEST_RECORDING_STATUSES),
  elapsedMs: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
  levels: z.object({ mic: levelSchema.nullable(), system: levelSchema.nullable() }),
  /** A source was clearly audible at some point (peak above the speech threshold). */
  heard: z.object({ mic: z.boolean(), system: z.boolean() }),
  /** The latest transcript line (interim or final) and whose it is. */
  line: z.object({ source: z.enum(['mic', 'system']), text: z.string().max(2000) }).nullable(),
  /** `live` once a transcription stream opened; `unavailable` when it couldn't start. */
  transcription: z.enum(['off', 'connecting', 'live', 'unavailable']),
  error: z.string().max(500).nullable(),
});
export type TestRecordingSnapshot = z.infer<typeof testRecordingSchema>;

export const onboardingInvokeChannels = {
  /** Current permission states; never prompts. */
  'permissions:get': { request: z.undefined(), response: permissionsSnapshotSchema },
  /**
   * The user clicked "Allow": asks macOS (only when it was never asked — a denied permission can only be
   * changed in System Settings) and resolves with the states after the answer.
   */
  'permissions:request': {
    request: z.strictObject({ kind: permissionKindSchema }),
    response: permissionsSnapshotSchema,
  },
  /** Opens System Settings → Privacy & Security at that permission's pane. */
  'permissions:open-settings': {
    request: z.strictObject({ kind: permissionKindSchema }),
    response: z.undefined(),
  },
  'onboarding:get': { request: z.undefined(), response: onboardingStateSchema },
  /** Setup finished or skipped ("Set up later"): not shown again for this account; `guide` shows the card. */
  'onboarding:complete': {
    request: z.strictObject({ guide: z.boolean() }),
    response: onboardingStateSchema,
  },
  'onboarding:dismiss-guide': { request: z.undefined(), response: onboardingStateSchema },
  /** Starts the test recording (refused while a meeting records). `input`/`fixture` as in `recording:start`. */
  'onboarding:test-start': {
    request: z.strictObject({
      input: z.enum(['sidecar', 'file']).optional(),
      fixture: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
        .optional(),
    }),
    response: testRecordingSchema,
  },
  'onboarding:test-stop': { request: z.undefined(), response: testRecordingSchema },
  'onboarding:test-get': { request: z.undefined(), response: testRecordingSchema },
} as const;

export const onboardingSubscribeChannels = {
  'onboarding:test-state': testRecordingSchema,
  /** The permission states changed (after a request, or when the window came back to the front). */
  'permissions:changed': permissionsSnapshotSchema,
} as const;
