/**
 * The grace period after a stop (task 7.5). A meeting's end (`meeting.ended_at`) is what starts the post-meeting
 * pipeline (8.3: the sync push that sets it triggers the run), so `endMeeting` is held back for `graceMs`
 * (60 s): "Continue recording" meanwhile resumes the same meeting and the end is never written — no run is
 * created. When the period runs out (or "Start now", or another meeting starts, or the app quits / signs out),
 * the end is written with the time recording actually stopped.
 *
 * Durable: every held end is also in `file` (`<userData>/grace-pending.json`) until it is written, so a crash,
 * force-quit or power loss inside the period doesn't leave the meeting open forever. At launch the file's ends
 * are *parked*; `accountOpened(user)` (that account's database is open) writes the ones that are due and re-arms
 * one that isn't. An end whose account's database isn't the open one when it is due is parked the same way
 * (never written into another account's database).
 *
 * A decorator over the recording's `TranscriptPersistence` (`MeetingPersistence`), so `RecordingService`
 * doesn't change. One live pending end at a time (one recording at a time).
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { LiveSegment } from '@oat/core/bridge';
import { z } from 'zod';

import type { Logger } from './ipc.ts';
import type { BeginMeeting, TranscriptPersistence } from './recording-service.ts';

export interface PendingEnd {
  meetingId: string;
  /** When recording stopped (Unix ms). */
  endedAt: number;
  /** When it is written (Unix ms). */
  dueAt: number;
  /** The account whose local database holds the meeting. */
  userId: string | null;
}

const PendingSchema = z.object({
  meetingId: z.string().min(1).max(100),
  endedAt: z.number(),
  dueAt: z.number(),
  userId: z.string().max(200).nullable(),
});
const FileSchema = z.object({ ends: z.array(PendingSchema).max(50) });

/** At most this many parked ends are kept (oldest dropped). */
const MAX_PARKED = 20;

export interface MeetingEndGraceOptions {
  inner: TranscriptPersistence;
  /** Default 60 s. 0 writes ends at once. */
  graceMs?: number;
  /**
   * The account whose local database is open now (`SyncService.storeUser`): an end is only written into the
   * database it was recorded in. Right after a sign-out that is still the old one (`flush` it then).
   */
  userId: () => string | null;
  /** Where held ends survive a crash. Without it they live in memory only. */
  file?: string;
  /** The pending end changed (shown in the meeting view). */
  onChange?: (pending: Readonly<PendingEnd> | null) => void;
  now?: () => number;
  log?: Logger;
}

export const DEFAULT_END_GRACE_MS = 60_000;

