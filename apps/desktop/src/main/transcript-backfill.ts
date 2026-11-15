/**
 * Transcript back-fill (task 2.7, D-17): what live transcription lost — an STT outage longer than the replay
 * buffer, a stream that never finalized before stop, the tail of a recording the app crashed out of — is
 * re-transcribed from the local Opus archive with the provider's batch API and merged into the meeting's
 * transcript. Electron-free; wired in `index.ts`.
 *
 * - Queue: jobs live in the audio index (`TranscriptJobStore`, never wiped, survives quit/crash). A new gap
 *   is cut against the meeting's existing jobs of that source, so overlapping reports never queue audio
 *   twice. Only the recording account's session runs its jobs (D-30), with that account's database open.
 * - Runner: one job at a time, in chunks of `chunkMs` (5 min) read with `readMeetingRange` (across parts;
 *   the part still being recorded is readable up to a few seconds behind live). Each chunk: transcribe →
 *   `mergeBackfill` against the stored finals of that source (dedupe by word midpoint, stable ids) → save
 *   as `backfilled` finals (outbox → sync) → advance the job's cursor. A quit mid-job resumes at the cursor;
 *   re-running a chunk can't duplicate (its words now overlap stored segments).
 * - Failures (STT still down, no token, …) retry with backoff (5 s → 5 min) and on every `kick()` (a stream
 *   reconnected, a recording stopped, the account changed); after `maxAttempts` the job is `failed` and says
 *   so in the transcript panel. Audio that is gone (deleted by retention/user) fails the job at once.
 * - Crash recoveries (`recording-recovery.ts` repaired the files at launch) are applied here once the
 *   account's database is open: the meeting gets its `ended_at`, the tail after the last stored final is
 *   queued (`crash`).
 */
import {
  type AudioRecording,
  type AudioRecordingFilter,
  type AudioRecordingStore,
  type AudioSourceKind,
  readMeetingRange,
} from '@oat/audio/node';
import type { LiveSegment, TranscriptBackfillStatus } from '@oat/core/bridge';
import {
  type LocalStore,
  type RecordingRecovery,
  type TranscriptJob,
  type TranscriptJobReason,
  type TranscriptJobStore,
  uuidv7,
} from '@oat/local-store';
import { SttBatchError, type SttProvider } from '@oat/stt';

import type { Logger } from './ipc.ts';
import { MIN_GAP_MS, mergeBackfill, mergeSpans, subtractSpans } from './transcript-gaps.ts';

export interface TranscriptBackfillOptions {
  jobs: TranscriptJobStore;
  audio: AudioRecordingStore;
  /** The meeting whose audio is in use (a recovery isn't applied to it meanwhile). */
  busyMeetingId?: () => string | null;
  /** The session being recorded now (`RecordingService.liveAudio`). */
  liveAudio: () => { meetingId: string; offsetMs: number; durationMs: number } | null;
  /** A provider with `transcribe` (the same STT deployment as live; mock in dev). */
  createProvider: (userId: string) => Promise<SttProvider>;
  /** The signed-in account whose local database is open, else `null` (nothing runs). */
  currentUser: () => string | null;
  /** That account's database. */
  store: () => LocalStore | null;
  /** Segments were added to a meeting (show them live; sync). */
  onSegments?: (meetingId: string, segments: LiveSegment[]) => void;
  /** A meeting's back-fill status or recovery changed (windows reload). Debounced per meeting. */
  onChange?: (meetingId: string) => void;
  /** `onChange` debounce. Default 500 ms. */
  changeDebounceMs?: number;
  /** A meeting row changed (recovery closed it). */
  onMeetingChanged?: () => void;
  log: Logger;
  now?: () => number;
  /** Audio per batch request. Default 5 min. */
  chunkMs?: number;
  /** Wait after `kick()` before running (lets a reconnect settle). Default 1000. */
  startDelayMs?: number;
  /** Retry backoff. Default 5 s doubling to 5 min. */
  retryInitialMs?: number;
  retryMaxMs?: number;
  /** Failed attempts before a job is given up (`failed`). Default 10. */
  maxAttempts?: number;
  /** The last few seconds of a part being recorded may not be on disk yet. Default 3000. */
  liveMarginMs?: number;
}

