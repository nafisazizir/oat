/**
 * Desktop bridge channels for listening back to a meeting's local audio (task 3.7, D-10, D-24, D-30).
 * Spread into `bridgeContract` (`bridge.ts`).
 *
 * `playback:open` returns the meeting's audio timeline (parts on the meeting clock, gaps between them) and a
 * capability URL `oat-audio://<token>/` that only main can mint: the renderer's `<audio>` element loads
 * `<url><source>.wav` (`mic`, `system` or `mix`), a WAV of the whole meeting clock decoded from the signed-in
 * account's Ogg Opus parts on the fly. No file path ever crosses the bridge; the token names a meeting of the
 * account that opened it and stops working when that account signs out or switches.
 */
import { z } from 'zod';

import { AUDIO_AVAILABILITY } from './bridge-storage.ts';

/** Same rule as the archive's folder names (`bridge-storage.ts`). */
const playbackMeetingIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);

/** The custom scheme main serves meeting audio on. */
export const PLAYBACK_SCHEME = 'oat-audio';

/** What the player can play: "me", "them" or both mixed. */
export const PLAYBACK_SOURCES = ['mic', 'system', 'mix'] as const;
export type PlaybackSource = (typeof PLAYBACK_SOURCES)[number];

/** Most parts sent (a meeting resumed this often is pathological; the rest still plays, just unmarked). */
export const PLAYBACK_MAX_PARTS = 500;

/** One recording session (D-24) on the meeting clock. */
export const playbackPartSchema = z.object({
  part: z.number().int().positive(),
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  /** Sources with audio in this part (a source whose file failed or is missing is absent). */
  sources: z.array(z.enum(['mic', 'system'])).max(2),
  /** Some file of this part was repaired after a crash / disk error (or left open by one). */
  partial: z.boolean(),
});
export type PlaybackPart = z.infer<typeof playbackPartSchema>;

export const playbackInfoSchema = z.object({
  meetingId: z.string(),
  /** `storage:audio-status`'s answer; only `available` comes with a URL. */
  status: z.enum(AUDIO_AVAILABILITY),
  /** `oat-audio://<token>/` (append `mic.wav`, `system.wav` or `mix.wav`); `null` unless `available`. */
  url: z
    .string()
    .regex(/^oat-audio:\/\/[0-9a-f]{32}\/$/)
    .nullable(),
  /** Length of the meeting clock covered by audio (the WAV's duration). */
  durationMs: z.number().nonnegative(),
  /** Parts with audio, in meeting-clock order; holes between them are gaps (silence in the WAV). */
  parts: z.array(playbackPartSchema).max(PLAYBACK_MAX_PARTS),
});
export type PlaybackInfo = z.infer<typeof playbackInfoSchema>;

/** Invoke channels (spread into `bridgeContract.invoke`). */
export const playbackInvokeChannels = {
  /**
   * The meeting's audio on this Mac for the signed-in account: timeline + a playback URL, or why there is
   * none (`deleted`, `other-device`, `recording`, `none`). `unauthorized` when signed out.
   */
  'playback:open': {
    request: z.strictObject({ meetingId: playbackMeetingIdSchema }),
    response: playbackInfoSchema,
  },
} as const;
