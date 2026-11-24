/**
 * Recording state machine (SPEC §3, §8), source-agnostic and pure TS: the desktop main process drives it with
 * a `SidecarSource`; tests drive it with a `FileSource`.
 *
 * ```
 *            start()            started            pause()
 *   idle ───────────► starting ─────────► recording ◄──────► paused
 *    ▲                   │                  │  resume()        │
 *    │                   │ start failed     │ stop()           │ stop()
 *    │                   ▼                  ▼                  ▼
 *    │  stop()         error ◄─────── (source stopped by itself with an error reason)
 *    ├───────────────────┘                  stopping ◄─────────┘
 *    └──────────────────────────────────────┘ stopped
 * ```
 *
 * - `error` is sticky until acknowledged: `start()` (retry with a fresh source) or `stop()` (→ `idle`).
 * - A source that ends by itself with `duration` / `end_of_input` goes back to `idle`; any other unrequested
 *   end (`error`, `signal`, `output_closed`, …) goes to `error` — recording never stops silently (SPEC §8).
 * - Invalid commands throw `RecordingStateError` and change nothing.
 * - Frames fan out to subscribers through bounded per-subscriber queues: a slow (async) subscriber loses its
 *   own oldest frames (counted, reported via `onOverrun`) and never delays the others or the source.
 */
import {
  type AudioEvent,
  type AudioEventOf,
  type AudioFrame,
  type AudioSource,
  type AudioSourceKind,
  type AudioStopReason,
  type Unsubscribe,
} from './types.ts';
import { Fanout } from './emitter.ts';

export type RecordingState = 'idle' | 'starting' | 'recording' | 'paused' | 'stopping' | 'error';

export interface RecordingStateChange {
  readonly from: RecordingState;
  readonly to: RecordingState;
  /** Set when entering `error`. */
  readonly error?: RecordingError;
}

/** Everything the UI must surface: source `error` events, start failures, unexpected stops, subscriber faults. */
export interface RecordingError {
  /** Source error codes (see `KnownAudioErrorCode`), or `start_failed`, `unexpected_stop`, `subscriber_error`. */
  readonly code: string;
  readonly message: string;
  /** `true` = this ended the recording (state `error`), or a source stopped. */
  readonly fatal: boolean;
  readonly source?: AudioSourceKind;
  readonly tUs?: number;
  readonly cause?: unknown;
}

export class RecordingStateError extends Error {
  override readonly name = 'RecordingStateError';
}

export interface RecordingControllerOptions {
  /** A fresh source per recording (an `AudioSource` cannot be restarted). */
  createSource: () => AudioSource;
  /** Monotonic ms clock for `elapsedMs` (injectable for tests). Default `performance.now`. */
  now?: () => number;
}

export interface SubscribeOptions {
  /** Frames queued for this subscriber before its oldest are dropped. Default 400 (≈ 10 s at 50 ms × 2). */
  maxQueuedFrames?: number;
  /** Only these sources (default all). */
  sources?: readonly AudioSourceKind[];
  /** Called when frames had to be dropped for this subscriber (it fell behind). */
  onOverrun?: (overrun: SubscriberOverrun) => void;
  /** For error messages. */
  name?: string;
}

export interface SubscriberOverrun {
  readonly source: AudioSourceKind;
  /** `tUs` of the dropped frame. */
  readonly tUs: number;
  readonly droppedSamples: number;
}

export interface SubscriberStats {
  delivered: number;
  dropped: number;
  droppedSamples: Record<AudioSourceKind, number>;
  queued: number;
}

export interface FrameSubscription {
  readonly stats: Readonly<SubscriberStats>;
  /** Resolves once every queued frame has been handed to the consumer (and its promise settled). */
  drained(): Promise<void>;
  unsubscribe(): void;
}

/**
 * A consumer may be async; the next frame is delivered only after its promise settles. Every subscriber gets
 * the same `AudioFrame` object (and `pcm` array): treat it as read-only and copy before modifying, per the
 * `AudioFrame` contract.
 */
export type FrameConsumer = (frame: AudioFrame) => void | Promise<void>;

const GRACEFUL_ENDS = new Set<AudioStopReason>(['duration', 'end_of_input']);

export class RecordingController {
  readonly #options: RecordingControllerOptions;
  readonly #now: () => number;
  readonly #stateChanges = new Fanout<RecordingStateChange>();
  readonly #events = new Fanout<AudioEvent>();
  readonly #levels = new Fanout<AudioEventOf<'level'>>();
  readonly #errors = new Fanout<RecordingError>();
  readonly #subscribers = new Set<Subscriber>();

  #state: RecordingState = 'idle';
  #source: AudioSource | undefined;
  #detach: Unsubscribe[] = [];
  #lastError: RecordingError | undefined;
  #elapsedBefore = 0; // ms recorded before the current running stretch
  #runningSince: number | undefined;
  #lastStop: AudioEventOf<'stopped'> | undefined;

