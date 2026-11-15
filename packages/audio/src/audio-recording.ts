/**
 * `audio_recording` metadata (SPEC §6, desktop-only, never synced — D-10, D-24): one row per meeting, source
 * and recording session ("part"). The interface is implemented with SQLite in the desktop app (2.6);
 * `InMemoryAudioRecordingStore` serves tests and the archive's own logic. Pure TS, so the part/seek helpers
 * below can be used by the renderer for playback (3.7).
 */
import type { AudioSourceKind } from './types.ts';

/**
 * - `recording` — the writer has the file open. Still `recording` at app start ⇒ the app crashed.
 * - `complete` — the writer closed the file cleanly.
 * - `partial` — repaired after a crash or a disk error: every valid page up to the failure is kept.
 * - `failed` — the file could never be created (permissions, disk full); there is no audio for this row.
 * - `deleted` — the file was removed (retention, user action — task 3.8); the row stays for the UI.
 */
export type AudioRecordingStatus = 'recording' | 'complete' | 'partial' | 'failed' | 'deleted';

export interface AudioRecording {
  readonly id: string;
  readonly meetingId: string;
  readonly source: AudioSourceKind;
  /**
   * Recording session within the meeting, from 1 (D-24): stopping and resuming a meeting later starts a new
   * part (`<source>.opus`, then `<source>.2.opus`, …). Mic and system rows of one session share the number.
   */
  readonly part: number;
  /**
   * Where this part starts on the meeting clock (ms from the meeting's first recording start — the clock
   * transcript segments use). Meeting time `t` is at `t − offsetMs` in this part's file.
   */
  readonly offsetMs: number;
  /** Absolute path of the `.opus` file. */
  readonly path: string;
  readonly codec: 'opus';
  readonly sampleRate: number;
  /** Wall-clock time the recording session started (Unix ms; informational). */
  readonly startedAt: number;
  /** Length of this part's file; file time 0 = `offsetMs` on the meeting clock. */
  readonly durationMs: number;
  readonly bytes: number;
  readonly status: AudioRecordingStatus;
  /**
   * The account that recorded it (D-30); `null`/absent = unknown (rows from before D-30 that no account has
   * claimed yet). Storage settings and retention only act on the signed-in account's rows.
   */
  readonly userId?: string | null;
}

export type AudioRecordingPatch = Partial<
  Pick<AudioRecording, 'part' | 'path' | 'durationMs' | 'bytes' | 'status' | 'userId'>
>;

export interface AudioRecordingFilter {
  readonly meetingId?: string;
  readonly status?: AudioRecordingStatus | readonly AudioRecordingStatus[];
  /** Rows of this account; `null` = rows with no account (unknown). */
  readonly userId?: string | null;
}

export interface AudioRecordingStore {
  /** Fails if `id` exists. */
  insert(recording: AudioRecording): Promise<void>;
  /** Fails if `id` does not exist. Returns the updated row. */
  update(id: string, patch: AudioRecordingPatch): Promise<AudioRecording>;
  get(id: string): Promise<AudioRecording | undefined>;
  /** Ordered by `startedAt`, then `part`, then `source`. */
  list(filter?: AudioRecordingFilter): Promise<AudioRecording[]>;
}

export class InMemoryAudioRecordingStore implements AudioRecordingStore {
  readonly #rows = new Map<string, AudioRecording>();

  insert(recording: AudioRecording): Promise<void> {
    if (this.#rows.has(recording.id)) {
      return Promise.reject(new Error(`audio_recording ${recording.id} exists`));
    }
    this.#rows.set(recording.id, { ...recording });
    return Promise.resolve();
  }

  update(id: string, patch: AudioRecordingPatch): Promise<AudioRecording> {
    const row = this.#rows.get(id);
    if (!row) return Promise.reject(new Error(`audio_recording ${id} not found`));
    const next = { ...row, ...definedOnly(patch) };
    this.#rows.set(id, next);
    return Promise.resolve({ ...next });
  }

  get(id: string): Promise<AudioRecording | undefined> {
    const row = this.#rows.get(id);
    return Promise.resolve(row ? { ...row } : undefined);
  }

  list(filter: AudioRecordingFilter = {}): Promise<AudioRecording[]> {
    const statuses =
      filter.status === undefined
        ? undefined
        : new Set<AudioRecordingStatus>(
            typeof filter.status === 'string' ? [filter.status] : filter.status,
          );
    const rows = [...this.#rows.values()]
      .filter((r) => filter.meetingId === undefined || r.meetingId === filter.meetingId)
      .filter((r) => !statuses || statuses.has(r.status))
      .filter((r) => filter.userId === undefined || (r.userId ?? null) === filter.userId)
      .sort(
        (a, b) => a.startedAt - b.startedAt || a.part - b.part || a.source.localeCompare(b.source),
      )
      .map((r) => ({ ...r }));
    return Promise.resolve(rows);
  }
}

function definedOnly<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Statuses whose file holds audio to play or read. */
const PLAYABLE: ReadonlySet<AudioRecordingStatus> = new Set(['complete', 'partial', 'recording']);

/** One source's parts that have audio, ordered on the meeting clock. */
export function meetingParts(
  recordings: readonly AudioRecording[],
  source: AudioSourceKind,
): AudioRecording[] {
  return recordings
    .filter((r) => r.source === source && PLAYABLE.has(r.status))
    .sort((a, b) => a.offsetMs - b.offsetMs || a.part - b.part);
}

/** Part number for a new recording session of a meeting, given all its rows (any source, any status). */
export function nextPart(recordings: readonly AudioRecording[]): number {
  return recordings.reduce((max, r) => Math.max(max, r.part), 0) + 1;
}

export interface MeetingTimeLocation {
  readonly recording: AudioRecording;
  readonly part: number;
  /** Position in that part's file, ms. */
  readonly fileMs: number;
}

/**
 * Maps a meeting-clock time (e.g. a transcript segment's `startMs`) to (part, position in its file) for one
 * source — what playback (3.7) seeks to. `undefined` when no part covers it (between sessions, or past the
 * end); `nextPartAfter` then tells where audio resumes.
 */
export function locateMeetingTime(
  recordings: readonly AudioRecording[],
  source: AudioSourceKind,
  meetingMs: number,
): MeetingTimeLocation | undefined {
  let found: AudioRecording | undefined;
  for (const r of meetingParts(recordings, source)) {
    if (r.offsetMs <= meetingMs && meetingMs < r.offsetMs + r.durationMs) found = r; // a later part wins
  }
  return found && { recording: found, part: found.part, fileMs: meetingMs - found.offsetMs };
}

/** The first part of `source` that starts after `meetingMs` (to skip a gap between sessions). */
export function nextPartAfter(
  recordings: readonly AudioRecording[],
  source: AudioSourceKind,
  meetingMs: number,
): AudioRecording | undefined {
  return meetingParts(recordings, source).find((r) => r.offsetMs > meetingMs);
}