export class MeetingEndGrace implements TranscriptPersistence {
  readonly #o: MeetingEndGraceOptions;
  readonly #graceMs: number;
  readonly #now: () => number;
  #pending: PendingEnd | null = null;
  /** Held ends waiting for their account's database (from the file at launch, or parked when due). */
  #parked: PendingEnd[];
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: MeetingEndGraceOptions) {
    this.#o = options;
    this.#graceMs = options.graceMs ?? DEFAULT_END_GRACE_MS;
    this.#now = options.now ?? Date.now;
    this.#parked = this.#load();
  }

  get pending(): Readonly<PendingEnd> | null {
    return this.#pending;
  }

  /** Ends held from an earlier launch (or for an account whose database isn't open). */
  get parked(): readonly PendingEnd[] {
    return this.#parked;
  }

  async prepareMeeting(meetingId: string, requestedAt: number): Promise<BeginMeeting> {
    const beginMeeting = await this.#o.inner.prepareMeeting(meetingId, requestedAt);
    return (startedAt) => {
      this.#clearPreviousEnd(meetingId);
      beginMeeting(startedAt);
    };
  }

  #clearPreviousEnd(meetingId: string): void {
    const pending = this.#pending;
    if (pending?.meetingId === meetingId) {
      // "Continue recording" within the grace period: the meeting never ended.
      this.#set(null);
    } else if (pending) {
      this.flush(); // another meeting starts: the last one is over
    }
    if (this.#parked.some((p) => p.meetingId === meetingId)) {
      // Continued after a relaunch, still unended: the held end no longer applies.
      this.#parked = this.#parked.filter((p) => p.meetingId !== meetingId);
      this.#save();
    }
  }

  saveSegment(meetingId: string, segment: LiveSegment): void {
    this.#o.inner.saveSegment(meetingId, segment);
  }

  meetingEndMs(meetingId: string): number {
    return this.#o.inner.meetingEndMs?.(meetingId) ?? 0;
  }

  endMeeting(meetingId: string, endedAt: number): void {
    if (this.#pending && this.#pending.meetingId !== meetingId) this.flush();
    if (this.#graceMs <= 0) {
      this.#write(meetingId, endedAt);
      return;
    }
    this.#set({
      meetingId,
      endedAt,
      dueAt: this.#now() + this.#graceMs,
      userId: this.#o.userId(),
    });
  }

  /**
   * Writes the pending end now (grace over, "Start now", quit, sign-out, account switch). Returns whether an end
   * was written. With its account's database closed, the end is parked instead.
   */
  flush(meetingId?: string): boolean {
    const pending = this.#pending;
    if (!pending || (meetingId !== undefined && pending.meetingId !== meetingId)) return false;
    this.#pending = null;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    let written = false;
    if (pending.userId !== this.#o.userId()) {
      this.#o.log?.warn(
        `grace: meeting ${pending.meetingId}: its account’s database is closed; ending it when it opens`,
      );
      this.#parked = [...this.#parked, pending].slice(-MAX_PARKED);
    } else {
      written = this.#write(pending.meetingId, pending.endedAt);
    }
    this.#save();
    this.#o.onChange?.(null);
    return written;
  }

  /**
   * `userId`'s database is open now: write its parked ends that are due; one that isn't due yet (a relaunch
   * inside the grace period) becomes the pending end again, with the time it had left.
   */
  accountOpened(userId: string | null): void {
    if (!userId || this.#o.userId() !== userId) return;
    const mine = this.#parked.filter((p) => p.userId === userId);
    if (mine.length === 0) return;
    this.#parked = this.#parked.filter((p) => p.userId !== userId);
    const now = this.#now();
    for (const p of mine) {
      if (p.dueAt > now && !this.#pending) {
        this.#set(p); // saves
        continue;
      }
      this.#write(p.meetingId, p.endedAt);
    }
    this.#save();
  }

  dispose(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #write(meetingId: string, endedAt: number): boolean {
    try {
      this.#o.inner.endMeeting(meetingId, endedAt);
      return true;
    } catch (error) {
      this.#o.log?.error(`grace: could not end meeting ${meetingId}`, error);
      return false;
    }
  }

  #set(pending: PendingEnd | null): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pending = pending;
    if (pending) {
      this.#timer = setTimeout(
        () => this.flush(pending.meetingId),
        Math.max(0, pending.dueAt - this.#now()),
      );
      this.#timer.unref?.();
    }
    this.#save();
    this.#o.onChange?.(pending);
  }

  #load(): PendingEnd[] {
    const file = this.#o.file;
    if (!file) return [];
    try {
      return FileSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).ends;
    } catch {
      return [];
    }
  }

  /** The file holds every end not written yet (atomic replace; removed when there is none). */
  #save(): void {
    const file = this.#o.file;
    if (!file) return;
    const ends = [...this.#parked, ...(this.#pending ? [this.#pending] : [])];
    try {
      if (ends.length === 0) {
        rmSync(file, { force: true });
        return;
      }
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ ends })}\n`);
      renameSync(tmp, file);
    } catch (error) {
      this.#o.log?.warn(`grace: couldn’t save the held meeting ends: ${String(error)}`);
    }
  }
}