  constructor(options: RecordingControllerOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => performance.now());
  }

  get state(): RecordingState {
    return this.#state;
  }

  /** The current (or last) recording's source. */
  get source(): AudioSource | undefined {
    return this.#source;
  }

  /** Last error that put the controller into `error`. */
  get lastError(): RecordingError | undefined {
    return this.#lastError;
  }

  /** The last recording's `stopped` event. */
  get lastStop(): AudioEventOf<'stopped'> | undefined {
    return this.#lastStop;
  }

  /** Time spent recording (not paused) in the current or last recording. */
  get elapsedMs(): number {
    const running = this.#runningSince === undefined ? 0 : this.#now() - this.#runningSince;
    return this.#elapsedBefore + running;
  }

  onStateChange(listener: (change: RecordingStateChange) => void): Unsubscribe {
    return this.#stateChanges.add(listener);
  }

  /** Every source event (started, paused, level, overrun, error, …). */
  onEvent(listener: (event: AudioEvent) => void): Unsubscribe {
    return this.#events.add(listener);
  }

  onLevel(listener: (event: AudioEventOf<'level'>) => void): Unsubscribe {
    return this.#levels.add(listener);
  }

  onError(listener: (error: RecordingError) => void): Unsubscribe {
    return this.#errors.add(listener);
  }

  /** Receive frames through a bounded queue of its own. Persists across recordings until unsubscribed. */
  subscribe(consumer: FrameConsumer, options: SubscribeOptions = {}): FrameSubscription {
    const subscriber = new Subscriber(consumer, options, (error) =>
      this.#reportError({
        code: 'subscriber_error',
        message: `frame subscriber${options.name ? ` "${options.name}"` : ''} threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
        fatal: false,
        cause: error,
      }),
    );
    this.#subscribers.add(subscriber);
    return {
      stats: subscriber.stats,
      drained: () => subscriber.drained(),
      unsubscribe: () => {
        subscriber.close();
        this.#subscribers.delete(subscriber);
      },
    };
  }

  /**
   * `idle` | `error` → `starting` → `recording`. A synchronous readiness check can reject
   * startup before listeners and frame subscribers see the recording.
   */
  async start(beforeRecording?: (event: AudioEventOf<'started'>) => void): Promise<void> {
    this.#expect('start', ['idle', 'error']);
    const source = this.#options.createSource();
    this.#source = source;
    this.#lastError = undefined;
    this.#lastStop = undefined;
    this.#elapsedBefore = 0;
    this.#runningSince = undefined;
    this.#transition('starting');
    let readinessFailure: { cause: unknown } | undefined;
    this.#detach = [
      source.onFrame((frame) => {
        if (!readinessFailure) this.#onFrame(source, frame);
      }),
      source.onEvent((event) => {
        if (readinessFailure) return;
        if (event.type === 'started') {
          if (this.#state !== 'starting') return;
          try {
            beforeRecording?.(event);
          } catch (error) {
            readinessFailure = { cause: error };
            return;
          }
        }
        this.#onEvent(source, event);
      }),
    ];
    void source.whenStopped().then((stopped) => this.#onStopped(source, stopped));
    try {
      await source.start();
      if (readinessFailure) {
        await source.stop();
        throw readinessFailure.cause;
      }
    } catch (error) {
      if (this.#source === source && this.#state === 'starting') {
        this.#enterError({
          code: 'start_failed',
          message: `recording could not start: ${error instanceof Error ? error.message : String(error)}`,
          fatal: true,
          cause: error,
        });
      }
      throw error;
    }
  }

  pause(): void {
    this.#expect('pause', ['recording']);
    this.#source?.pause();
    this.#stopClock();
    this.#transition('paused');
  }

  resume(): void {
    this.#expect('resume', ['paused']);
    this.#source?.resume();
    this.#runningSince = this.#now();
    this.#transition('recording');
  }

  /**
   * `starting` | `recording` | `paused` → `stopping` → `idle`; from `error` it just acknowledges (→ `idle`).
   * Resolves with the `stopped` event (undefined when acknowledging an error).
   */
  async stop(): Promise<AudioEventOf<'stopped'> | undefined> {
    if (this.#state === 'error') {
      this.#transition('idle');
      return undefined;
    }
    this.#expect('stop', ['starting', 'recording', 'paused']);
    const source = this.#source as AudioSource;
    this.#stopClock();
    this.#transition('stopping');
    await source.stop();
    return source.whenStopped();
  }

  #expect(command: string, allowed: readonly RecordingState[]): void {
    if (!allowed.includes(this.#state)) {
      throw new RecordingStateError(`cannot ${command} while ${this.#state}`);
    }
  }

  #onFrame(source: AudioSource, frame: AudioFrame): void {
    if (source !== this.#source) return;
    for (const subscriber of this.#subscribers) subscriber.push(frame);
  }

  #onEvent(source: AudioSource, event: AudioEvent): void {
    if (source !== this.#source) return;
    this.#events.emit(event);
    switch (event.type) {
      case 'started':
        if (this.#state === 'starting') {
          this.#runningSince = this.#now();
          this.#transition('recording');
        }
        break;
      case 'level':
        this.#levels.emit(event);
        break;
      case 'error':
        this.#reportError({
          code: event.code,
          message: event.message,
          fatal: event.fatal,
          tUs: event.tUs,
          ...(event.source ? { source: event.source } : {}),
        });
        break;
    }
  }

  #onStopped(source: AudioSource, stopped: AudioEventOf<'stopped'>): void {
    if (source !== this.#source) return;
    for (const off of this.#detach) off();
    this.#detach = [];
    this.#lastStop = stopped;
    this.#stopClock();
    if (this.#state === 'stopping') {
      this.#transition('idle');
    } else if (this.#state === 'recording' || this.#state === 'paused') {
      if (GRACEFUL_ENDS.has(stopped.reason)) this.#transition('idle');
      else {
        this.#enterError({
          code: 'unexpected_stop',
          message: `recording stopped unexpectedly (${stopped.reason})`,
          fatal: true,
          tUs: stopped.tUs,
        });
      }
    }
    // `starting`: start() rejects and handles the transition.
  }

  #stopClock(): void {
    if (this.#runningSince !== undefined) {
      this.#elapsedBefore += this.#now() - this.#runningSince;
      this.#runningSince = undefined;
    }
  }

  #enterError(error: RecordingError): void {
    this.#lastError = error;
    this.#errors.emit(error);
    this.#transition('error', error);
  }

  #reportError(error: RecordingError): void {
    this.#errors.emit(error);
  }

  #transition(to: RecordingState, error?: RecordingError): void {
    const from = this.#state;
    if (from === to) return;
    this.#state = to;
    this.#stateChanges.emit({ from, to, ...(error ? { error } : {}) });
  }
}

