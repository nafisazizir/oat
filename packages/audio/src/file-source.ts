import { Fanout, logListenerError } from './emitter.ts';
import { LevelMeter } from './level.ts';
import { downmixToMono, resampleInt16 } from './resample.ts';
import {
  AUDIO_SOURCES,
  DEFAULT_SAMPLE_RATE,
  LISTENER_ERROR,
  type AudioEvent,
  type AudioEventOf,
  type AudioFrame,
  type AudioSource,
  type AudioSourceKind,
  type AudioSourceState,
  type AudioStopReason,
  type Unsubscribe,
} from './types.ts';
import { decodeWav, type WavAudio } from './wav.ts';

/** A WAV as a file path / `file:` URL (Node only) or as bytes. */
export type WavInput = string | URL | Uint8Array;

export type FileSourceInput =
  /** One 2-channel WAV: left = mic ("me"), right = system ("them"). */
  | { stereo: WavInput }
  /** One mono WAV per source (multi-channel files are downmixed). At least one must be given. */
  | { mic?: WavInput; system?: WavInput };

/**
 * `realtime` paces frames like a live capture (a frame is delivered once its last sample "was captured"),
 * `fast` delivers as fast as possible (yielding to the event loop every second of audio), a number is a
 * multiple of real time (`2` = twice as fast, `0.5` = half speed).
 */
export type FileSourceSpeed = 'realtime' | 'fast' | number;

export interface FileSourceOptions {
  input: FileSourceInput;
  /** Default `realtime`. */
  speed?: FileSourceSpeed;
  /** Frame duration, 20–100 ms (same range as the sidecar). Default 20 ms (320 samples at 16 kHz). */
  frameMs?: number;
  /** Play only part of the file: start offset… */
  startMs?: number;
  /** …and length. Default: to the end of the longest source. */
  durationMs?: number;
  /** Output sample rate; input is resampled if it differs. Default 16 kHz. */
  sampleRate?: number;
  /** Emit a `level` event per source every N ms of audio (sidecar does 250). 0 disables. Default 250. */
  levelIntervalMs?: number;
  /** Called with every error thrown by a listener. Default `console.error`. */
  onListenerError?: (error: unknown) => void;
}

/** Without a timer wait in between, yield to the event loop after this much audio (all speeds). */
const YIELD_EVERY_MS = 1000;
/** At most one `listener_error` event per this interval; the next one says how many were suppressed. */
const LISTENER_ERROR_EVENT_INTERVAL_MS = 1000;

/**
 * Replays WAV fixtures through the same `AudioSource` contract as the live sidecar, so the whole pipeline
 * (STT, archive, meters, recording state machine) can be tested without a microphone.
 *
 * Clock: `tUs` is the position in the file (sample-count based, so the WAV's ground-truth segment times line
 * up with frame timestamps; a `startMs` slice starts at `startMs`, not 0). Mic and system frames covering
 * the same samples carry the same `tUs`. Unlike the live sidecar the timeline does not jump across a pause —
 * nothing was "missed" while a file is paused — so consumers must rely on `paused`/`resumed` events, not on
 * timestamp gaps. FileSource never drops audio, so it never emits `overrun`.
 *
 * Listener errors: a throwing listener is reported (`onListenerError`) and announced as a non-fatal `error`
 * event (`listener_error`, throttled to one per second); delivery and the session carry on.
 *
 * Input is decoded and resampled whole, in memory, during `start()` (resampling is synchronous, ≈100 taps
 * per output sample from 48 kHz). Fine for fixtures and short recordings; not meant for hour-long files.
 */
export class FileSource implements AudioSource {
  readonly sampleRate: number;
  readonly frameMs: number;
  readonly speed: FileSourceSpeed;

