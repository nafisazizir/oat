/**
 * Transcript back-fill jobs and crash recoveries (task 2.7), kept in the never-wiped audio index next to the
 * `audio_recording` rows they refer to (D-28): a job survives quitting, a crash and a cache rebuild. (Not to
 * be confused with the sync "backfill" of 3.5, which fetches a note's subtree from the server.)
 *
 * - A job = one source's meeting-clock range whose live transcription was lost (STT outage longer than the
 *   replay buffer, a stream that never recovered before stop, the tail of a crashed recording). It is
 *   transcribed from the archive in chunks; `doneMs` is the cursor, so a quit mid-job resumes there.
 * - A recovery = a recording the app crashed out of: its audio was repaired at startup; the meeting is closed
 *   and its tail queued once that account's database is open (`appliedAt`).
 */
import type { AudioSourceKind } from '@oat/audio';

export type TranscriptJobStatus = 'pending' | 'done' | 'failed';

/** Why the range wasn't transcribed live. */
export type TranscriptJobReason =
  /** The live stream was offline longer than its replay buffer. */
  | 'stt_offline'
  /** The live stream ended without finalizing its audio (stopped while offline, fatal error, timeout). */
  | 'stt_incomplete'
  /** No STT provider at all for the session. */
  | 'stt_unavailable'
  /** Frames never reached the STT stream (its queue overflowed). */
  | 'stt_dropped'
  /** The app quit unexpectedly while recording. */
  | 'crash';

export interface TranscriptJob {
  readonly id: string;
  readonly meetingId: string;
  /** The account that recorded the meeting (D-30); only that account's session runs the job. */
  readonly userId: string | null;
  readonly source: AudioSourceKind;
  /** Meeting clock (ms). */
  readonly startMs: number;
  readonly endMs: number;
  /** Everything before this has been transcribed (startMs ≤ doneMs ≤ endMs). */
  readonly doneMs: number;
  readonly reason: TranscriptJobReason;
  readonly status: TranscriptJobStatus;
  /** Failed attempts so far (reset by progress). */
  readonly attempts: number;
  /** Not before this (Unix ms): retry backoff. */
  readonly nextAt: number;
  /** Segments added so far. */
  readonly segments: number;
  /** Last failure, user-facing. */
  readonly error: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type TranscriptJobPatch = Partial<
  Pick<
    TranscriptJob,
    'doneMs' | 'status' | 'attempts' | 'nextAt' | 'segments' | 'error' | 'updatedAt'
  >
>;

export interface RecoveredPart {
  readonly source: AudioSourceKind;
  readonly part: number;
  /** Meeting clock of the part's start and of the end of its repaired audio. */
  readonly offsetMs: number;
  readonly endMs: number;
  /** Wall clock (Unix ms) of the part's start. */
  readonly startedAt: number;
}

export interface RecordingRecovery {
  readonly id: string;
  readonly meetingId: string;
  readonly userId: string | null;
  readonly recoveredAt: number;
  /** Wall clock (Unix ms) the repaired audio reaches: "recording saved up to 10:42". */
  readonly savedUntil: number;
  readonly parts: readonly RecoveredPart[];
  readonly appliedAt: number | null;
}

export interface TranscriptJobFilter {
  readonly meetingId?: string;
  readonly status?: TranscriptJobStatus | readonly TranscriptJobStatus[];
  /** `null` = jobs with no account. */
  readonly userId?: string | null;
}

export interface TranscriptJobStore {
  insertJob(job: TranscriptJob): void;
  updateJob(id: string, patch: TranscriptJobPatch): TranscriptJob;
  /** Ordered by `createdAt`, then `startMs`. */
  jobs(filter?: TranscriptJobFilter): TranscriptJob[];
  insertRecovery(recovery: RecordingRecovery): void;
  /** `claimFor`: an account taking over a recovery that had none (pre-D-30 audio rows). */
  markRecoveryApplied(id: string, at: number, claimFor?: string): void;
  /** Newest first. */
  recoveries(filter?: {
    meetingId?: string;
    userId?: string | null;
    applied?: boolean;
  }): RecordingRecovery[];
}

const matches = (status: TranscriptJobStatus, f: TranscriptJobFilter['status']) =>
  f === undefined || (typeof f === 'string' ? f === status : f.includes(status));

/** For tests and when the audio index can't be opened (jobs then last for this launch only). */
export class InMemoryTranscriptJobStore implements TranscriptJobStore {
  readonly #jobs = new Map<string, TranscriptJob>();
  readonly #recoveries = new Map<string, RecordingRecovery>();

  insertJob(job: TranscriptJob): void {
    if (this.#jobs.has(job.id)) throw new Error(`job ${job.id} exists`);
    this.#jobs.set(job.id, { ...job });
  }

  updateJob(id: string, patch: TranscriptJobPatch): TranscriptJob {
    const current = this.#jobs.get(id);
    if (!current) throw new Error(`job ${id} not found`);
    const next = {
      ...current,
      ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    } as TranscriptJob;
    this.#jobs.set(id, next);
    return next;
  }

  jobs(filter: TranscriptJobFilter = {}): TranscriptJob[] {
    return [...this.#jobs.values()]
      .filter(
        (j) =>
          (filter.meetingId === undefined || j.meetingId === filter.meetingId) &&
          matches(j.status, filter.status) &&
          (filter.userId === undefined || j.userId === filter.userId),
      )
      .sort((a, b) => a.createdAt - b.createdAt || a.startMs - b.startMs)
      .map((j) => ({ ...j }));
  }

  insertRecovery(recovery: RecordingRecovery): void {
    this.#recoveries.set(recovery.id, { ...recovery });
  }

  markRecoveryApplied(id: string, at: number, claimFor?: string): void {
    const r = this.#recoveries.get(id);
    if (r) this.#recoveries.set(id, { ...r, appliedAt: at, userId: r.userId ?? claimFor ?? null });
  }

  recoveries(
    filter: { meetingId?: string; userId?: string | null; applied?: boolean } = {},
  ): RecordingRecovery[] {
    return [...this.#recoveries.values()]
      .filter(
        (r) =>
          (filter.meetingId === undefined || r.meetingId === filter.meetingId) &&
          (filter.userId === undefined || r.userId === filter.userId) &&
          (filter.applied === undefined || (r.appliedAt !== null) === filter.applied),
      )
      .sort((a, b) => b.recoveredAt - a.recoveredAt);
  }
}
