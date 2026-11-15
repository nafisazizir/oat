import type { AudioFrame } from '@oat/audio';

import { BaseSttStream } from './stream-base.ts';
import {
  SttBatchError,
  type SttBatchRequest,
  type SttBatchResult,
  type SttErrorCode,
  type SttProvider,
  type SttSegmentData,
  type SttSource,
  type SttStream,
  type SttStreamOptions,
  type SttWord,
} from './types.ts';

/** One line of ground truth, as in `fixtures/audio/*.segments.json` (recording-clock ms). */
export interface GroundTruthSegment {
  source: SttSource;
  startMs: number;
  endMs: number;
  text: string;
}

/** Validates ground-truth JSON (e.g. a fixture's `*.segments.json`). */
export function parseGroundTruth(json: unknown): GroundTruthSegment[] {
  if (!Array.isArray(json)) throw new TypeError('ground truth must be an array');
  return json.map((item: unknown, i) => {
    const s = item as Partial<GroundTruthSegment> | null;
    if (
      !s ||
      (s.source !== 'mic' && s.source !== 'system') ||
      typeof s.startMs !== 'number' ||
      typeof s.endMs !== 'number' ||
      !(s.endMs >= s.startMs) ||
      typeof s.text !== 'string'
    ) {
      throw new TypeError(`ground truth segment ${i} is invalid`);
    }
    return { source: s.source, startMs: s.startMs, endMs: s.endMs, text: s.text };
  });
}

