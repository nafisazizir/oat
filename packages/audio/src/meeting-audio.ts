/**
 * Meeting-level access to a multi-part archive (D-24): a meeting recorded in several sessions has one file per
 * source and session, each placed on the meeting clock by its row's `offsetMs`. These helpers read a meeting
 * time range across parts (archive backfill, 2.9) and map a meeting time to (part, byte offset) for playback
 * (3.7). Node only.
 */
import {
  locateMeetingTime,
  meetingParts,
  type AudioRecording,
  type AudioRecordingStore,
  type MeetingTimeLocation,
} from './audio-recording.ts';
import { isOpusSampleRate } from './ogg-opus.ts';
import { opusSeekOffset, probeOpusFile, readOpusRange } from './opus-reader.ts';
import { DEFAULT_SAMPLE_RATE, type AudioSourceKind } from './types.ts';

export interface MeetingRange {
  /** Mono PCM for [startMs, endMs) on the meeting clock; zeros where no part has audio. */
  readonly pcm: Int16Array;
  readonly sampleRate: number;
  readonly startMs: number;
  /** Clamped to the end of the last part. */
  readonly endMs: number;
  /** The meeting-clock spans that came from a part (everything else in `pcm` is a hole). */
  readonly covered: readonly {
    readonly part: number;
    readonly startMs: number;
    readonly endMs: number;
  }[];
}

export interface MeetingRangeOptions {
  /** Output rate (8/12/16/24/48 kHz). Default: the parts' rate, else 16 kHz. */
  sampleRate?: number;
}

/**
 * Decodes [startMs, endMs) of one source of a meeting, on the meeting clock, across all of its parts.
 * Times between sessions (or lost to a failed part) come back as silence and are absent from `covered`.
 */
export async function readMeetingRange(
  store: AudioRecordingStore,
  meetingId: string,
  source: AudioSourceKind,
  startMs = 0,
  endMs = Number.POSITIVE_INFINITY,
  options: MeetingRangeOptions = {},
): Promise<MeetingRange> {
  const parts = meetingParts(await store.list({ meetingId }), source);
  const firstRate = parts[0]?.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const rate =
    options.sampleRate ?? (isOpusSampleRate(firstRate) ? firstRate : DEFAULT_SAMPLE_RATE);
  const meetingEnd = parts.reduce((n, p) => Math.max(n, p.offsetMs + p.durationMs), 0);
  const start = Math.max(0, Math.min(startMs, meetingEnd));
  const end = Math.max(start, Math.min(endMs, meetingEnd));
  const from = Math.round((start * rate) / 1000);
  const pcm = new Int16Array(Math.round((end * rate) / 1000) - from);
  const covered: { part: number; startMs: number; endMs: number }[] = [];
  for (const part of parts) {
    const lo = Math.max(start, part.offsetMs);
    const hi = Math.min(end, part.offsetMs + part.durationMs);
    if (hi <= lo) continue;
    const range = await readOpusRange(part.path, lo - part.offsetMs, hi - part.offsetMs, {
      sampleRate: rate,
    });
    const at = Math.round(((part.offsetMs + range.startMs) * rate) / 1000) - from;
    const n = Math.min(range.pcm.length, pcm.length - at);
    if (n > 0) pcm.set(range.pcm.subarray(0, n), at);
    covered.push({
      part: part.part,
      startMs: part.offsetMs + range.startMs,
      endMs: part.offsetMs + range.endMs,
    });
  }
  return { pcm, sampleRate: rate, startMs: start, endMs: end, covered };
}

export interface MeetingSeek extends MeetingTimeLocation {
  /** Byte offset in the part's file where a decoder seeking to `fileMs` starts reading (80 ms pre-roll). */
  readonly byteOffset: number;
}

/**
 * Maps a meeting-clock time (e.g. a transcript segment's `startMs`) to the part that holds it, the time in
 * that file, and the byte offset to read from. `undefined` when no part of `source` covers it.
 */
export async function meetingSeek(
  recordings: readonly AudioRecording[],
  source: AudioSourceKind,
  meetingMs: number,
): Promise<MeetingSeek | undefined> {
  const location = locateMeetingTime(recordings, source, meetingMs);
  if (!location) return undefined;
  const stream = await probeOpusFile(location.recording.path);
  return { ...location, byteOffset: opusSeekOffset(stream, location.fileMs) };
}