  readonly #options: FileSourceOptions;
  readonly #frameSamples: number;
  readonly #frames = new Fanout<AudioFrame>((error, frame) =>
    this.#listenerFailed(error, `a frame listener (${frame.source})`, frame.source),
  );
  readonly #events = new Fanout<AudioEvent>((error, event) =>
    this.#listenerFailed(
      error,
      `an event listener (${event.type})`,
      undefined,
      event.type === 'error' && event.code === LISTENER_ERROR,
    ),
  );
  #lastListenerErrorEventAt = -Infinity;
  #suppressedListenerErrors = 0;
  #pendingAnnouncement: AudioEventOf<'error'> | undefined;
  #depth = 0; // nesting of listener deliveries in progress
  readonly #stopped: Promise<AudioEventOf<'stopped'>>;
  #resolveStopped!: (event: AudioEventOf<'stopped'>) => void;

  #state: AudioSourceState = 'idle';
  #starting: Promise<void> | undefined;
  #running: Promise<void> | undefined;
  #stopRequested = false;
  #wake: (() => void) | undefined;

  #tracks: { source: AudioSourceKind; pcm: Int16Array }[] = [];
  #startSample = 0;
  #endSample = 0;
  #position = 0; // absolute sample index of the next frame
  #anchor = 0; // wall time (ms) at which #startSample "was captured", shifted by pauses
  #pausedAt = 0;
  #samples: Record<AudioSourceKind, number> = { mic: 0, system: 0 };

  constructor(options: FileSourceOptions) {
    const frameMs = options.frameMs ?? 20;
    if (!(frameMs >= 20 && frameMs <= 100)) throw new RangeError('frameMs must be 20–100');
    const speed = options.speed ?? 'realtime';
    if (typeof speed === 'number' && !(speed > 0 && Number.isFinite(speed))) {
      throw new RangeError('speed factor must be a positive finite number');
    }
    this.#options = options;
    this.sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
    this.frameMs = frameMs;
    this.speed = speed;
    this.#frameSamples = Math.round((this.sampleRate * frameMs) / 1000);
    this.#stopped = new Promise((resolve) => (this.#resolveStopped = resolve));
  }

  get state(): AudioSourceState {
    return this.#state;
  }

  /** Duration of what will be played (after `start()` has loaded the input), in ms. */
  get durationMs(): number {
    return ((this.#endSample - this.#startSample) / this.sampleRate) * 1000;
  }

  /** Sources present in the input (after `start()`). */
  get sources(): AudioSourceKind[] {
    return this.#tracks.map((t) => t.source);
  }

  onFrame(listener: (frame: AudioFrame) => void): Unsubscribe {
    return this.#frames.add(listener);
  }

  onEvent(listener: (event: AudioEvent) => void): Unsubscribe {
    return this.#events.add(listener);
  }

  whenStopped(): Promise<AudioEventOf<'stopped'>> {
    return this.#stopped;
  }

  start(): Promise<void> {
    if (this.#state !== 'idle' || this.#starting) {
      return Promise.reject(new Error(`FileSource cannot start from state "${this.#state}"`));
    }
    this.#starting = this.#load().then(
      () => {
        if (this.#stopRequested) {
          this.#finish('command', false);
          return;
        }
        this.#state = 'running';
        this.#position = this.#startSample;
        this.#anchor = now();
        this.#emitEvent({
          type: 'started',
          tUs: this.#clockUs(),
          sampleRate: this.sampleRate,
          frameMs: this.frameMs,
          sources: this.sources,
        });
        this.#running = this.#run();
      },
      (error: unknown) => {
        this.#finish('error', false);
        throw error;
      },
    );
    return this.#starting;
  }

  async stop(): Promise<void> {
    this.#stopRequested = true;
    if (this.#state === 'idle' && !this.#starting) {
      this.#finish('command', false);
      return;
    }
    await this.#starting?.catch(() => undefined);
    this.#wake?.();
    await this.#running;
  }

  pause(): void {
    if (this.#state !== 'running') return;
    this.#state = 'paused';
    this.#pausedAt = now();
    this.#emitEvent({ type: 'paused', tUs: this.#clockUs() });
  }

  resume(): void {
    if (this.#state !== 'paused') return;
    this.#state = 'running';
    this.#anchor += now() - this.#pausedAt;
    this.#emitEvent({ type: 'resumed', tUs: this.#clockUs() });
    this.#wake?.();
  }

  async #run(): Promise<void> {
    const factor = this.speed === 'realtime' ? 1 : this.speed === 'fast' ? undefined : this.speed;
    const yieldEvery = Math.max(1, Math.round(YIELD_EVERY_MS / this.frameMs));
    const levelWindow = Math.round(
      ((this.#options.levelIntervalMs ?? 250) * this.sampleRate) / 1000,
    );
    const meters = new Map(
      levelWindow > 0 ? this.#tracks.map((t) => [t.source, new LevelMeter(levelWindow)]) : [],
    );
    let sinceYield = 0;

    while (this.#position < this.#endSample && !this.#stopRequested) {
      if (this.#state === 'paused') {
        await this.#sleep(Infinity);
        continue;
      }
      const n = Math.min(this.#frameSamples, this.#endSample - this.#position);
      if (factor !== undefined) {
        const dueMs =
          this.#anchor +
          ((this.#position + n - this.#startSample) / this.sampleRate) * (1000 / factor);
        const waitMs = dueMs - now();
        if (waitMs > 0.5) {
          sinceYield = 0;
          await this.#sleep(waitMs);
          continue; // re-check stop/pause
        }
      }
      // Fast mode, or a numeric speed so high that frames are always already due: still let
      // timers/IO (and therefore external pause()/stop()) run regularly.
      if (++sinceYield > yieldEvery) {
        sinceYield = 0;
        await this.#sleep(0);
        continue;
      }

      const from = this.#position;
      const tUs = this.#clockUs();
      // Advance first: a listener that pauses/stops sees the clock at the end of this frame. The frames of
      // all sources for this slice are delivered together, even if a listener pauses in between.
      this.#position = from + n;
      for (const track of this.#tracks) {
        const to = Math.min(from + n, track.pcm.length);
        if (to <= from) continue; // this source's input has ended
        const pcm = track.pcm.slice(from, to);
        this.#samples[track.source] += pcm.length;
        this.#emitFrame({ source: track.source, tUs, pcm, sampleRate: this.sampleRate });
        const levels = meters.get(track.source)?.push(pcm) ?? [];
        for (const level of levels) {
          this.#emitEvent({
            type: 'level',
            tUs: this.#clockUs(to),
            source: track.source,
            rmsDb: level.rmsDb,
            peakDb: level.peakDb,
          });
        }
      }
    }

    this.#finish(this.#stopRequested ? 'command' : 'end_of_input', true);
  }

  #finish(reason: AudioStopReason, emit: boolean): void {
    if (this.#state === 'stopped') return;
    this.#state = 'stopped';
    const event: AudioEventOf<'stopped'> = {
      type: 'stopped',
      tUs: this.#clockUs(),
      reason,
      samples: { ...this.#samples },
    };
    if (emit) this.#emitEvent(event);
    this.#frames.clear();
    this.#events.clear();
    this.#resolveStopped(event);
  }

  #listenerFailed(
    error: unknown,
    what: string,
    source: AudioSourceKind | undefined,
    whileReportingListenerError = false,
  ): void {
    (this.#options.onListenerError ?? logListenerError)(error);
    // Never announce after `stopped`, and never recurse when a listener throws on the announcement itself.
    if (this.#state === 'stopped' || whileReportingListenerError) return;
    const t = now();
    if (t - this.#lastListenerErrorEventAt < LISTENER_ERROR_EVENT_INTERVAL_MS) {
      this.#suppressedListenerErrors++;
      return;
    }
    const suppressed = this.#suppressedListenerErrors;
    this.#lastListenerErrorEventAt = t;
    this.#suppressedListenerErrors = 0;
    const detail = error instanceof Error ? error.message : String(error);
    // Announced once the current delivery has reached every listener, so ordering guarantees hold (e.g.
    // `started` is still the first event every listener sees).
    this.#pendingAnnouncement = {
      type: 'error',
      tUs: this.#clockUs(),
      ...(source ? { source } : {}),
      code: LISTENER_ERROR,
      message:
        `${what} threw: ${detail}` +
        (suppressed > 0 ? ` (${suppressed} earlier listener errors not announced)` : ''),
      fatal: false,
    };
  }

  #emitFrame(frame: AudioFrame): void {
    this.#deliver(() => this.#frames.emit(frame));
  }

  #emitEvent(event: AudioEvent): void {
    this.#deliver(() => this.#events.emit(event));
  }

  #deliver(emit: () => void): void {
    this.#depth++;
    try {
      emit();
    } finally {
      this.#depth--;
    }
    if (this.#depth === 0 && this.#pendingAnnouncement) {
      const announcement = this.#pendingAnnouncement;
      this.#pendingAnnouncement = undefined;
      if (this.#state !== 'stopped') this.#emitEvent(announcement);
    }
  }

  #clockUs(sample = this.#position): number {
    return Math.round((sample * 1_000_000) / this.sampleRate);
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (this.#wake === done) this.#wake = undefined;
        resolve();
      };
      const timer = ms === Infinity ? undefined : setTimeout(done, ms);
      this.#wake = done;
    });
  }

  async #load(): Promise<void> {
    const { input } = this.#options;
    const loaded: { source: AudioSourceKind; audio: WavAudio }[] = [];
    if ('stereo' in input) {
      const wav = decodeWav(await readInput(input.stereo));
      if (wav.channels.length !== 2) {
        throw new Error(
          `stereo input must have 2 channels (L = mic, R = system), got ${wav.channels.length}`,
        );
      }
      loaded.push(
        { source: 'mic', audio: { sampleRate: wav.sampleRate, channels: [wav.channels[0]!] } },
        { source: 'system', audio: { sampleRate: wav.sampleRate, channels: [wav.channels[1]!] } },
      );
    } else {
      for (const source of AUDIO_SOURCES) {
        const file = input[source];
        if (file !== undefined) loaded.push({ source, audio: decodeWav(await readInput(file)) });
      }
      if (loaded.length === 0) throw new Error('FileSource needs a mic and/or system input');
    }

    this.#tracks = loaded.map(({ source, audio }) => ({
      source,
      pcm: resampleInt16(downmixToMono(audio.channels), audio.sampleRate, this.sampleRate),
    }));

    const longest = Math.max(...this.#tracks.map((t) => t.pcm.length));
    const msToSamples = (ms: number) => Math.round((ms * this.sampleRate) / 1000);
    this.#startSample = Math.min(longest, msToSamples(Math.max(0, this.#options.startMs ?? 0)));
    const duration = this.#options.durationMs;
    this.#endSample =
      duration === undefined
        ? longest
        : Math.min(longest, this.#startSample + msToSamples(Math.max(0, duration)));
  }
}

async function readInput(input: WavInput): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  const { readFile } = await import('node:fs/promises');
  return readFile(input);
}

function now(): number {
  return performance.now();
}