/** One frame consumer with its own bounded queue and pump. */
class Subscriber {
  readonly stats: SubscriberStats = {
    delivered: 0,
    dropped: 0,
    droppedSamples: { mic: 0, system: 0 },
    queued: 0,
  };
  readonly #consumer: FrameConsumer;
  readonly #max: number;
  readonly #sources: ReadonlySet<AudioSourceKind> | undefined;
  readonly #onOverrun: SubscribeOptions['onOverrun'];
  readonly #onError: (error: unknown) => void;
  #queue: AudioFrame[] = [];
  #pumping = false;
  #closed = false;
  #idle: (() => void)[] = [];

  constructor(
    consumer: FrameConsumer,
    options: SubscribeOptions,
    onError: (error: unknown) => void,
  ) {
    const max = options.maxQueuedFrames ?? 400;
    if (!(max >= 1)) throw new RangeError('maxQueuedFrames must be ≥ 1');
    this.#consumer = consumer;
    this.#max = Math.floor(max);
    this.#sources = options.sources ? new Set(options.sources) : undefined;
    this.#onOverrun = options.onOverrun;
    this.#onError = onError;
  }

  push(frame: AudioFrame): void {
    if (this.#closed || (this.#sources && !this.#sources.has(frame.source))) return;
    if (this.#queue.length >= this.#max) {
      const dropped = this.#queue.shift() as AudioFrame;
      this.stats.dropped++;
      this.stats.droppedSamples[dropped.source] += dropped.pcm.length;
      try {
        this.#onOverrun?.({
          source: dropped.source,
          tUs: dropped.tUs,
          droppedSamples: dropped.pcm.length,
        });
      } catch (error) {
        this.#onError(error);
      }
    }
    this.#queue.push(frame);
    this.stats.queued = this.#queue.length;
    if (!this.#pumping) {
      // Start on a microtask: every subscriber gets the frame queued before any consumer runs.
      this.#pumping = true;
      queueMicrotask(() => void this.#pump());
    }
  }

  drained(): Promise<void> {
    if (!this.#pumping && this.#queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idle.push(resolve));
  }

  close(): void {
    this.#closed = true;
    this.#queue = [];
    this.stats.queued = 0;
  }

  async #pump(): Promise<void> {
    try {
      while (this.#queue.length > 0) {
        const frame = this.#queue.shift() as AudioFrame;
        this.stats.queued = this.#queue.length;
        try {
          await this.#consumer(frame);
        } catch (error) {
          this.#onError(error);
        }
        this.stats.delivered++;
      }
    } finally {
      this.#pumping = false;
      const waiters = this.#idle;
      this.#idle = [];
      for (const resolve of waiters) resolve();
    }
  }
}