/** A range to queue (meeting clock). */
export interface BackfillGap {
  meetingId: string;
  userId: string | null;
  source: AudioSourceKind;
  startMs: number;
  endMs: number;
  reason: TranscriptJobReason;
}

const MESSAGES = {
  audioGone: 'The audio of this part is no longer on this Mac.',
  unsupported: 'This transcription service can’t transcribe saved audio.',
  offline: 'Transcription is unavailable right now.',
  refused: 'Transcription refused the request.',
};

export class TranscriptBackfill {
  readonly #o: TranscriptBackfillOptions;
  readonly #now: () => number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #again = false;
  #retryNow = false;
  #stopped = false;
  /** Job being worked on (for the status: "running"). */
  #current: TranscriptJob | undefined;
  readonly #changeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: TranscriptBackfillOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
  }

  // --- queue ---------------------------------------------------------------------------------------

  /**
   * Queues what of `gap` isn't queued yet for that meeting and source (pending or done jobs; failed ones
   * may be retried by a new report). Returns the new jobs. Kicks the runner.
   */
  enqueue(gap: BackfillGap): TranscriptJob[] {
    const existing = this.#o.jobs
      .jobs({ meetingId: gap.meetingId })
      .filter((j) => j.source === gap.source && j.status !== 'failed');
    const pieces = subtractSpans(
      { startMs: Math.max(0, Math.round(gap.startMs)), endMs: Math.round(gap.endMs) },
      existing,
    ).filter((p) => p.endMs - p.startMs >= MIN_GAP_MS);
    const at = this.#now();
    const created: TranscriptJob[] = [];
    for (const p of pieces) {
      const job: TranscriptJob = {
        id: uuidv7(),
        meetingId: gap.meetingId,
        userId: gap.userId,
        source: gap.source,
        startMs: p.startMs,
        endMs: p.endMs,
        doneMs: p.startMs,
        reason: gap.reason,
        status: 'pending',
        attempts: 0,
        nextAt: 0,
        segments: 0,
        error: null,
        createdAt: at,
        updatedAt: at,
      };
      try {
        this.#o.jobs.insertJob(job);
        created.push(job);
      } catch (error) {
        this.#o.log.error('backfill: could not queue a transcript gap', error);
      }
    }
    if (created.length > 0) {
      this.#o.log.info(
        `backfill: queued ${created.length} range(s) of ${gap.source} (${Math.round(
          created.reduce((n, j) => n + j.endMs - j.startMs, 0) / 1000,
        )} s, ${gap.reason}) for meeting ${gap.meetingId}`,
      );
      this.#changed(gap.meetingId);
      this.kick();
    }
    return created;
  }

  /** What the transcript panel shows for a meeting: the signed-in account's jobs and recoveries (D-30). */
  status(meetingId: string): TranscriptBackfillStatus {
    const user = this.#o.currentUser();
    let pendingMs = 0;
    let doneMs = 0;
    let failedMs = 0;
    let segments = 0;
    let error: string | null = null;
    let retrying = false;
    for (const j of user ? this.#o.jobs.jobs({ meetingId, userId: user }) : []) {
      segments += j.segments;
      if (j.status === 'pending') {
        pendingMs += j.endMs - j.doneMs;
        doneMs += j.doneMs - j.startMs;
        if (j.attempts > 0) {
          retrying = true;
          error = j.error;
        }
      } else if (j.status === 'done') doneMs += j.endMs - j.startMs;
      else {
        failedMs += j.endMs - j.doneMs;
        doneMs += j.doneMs - j.startMs;
        error = j.error;
      }
    }
    const recovery = user ? this.#o.jobs.recoveries({ meetingId, userId: user })[0] : undefined;
    return {
      meetingId,
      pendingMs: Math.round(pendingMs),
      doneMs: Math.round(doneMs),
      failedMs: Math.round(failedMs),
      segments,
      running: this.#current?.meetingId === meetingId,
      retrying,
      error,
      recoveredAt: recovery?.recoveredAt ?? null,
      savedUntil: recovery?.savedUntil ?? null,
    };
  }

  // --- runner --------------------------------------------------------------------------------------

  /**
   * Run pending jobs soon (a new job, a recording stopped, the account changed). `retryNow`: also jobs
   * waiting out a retry backoff (transcription just came back).
   */
  kick(delayMs = this.#o.startDelayMs ?? 1000, retryNow = false): void {
    if (this.#stopped) return;
    if (retryNow) this.#retryNow = true;
    if (this.#running) {
      this.#again = true;
      return;
    }
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#runLoop();
    }, delayMs);
    this.#timer.unref?.();
  }

  stop(): void {
    this.#stopped = true;
    for (const timer of this.#changeTimers.values()) clearTimeout(timer);
    this.#changeTimers.clear();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** Resolves when nothing is running (tests). */
  async idle(): Promise<void> {
    while (this.#running || this.#timer) {
      await (this.#running ?? new Promise((r) => setTimeout(r, 10)));
    }
  }

  /** Runs the queue now (tests; `kick` is the normal way). */
  runNow(): Promise<void> {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    return this.#runLoop();
  }

  async #runLoop(): Promise<void> {
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#running = (async () => {
      do {
        this.#again = false;
        await this.#runOnce();
      } while (this.#again && !this.#stopped);
    })()
      .catch((error: unknown) => this.#o.log.error('backfill: run failed', error))
      .finally(() => {
        this.#running = undefined;
        this.#scheduleRetry();
      });
    return this.#running;
  }

  async #runOnce(): Promise<void> {
    // D-30: the run is bound to this account and its database; a switch stops it (jobs stay pending).
    const user = this.#o.currentUser();
    const store = this.#o.store();
    if (!user || !store) return;
    const owner = () =>
      !this.#stopped && this.#o.currentUser() === user && this.#o.store() === store;
    this.applyRecoveries();
    const retryNow = this.#retryNow;
    this.#retryNow = false;
    let provider: SttProvider | undefined;
    for (const job of this.#o.jobs.jobs({ status: 'pending', userId: user })) {
      if (!owner()) return;
      if (job.nextAt > this.#now() && !retryNow) continue;
      try {
        provider ??= await this.#o.createProvider(user);
      } catch (error) {
        if (!owner()) return;
        this.#fail(job, error);
        continue;
      }
      await this.#runJob(job, provider, store, owner);
    }
  }

  /** The earliest pending retry of the current account. */
  #scheduleRetry(): void {
    if (this.#stopped || this.#timer) return;
    const user = this.#o.currentUser();
    if (!user) return;
    const next = this.#o.jobs
      .jobs({ status: 'pending', userId: user })
      .reduce((min, j) => Math.min(min, j.nextAt), Infinity);
    if (next === Infinity) return;
    this.kick(Math.max(this.#o.startDelayMs ?? 1000, next - this.#now()));
  }

  async #runJob(
    initial: TranscriptJob,
    provider: SttProvider,
    store: LocalStore,
    owner: () => boolean,
  ): Promise<void> {
    let job = initial;
    this.#current = job;
    this.#changed(job.meetingId);
    try {
      if (!provider.transcribe) {
        this.#update(job, { status: 'failed', error: MESSAGES.unsupported });
        return;
      }
      const chunkMs = this.#o.chunkMs ?? 300_000;
      while (job.doneMs < job.endMs) {
        if (!owner()) return; // account switched: leave the job as it is
        const live = this.#o.liveAudio();
        const recordingThis = live?.meetingId === job.meetingId;
        const to = Math.min(job.endMs, job.doneMs + chunkMs);
        const range = await readMeetingRange(
          this.#view(live),
          job.meetingId,
          job.source,
          job.doneMs,
          to,
        );
        if (range.covered.length === 0) {
          if (recordingThis) {
            // Not on disk yet (the part being recorded): later.
            job = this.#update(job, { nextAt: this.#now() + 10_000 });
            return;
          }
          const rows = await this.#o.audio.list({ meetingId: job.meetingId });
          if (
            !rows.some(
              (r) => r.source === job.source && r.status !== 'deleted' && r.status !== 'failed',
            )
          ) {
            job = this.#update(job, { status: 'failed', error: MESSAGES.audioGone });
            return;
          }
          // No part covers this stretch (between sessions): nothing to transcribe.
          job = this.#update(job, { doneMs: to, attempts: 0, error: null });
          continue;
        }
        let added = 0;
        if (range.pcm.some((v) => v !== 0)) {
          const result = await provider.transcribe({
            source: job.source,
            pcm: range.pcm,
            sampleRate: range.sampleRate,
            offsetMs: range.startMs,
          });
          if (!owner()) return; // switched while transcribing: never write into another account
          added = this.#save(
            store,
            job,
            { startMs: range.startMs, endMs: range.endMs },
            result.segments,
          );
        }
        // The rest of a part being recorded isn't readable yet; a finished meeting simply ends here.
        const reached = range.endMs < to && !recordingThis ? to : range.endMs;
        if (reached <= job.doneMs) {
          job = this.#update(job, { nextAt: this.#now() + 10_000 });
          return;
        }
        job = this.#update(job, {
          doneMs: reached,
          segments: job.segments + added,
          attempts: 0,
          error: null,
          ...(reached >= job.endMs ? { status: 'done' as const } : {}),
        });
        this.#changed(job.meetingId);
      }
      if (job.status !== 'done') job = this.#update(job, { status: 'done' });
      this.#o.log.info(
        `backfill: ${job.source} ${Math.round(job.startMs / 1000)}–${Math.round(job.endMs / 1000)} s of meeting ${job.meetingId} done (${job.segments} segments)`,
      );
    } catch (error) {
      // A failure caused by (or seen after) an account switch isn't this job's fault: no attempt counted.
      if (owner()) this.#fail(job, error);
      else this.#o.log.info(`backfill: account changed; ${job.id} stays pending`);
    } finally {
      this.#current = undefined;
      this.#changed(job.meetingId);
    }
  }

  /** Announces a meeting's status change, at most once per `changeDebounceMs` (windows reload). */
  #changed(meetingId: string): void {
    if (!this.#o.onChange || this.#changeTimers.has(meetingId)) return;
    const timer = setTimeout(() => {
      this.#changeTimers.delete(meetingId);
      this.#o.onChange?.(meetingId);
    }, this.#o.changeDebounceMs ?? 500);
    timer.unref?.();
    this.#changeTimers.set(meetingId, timer);
  }

  /** Stores a chunk's segments (deduped against what is there) as back-filled finals. Returns the count. */
  #save(
    store: LocalStore,
    job: TranscriptJob,
    range: { startMs: number; endMs: number },
    segments: Parameters<typeof mergeBackfill>[0]['segments'],
  ): number {
    if (!store.meeting(job.meetingId)) {
      throw new Error('the meeting isn’t in the local database');
    }
    const existing = store
      .segments(job.meetingId)
      .filter(
        (s) =>
          s.source === job.source &&
          s.endMs > range.startMs - 60_000 &&
          s.startMs < range.endMs + 60_000,
      );
    const merged = mergeBackfill({
      meetingId: job.meetingId,
      source: job.source,
      range,
      segments,
      existing,
    });
    if (merged.length === 0) return 0;
    store.transaction(() => {
      for (const s of merged) {
        store.saveSegment({
          id: s.id,
          meetingId: job.meetingId,
          source: s.source,
          speakerLabel: null,
          startMs: s.startMs,
          endMs: s.endMs,
          text: s.text,
          backfilled: true,
        });
      }
    });
    this.#o.onSegments?.(
      job.meetingId,
      merged.map((s) => ({ ...s, isFinal: true, backfilled: true })),
    );
    return merged.length;
  }

  #fail(job: TranscriptJob, error: unknown): void {
    const batch = error instanceof SttBatchError ? error : undefined;
    const attempts = job.attempts + 1;
    const max = this.#o.maxAttempts ?? 10;
    const message = batch
      ? batch.retryable
        ? MESSAGES.offline
        : MESSAGES.refused
      : error instanceof Error && /local database/.test(error.message)
        ? 'The note isn’t on this Mac yet.'
        : MESSAGES.offline;
    const initial = this.#o.retryInitialMs ?? 5000;
    const cap = this.#o.retryMaxMs ?? 300_000;
    // A refusal (auth, quota, bad request) won't fix itself in seconds: wait the longest.
    const delay = batch && !batch.retryable ? cap : Math.min(cap, initial * 2 ** (attempts - 1));
    this.#o.log.warn(
      `backfill: ${job.source} of meeting ${job.meetingId} failed (attempt ${attempts}): ${String(error)}`,
    );
    this.#update(job, {
      attempts,
      error: message,
      nextAt: this.#now() + delay,
      ...(attempts >= max ? { status: 'failed' as const } : {}),
    });
  }

  #update(
    job: TranscriptJob,
    patch: Parameters<TranscriptJobStore['updateJob']>[1],
  ): TranscriptJob {
    return this.#o.jobs.updateJob(job.id, { ...patch, updatedAt: this.#now() });
  }

  /** The audio index, with the part being recorded readable up to a few seconds behind live. */
  #view(live: ReturnType<TranscriptBackfillOptions['liveAudio']>): AudioRecordingStore {
    const audio = this.#o.audio;
    const margin = this.#o.liveMarginMs ?? 3000;
    const patch = (r: AudioRecording): AudioRecording =>
      live &&
      r.status === 'recording' &&
      r.meetingId === live.meetingId &&
      Math.abs(r.offsetMs - live.offsetMs) < 1
        ? { ...r, durationMs: Math.max(0, live.durationMs - margin) }
        : r;
    return {
      insert: (r) => audio.insert(r),
      update: (id, p) => audio.update(id, p),
      get: async (id) => {
        const r = await audio.get(id);
        return r && patch(r);
      },
      list: async (filter?: AudioRecordingFilter) => (await audio.list(filter)).map(patch),
    };
  }

  // --- crash recoveries ------------------------------------------------------------------------------

  /**
   * Applies the current account's crash recoveries whose meeting is in its database: `ended_at` = where
   * the saved audio / stored transcript ends (if it is still open), and the tail of each repaired part
   * after the last stored final of its source is queued. Idempotent (marked applied).
   */
  applyRecoveries(): void {
    const user = this.#o.currentUser();
    const store = this.#o.store();
    if (!user || !store) return;
    const mine = this.#o.jobs.recoveries({ userId: user, applied: false });
    // Audio rows from before D-30 have no account: the account that owns the meeting's note claims them.
    const unclaimed = this.#o.jobs.recoveries({ userId: null, applied: false }).filter((r) => {
      const meeting = store.meeting(r.meetingId);
      return !!meeting && store.document(meeting.documentId)?.ownerId === user;
    });
    for (const found of [...mine, ...unclaimed]) {
      const recovery = { ...found, userId: user };
      const meeting = store.meeting(recovery.meetingId);
      // Not in this database (yet): the next sync may bring it.
      if (!meeting || this.#o.busyMeetingId?.() === recovery.meetingId) continue;
      try {
        this.#applyRecovery(store, recovery, meeting.endedAt === null);
        this.#o.jobs.markRecoveryApplied(recovery.id, this.#now(), user);
        this.#changed(recovery.meetingId);
      } catch (error) {
        this.#o.log.error(`backfill: could not apply the recovery of ${recovery.meetingId}`, error);
      }
    }
  }

  #applyRecovery(store: LocalStore, recovery: RecordingRecovery, close: boolean): void {
    const segments = store.segments(recovery.meetingId);
    let endedAt = recovery.savedUntil;
    for (const part of recovery.parts) {
      const finals = segments.filter(
        (s) => s.source === part.source && s.startMs >= part.offsetMs - 1 && s.startMs < part.endMs,
      );
      const lastEnd = finals.reduce((n, s) => Math.max(n, s.endMs), part.offsetMs);
      endedAt = Math.max(endedAt, part.startedAt + (lastEnd - part.offsetMs));
      // The tail after the last final was never finalized live (or STT was down until the crash).
      const covered = mergeSpans(finals);
      const tail = subtractSpans({ startMs: lastEnd, endMs: part.endMs }, covered);
      for (const piece of tail) {
        this.enqueue({
          meetingId: recovery.meetingId,
          userId: recovery.userId,
          source: part.source,
          startMs: piece.startMs,
          endMs: piece.endMs,
          reason: 'crash',
        });
      }
    }
    if (
      close &&
      store.updateMeeting(recovery.meetingId, { endedAt: new Date(endedAt).toISOString() })
    ) {
      this.#o.log.info(`backfill: closed meeting ${recovery.meetingId} left open by a crash`);
      this.#o.onMeetingChanged?.();
    }
  }
}