/** Words of a segment spread over its span, weighted by length (same model as the mocks' fixture mode). */
export function wordsOf(segment: GroundTruthSegment): SttWord[] {
  const tokens = segment.text.split(/\s+/).filter(Boolean);
  const total = tokens.reduce((n, t) => n + t.length + 1, 0);
  let t = segment.startMs;
  return tokens.map((token) => {
    const len = ((segment.endMs - segment.startMs) * (token.length + 1)) / total;
    const word: SttWord = {
      word: token.toLowerCase().replace(/[^\p{L}\p{N}']/gu, ''),
      punctuatedWord: token,
      startMs: Math.round(t),
      endMs: Math.round(t + len),
    };
    t += len;
    return word;
  });
}

export interface FakeSttOptions {
  /** Ground truth for both sources; each stream uses its own source's segments. */
  segments: readonly GroundTruthSegment[];
  /** Wall-clock delay from the audio reaching a point to the segment being emitted. Default 0. */
  latencyMs?: number;
  /** Time spent `connecting` before `open`. Default 0 (next tick). */
  connectDelayMs?: number;
  /**
   * Simulated drop once the audio reaches this recording time (ms): non-fatal `connection` error,
   * `reconnecting` for `reconnectDelayMs`, then `open` again. Frames written meanwhile are buffered, so —
   * like the real adapter's replay — nothing is lost or duplicated.
   */
  disconnectAtMs?: number;
  /** Default 10. */
  reconnectDelayMs?: number;
  /** Fatal error once the audio reaches this recording time (ms). */
  errorAtMs?: number;
  /** Code of the `errorAtMs` error. Default `connection`. */
  errorCode?: SttErrorCode;
  /** Never opens: fatal error with this code instead (e.g. `auth` for a rejected token). */
  failOpen?: SttErrorCode;
  /**
   * `transcribe()` (batch): fail with this (retryable `connection` by default) while it returns true —
   * e.g. a test's "STT is down" switch.
   */
  batchFails?: () => boolean | SttBatchError;
  /** Wall-clock delay of each `transcribe()`. Default 0. */
  batchDelayMs?: number;
}

/**
 * Deterministic `SttProvider` for tests, driven by ground-truth segments: for each segment of the stream's
 * source it emits an interim with the first half of the words once the written audio passes the segment's
 * midpoint, and the final once the audio passes its end. `finish()` finalizes segments the audio started.
 * Segments whose midpoint lies before the first frame are skipped (a slice that starts mid-sentence).
 */
export class FakeSttProvider implements SttProvider {
  readonly name = 'fake';
  readonly #options: FakeSttOptions;

  constructor(options: FakeSttOptions) {
    this.#options = options;
  }

  openStream(options: SttStreamOptions): SttStream {
    return new FakeSttStream(options, this.#options);
  }

  /** Requests made to `transcribe()` (tests assert ranges). */
  readonly batchRequests: { source: SttSource; startMs: number; endMs: number }[] = [];

  /**
   * Batch: the ground-truth words of the request's source whose midpoint lies in the request's span
   * (`offsetMs` … + its length), one segment per ground-truth segment.
   */
  async transcribe(request: SttBatchRequest): Promise<SttBatchResult> {
    const startMs = request.offsetMs ?? 0;
    const durationMs = (request.pcm.length / request.sampleRate) * 1000;
    const endMs = startMs + durationMs;
    this.batchRequests.push({ source: request.source, startMs, endMs });
    if (this.#options.batchDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.#options.batchDelayMs));
    }
    const failure = this.#options.batchFails?.();
    if (failure) {
      throw failure instanceof SttBatchError
        ? failure
        : new SttBatchError('connection', 'fake: batch unavailable', true, 503);
    }
    const segments: SttSegmentData[] = [];
    for (const truth of this.#options.segments
      .filter((s) => s.source === request.source)
      .sort((a, b) => a.startMs - b.startMs)) {
      const words = wordsOf(truth).filter((w) => {
        const mid = (w.startMs + w.endMs) / 2;
        return mid >= startMs && mid < endMs;
      });
      if (words.length === 0) continue;
      segments.push({
        source: request.source,
        startMs: words[0]!.startMs,
        endMs: words.at(-1)!.endMs,
        text: words.map((w) => w.punctuatedWord ?? w.word).join(' '),
        isFinal: true,
        speechFinal: true,
        words,
        confidence: 1,
      });
    }
    return { segments, durationMs: Math.round(durationMs) };
  }
}

interface Pending {
  segment: GroundTruthSegment;
  words: SttWord[];
  interimSent: boolean;
}

class FakeSttStream extends BaseSttStream {
  readonly #options: FakeSttOptions;
  readonly #pending: Pending[];
  readonly #queue: AudioFrame[] = [];
  /** Scheduled callbacks → their runner (which skips the callback once terminated). */
  readonly #timers = new Map<ReturnType<typeof setTimeout>, () => void>();
  readonly #emissions = new Set<Promise<void>>();
  #firstMs: number | undefined;
  #audioEndMs = 0;
  #disconnected = false;
  #failed = false;
  #finishing: Promise<void> | undefined;
  #wake: (() => void) | undefined;

  constructor(options: SttStreamOptions, fake: FakeSttOptions) {
    super(options);
    this.#options = fake;
    this.#pending = fake.segments
      .filter((s) => s.source === options.source)
      .sort((a, b) => a.startMs - b.startMs)
      .map((segment) => ({ segment, words: wordsOf(segment), interimSent: false }));
    this.#after(fake.connectDelayMs ?? 0, () => {
      if (fake.failOpen) {
        this.emitError({ code: fake.failOpen, message: 'fake: open failed', fatal: true });
      } else {
        this.setStatus('open');
        this.#drain();
      }
      this.#wake?.();
    });
  }

  write(frame: AudioFrame): void {
    this.checkFrame(frame);
    if (this.terminated || this.#finishing) return;
    this.#queue.push(frame);
    if (this.status === 'open') this.#drain();
  }

  finish(): Promise<void> {
    this.#finishing ??= this.#finish();
    return this.#finishing;
  }

  close(): void {
    this.setStatus('closed');
    for (const [timer, run] of this.#timers) {
      clearTimeout(timer);
      run(); // terminated → only settles the bookkeeping promise
    }
    this.#wake?.();
  }

  async #finish(): Promise<void> {
    while (this.status === 'connecting' || this.status === 'reconnecting') {
      await new Promise<void>((resolve) => (this.#wake = resolve));
    }
    if (this.terminated) return;
    this.#drain();
    for (const p of this.#pending) {
      if (p.segment.startMs >= this.#audioEndMs || !this.#wanted(p)) continue;
      const words = p.words.filter((w) => w.startMs < this.#audioEndMs);
      this.#emit(p, words, true, Math.min(p.segment.endMs, this.#audioEndMs));
    }
    this.#pending.length = 0;
    while (this.#emissions.size > 0) await Promise.all(this.#emissions);
    this.retractInterim(); // contract: nothing stays provisional after finish()
    this.setStatus('closed');
  }

  #drain(): void {
    while (this.status === 'open' && this.#queue.length > 0 && !this.#failed) {
      const frame = this.#queue.shift()!;
      const startMs = frame.tUs / 1000;
      this.#firstMs ??= startMs;
      this.#audioEndMs = startMs + (frame.pcm.length / frame.sampleRate) * 1000;
      this.#advance();
      const { disconnectAtMs, errorAtMs } = this.#options;
      if (errorAtMs !== undefined && this.#audioEndMs >= errorAtMs) {
        this.#failed = true;
        this.#after(this.#options.latencyMs ?? 0, () =>
          this.emitError({
            code: this.#options.errorCode ?? 'connection',
            message: 'fake: injected error',
            fatal: true,
          }),
        );
      } else if (
        disconnectAtMs !== undefined &&
        !this.#disconnected &&
        this.#audioEndMs >= disconnectAtMs
      ) {
        this.#disconnected = true;
        this.emitError({ code: 'connection', message: 'fake: injected drop', fatal: false });
        this.setStatus('reconnecting');
        this.#after(this.#options.reconnectDelayMs ?? 10, () => {
          this.setStatus('open');
          this.#wake?.();
          this.#drain();
        });
      }
    }
  }

  #wanted(p: Pending): boolean {
    return (p.segment.startMs + p.segment.endMs) / 2 >= (this.#firstMs ?? 0);
  }

  #advance(): void {
    const now = this.#audioEndMs;
    while (this.#pending.length > 0) {
      const p = this.#pending[0]!;
      if (!this.#wanted(p)) {
        this.#pending.shift();
        continue;
      }
      const mid = (p.segment.startMs + p.segment.endMs) / 2;
      if (!p.interimSent && now >= mid) {
        p.interimSent = true;
        this.#emit(
          p,
          p.words.filter((w) => w.endMs <= mid + 1),
          false,
          mid,
        );
      }
      if (now < p.segment.endMs) break;
      this.#pending.shift();
      this.#emit(p, p.words, true, p.segment.endMs);
    }
  }

  #emit(p: Pending, words: SttWord[], isFinal: boolean, endMs: number): void {
    if (words.length === 0) return;
    const segment = {
      source: this.source,
      startMs: p.segment.startMs,
      endMs: Math.round(endMs),
      text: words.map((w) => w.punctuatedWord ?? w.word).join(' '),
      isFinal,
      ...(isFinal ? { speechFinal: true } : {}),
      words,
      confidence: 1,
    };
    this.#after(this.#options.latencyMs ?? 0, () => this.emitSegment(segment));
  }

  /** Runs `fn` after `ms` (0 = next tick); tracked so `finish()` can wait and `close()` can cancel. */
  #after(ms: number, fn: () => void): void {
    const done = new Promise<void>((resolve) => {
      const run = () => {
        if (!this.#timers.delete(timer)) return;
        this.#emissions.delete(done);
        if (!this.terminated) fn();
        resolve();
      };
      const timer = setTimeout(run, ms);
      this.#timers.set(timer, run);
    });
    this.#emissions.add(done);
  }
}
