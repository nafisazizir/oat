/**
 * Main-process side of the live transcript (2.5): keeps the active meeting's segments (`TranscriptStore`)
 * and pushes changes to windows as **batches**: segments arriving within `batchMs` go out together, and
 * several updates of one id inside a batch collapse to the newest (an interim refreshed five times in
 * 50 ms is sent once). Each batch has `seq` = previous + 1, so a window that loaded a snapshot
 * (`transcript:get`, which flushes first) knows exactly which batches it still needs.
 */
import type { TranscriptBatch, LiveSegment, TranscriptSnapshot } from '@oat/core/bridge';

import { TranscriptStore } from '../shared/transcript.ts';

export interface TranscriptBufferOptions {
  onBatch: (batch: TranscriptBatch) => void;
  /** Default 50 ms: well inside the 1.5 s latency budget, ~20 IPC messages per second at most. */
  batchMs?: number;
  /** Injectable timer (tests). Returns a cancel function. */
  setTimer?: (fn: () => void, ms: number) => () => void;
}

const MAX_BATCH = 5000;

export class TranscriptBuffer {
  readonly #store = new TranscriptStore();
  readonly #pending = new Map<string, LiveSegment>();
  readonly #onBatch: (batch: TranscriptBatch) => void;
  readonly #batchMs: number;
  readonly #setTimer: (fn: () => void, ms: number) => () => void;
  #meetingId: string | null = null;
  #seq = 0;
  #cancel: (() => void) | null = null;

  constructor(options: TranscriptBufferOptions) {
    this.#onBatch = options.onBatch;
    this.#batchMs = options.batchMs ?? 50;
    this.#setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      });
  }

  get meetingId(): string | null {
    return this.#meetingId;
  }

  /** Live segments of the current meeting (time order). */
  get segments(): readonly LiveSegment[] {
    return this.#store.segments;
  }

  /** Switches to another meeting: drops the old transcript (persisting it is 2.6) and restarts `seq`. */
  reset(meetingId: string | null): void {
    this.#cancel?.();
    this.#cancel = null;
    this.#pending.clear();
    this.#store.clear();
    this.#meetingId = meetingId;
    this.#seq = 0;
  }

  push(segment: LiveSegment): void {
    if (this.#meetingId === null) return;
    // Same rule as `TranscriptStore`: a final (pending or sent) is never replaced by an interim.
    if (
      !segment.isFinal &&
      (this.#pending.get(segment.id)?.isFinal || this.#store.get(segment.id)?.isFinal)
    ) {
      return;
    }
    this.#pending.delete(segment.id); // keep arrival order of the newest update
    this.#pending.set(segment.id, segment);
    if (this.#pending.size >= MAX_BATCH) {
      this.flush();
      return;
    }
    this.#cancel ??= this.#setTimer(() => {
      this.#cancel = null;
      this.flush();
    }, this.#batchMs);
  }

  /** Sends what is pending now. */
  flush(): void {
    this.#cancel?.();
    this.#cancel = null;
    if (this.#pending.size === 0 || this.#meetingId === null) return;
    const segments = [...this.#pending.values()];
    this.#pending.clear();
    this.#store.apply(segments);
    this.#seq += 1;
    this.#onBatch({ meetingId: this.#meetingId, seq: this.#seq, segments });
  }

  /** Everything so far (pending segments are flushed first, so `seq` lines up with the batches). */
  snapshot(): TranscriptSnapshot {
    this.flush();
    return { meetingId: this.#meetingId, seq: this.#seq, segments: [...this.#store.segments] };
  }
}
