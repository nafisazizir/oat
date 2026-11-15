/**
 * Onboarding's test recording (9.2): ~10 s of the same audio input and live transcription a meeting uses,
 * showing levels for Me / Them and the latest transcript line — and saving nothing (no meeting, no audio file,
 * no transcript). Electron-free: the source and the STT provider are injected (`recording-setup.ts` in the app;
 * `FileSource` + `FakeSttProvider` in tests).
 */
import type { AudioEvent, AudioFrame, AudioSource, AudioSourceKind } from '@oat/audio';
import type { TestRecordingSnapshot } from '@oat/core/bridge';
import type { SttProvider, SttStream } from '@oat/stt';

import type { Logger } from './ipc.ts';
import type { InputSpec } from './recording-service.ts';

/** A source counts as heard once its peak goes above this (dBFS): speech, not room noise. */
export const HEARD_DB = -45;
export const TEST_RECORDING_MS = 10_000;
/** Frames kept per source while the transcription provider is being resolved (~20 s at 50 ms). */
const MAX_PENDING_FRAMES = 400;
const PROVIDER_TIMEOUT_MS = 10_000;
/** A stop waits this long for the last transcript finals. */
const FINISH_TIMEOUT_MS = 3_000;

export interface TestRecordingOptions {
  createSource: (spec: InputSpec) => AudioSource;
  createStt: (spec: InputSpec) => Promise<SttProvider>;
  /** How long the test runs unless stopped (default 10 s). */
  durationMs?: number;
  onState?: (snapshot: TestRecordingSnapshot) => void;
  /** Minimum gap between pushes for levels/elapsed; status changes go out at once. Default 100. */
  throttleMs?: number;
  now?: () => number;
  log: Logger;
}

type State = Omit<TestRecordingSnapshot, 'seq' | 'elapsedMs' | 'durationMs'>;

export class TestRecordingError extends Error {
  override name = 'TestRecordingError';
}

interface Run {
  readonly id: number;
  source: AudioSource | undefined;
  readonly streams: Map<AudioSourceKind, SttStream>;
  readonly pending: AudioFrame[];
  provider: SttProvider | null | undefined;
  startedAt: number | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  readonly unsubscribe: (() => void)[];
  stopping: Promise<void> | undefined;
}

export class TestRecording {
  readonly #o: TestRecordingOptions;
  readonly #now: () => number;
  readonly #durationMs: number;
  #run: Run | undefined;
  #runs = 0;
  #seq = 0;
  #state: State = idleState();
  #elapsedMs = 0;
  #pushTimer: ReturnType<typeof setTimeout> | undefined;
  #lastPush = 0;

  constructor(options: TestRecordingOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#durationMs = options.durationMs ?? TEST_RECORDING_MS;
  }

  /** Starting or running: a meeting recording must wait (one audio input at a time). */
  get busy(): boolean {
    return this.#state.status === 'starting' || this.#state.status === 'running';
  }

  snapshot(): TestRecordingSnapshot {
    const run = this.#run;
    const elapsed =
      this.#state.status === 'running' && run?.startedAt !== undefined && !run.stopping
        ? Math.min(this.#durationMs, this.#now() - run.startedAt)
        : this.#elapsedMs;
    return {
      ...this.#state,
      seq: this.#seq,
      elapsedMs: Math.max(0, elapsed),
      durationMs: this.#durationMs,
    };
  }

  async start(spec: InputSpec): Promise<TestRecordingSnapshot> {
    if (this.busy) throw new TestRecordingError('The test recording is already running.');
    if (this.#run?.stopping) await this.#run.stopping;
    const run: Run = {
      id: ++this.#runs,
      source: undefined,
      streams: new Map(),
      pending: [],
      provider: undefined,
      startedAt: undefined,
      timer: undefined,
      unsubscribe: [],
      stopping: undefined,
    };
    this.#run = run;
    this.#elapsedMs = 0;
    this.#set({ ...idleState(), status: 'starting', transcription: 'connecting' }, true);

    let source: AudioSource;
    try {
      source = this.#o.createSource(spec);
    } catch (error) {
      this.#o.log.error('test recording: no audio source', error);
      this.#fail(run, 'Oat’s audio helper isn’t available, so nothing can be recorded.');
      return this.snapshot();
    }
    run.source = source;
    run.unsubscribe.push(
      source.onEvent((event) => this.#onEvent(run, event)),
      source.onFrame((frame) => this.#onFrame(run, frame)),
    );

    void withTimeout(this.#o.createStt(spec), PROVIDER_TIMEOUT_MS)
      .then((provider) => {
        if (!this.#current(run)) return;
        run.provider = provider;
        for (const frame of run.pending.splice(0)) this.#write(run, frame);
      })
      .catch((error: unknown) => {
        this.#o.log.warn(`test recording: no transcription (${String(error)})`);
        if (!this.#current(run)) return;
        run.provider = null;
        run.pending.length = 0;
        this.#set({ ...this.#state, transcription: 'unavailable' }, true);
      });

    try {
      await source.start();
    } catch (error) {
      this.#o.log.error('test recording: start failed', error);
      this.#fail(
        run,
        'The test recording couldn’t start. Check the permissions above, then try again.',
      );
      return this.snapshot();
    }
    if (this.#current(run) && this.#state.status === 'starting') this.#started(run);
    return this.snapshot();
  }

  /** Stops early (or after the time is up); resolves once the last transcript finals are in. */
  async stop(): Promise<TestRecordingSnapshot> {
    const run = this.#run;
    if (!run) return this.snapshot();
    await this.#finish(run, 'done');
    return this.snapshot();
  }

  dispose(): void {
    const run = this.#run;
    if (run) void this.#finish(run, 'done');
  }

  #current(run: Run): boolean {
    return this.#run === run && !run.stopping;
  }

  #started(run: Run) {
    run.startedAt = this.#now();
    run.timer = setTimeout(() => void this.#finish(run, 'done'), this.#durationMs);
    this.#set({ ...this.#state, status: 'running' }, true);
  }

  #onEvent(run: Run, event: AudioEvent) {
    if (!this.#current(run)) return;
    switch (event.type) {
      case 'started':
        if (this.#state.status === 'starting') this.#started(run);
        return;
      case 'level': {
        const heard = event.peakDb > HEARD_DB;
        this.#set({
          ...this.#state,
          levels: {
            ...this.#state.levels,
            [event.source]: { rmsDb: event.rmsDb, peakDb: event.peakDb },
          },
          heard: heard ? { ...this.#state.heard, [event.source]: true } : this.#state.heard,
        });
        return;
      }
      case 'error':
        if (event.fatal && !event.source) {
          void this.#finish(run, 'error', 'The audio stopped unexpectedly. Try again.');
        }
        return;
      case 'stopped':
        // The input ended by itself (a fixture shorter than the test): that's a finished test.
        void this.#finish(run, 'done');
        return;
      default:
        return;
    }
  }

  #onFrame(run: Run, frame: AudioFrame) {
    if (!this.#current(run)) return;
    if (run.provider === undefined) {
      if (run.pending.length < MAX_PENDING_FRAMES) run.pending.push(frame);
      return;
    }
    this.#write(run, frame);
  }

  #write(run: Run, frame: AudioFrame) {
    const provider = run.provider;
    if (!provider) return;
    let stream = run.streams.get(frame.source);
    if (!stream) {
      stream = provider.openStream({ source: frame.source, sampleRate: frame.sampleRate });
      run.streams.set(frame.source, stream);
      stream.on('segment', (segment) => {
        if (this.#run !== run || !segment.text.trim()) return;
        this.#set({ ...this.#state, line: { source: segment.source, text: segment.text.trim() } });
      });
      stream.on('status', (status) => {
        if (this.#run !== run) return;
        if (status === 'open' && this.#state.transcription !== 'live') {
          this.#set({ ...this.#state, transcription: 'live' }, true);
        } else if (status === 'error' && this.#state.transcription !== 'live') {
          this.#set({ ...this.#state, transcription: 'unavailable' }, true);
        }
      });
      stream.on('error', (error) => {
        this.#o.log.warn(`test recording: transcription ${frame.source}: ${error.message}`);
      });
    }
    try {
      stream.write(frame);
    } catch (error) {
      this.#o.log.warn(`test recording: ${String(error)}`);
    }
  }

  #fail(run: Run, message: string) {
    void this.#finish(run, 'error', message);
  }

  #finish(run: Run, status: 'done' | 'error', error: string | null = null): Promise<void> {
    if (run.stopping) return run.stopping;
    if (run.timer) clearTimeout(run.timer);
    if (run.startedAt !== undefined) {
      this.#elapsedMs = Math.min(this.#durationMs, this.#now() - run.startedAt);
    }
    const wasLive = this.#state.transcription === 'live';
    run.stopping = (async () => {
      try {
        await run.source?.stop();
      } catch (e) {
        this.#o.log.warn(`test recording: stop failed (${String(e)})`);
      }
      // The last finals: what was said just before the end still shows.
      await Promise.race([
        Promise.all([...run.streams.values()].map((s) => s.finish())),
        new Promise((resolve) => setTimeout(resolve, FINISH_TIMEOUT_MS)),
      ]);
      for (const stream of run.streams.values()) stream.close();
      for (const off of run.unsubscribe.splice(0)) off();
      if (this.#run !== run) return;
      this.#set(
        {
          ...this.#state,
          status,
          levels: { mic: null, system: null },
          transcription: wasLive
            ? 'live'
            : this.#state.transcription === 'connecting'
              ? 'off'
              : this.#state.transcription,
          error,
        },
        true,
      );
    })();
    // A failure shows at once; a finished test stays `running` until its last finals are in.
    if (this.#run === run && status === 'error') this.#set({ ...this.#state, status, error }, true);
    return run.stopping;
  }

  #set(state: State, now = false) {
    this.#state = state;
    this.#seq++;
    if (now) return this.#push();
    if (this.#pushTimer) return;
    const wait = Math.max(0, this.#lastPush + (this.#o.throttleMs ?? 100) - this.#now());
    if (wait === 0) return this.#push();
    this.#pushTimer = setTimeout(() => this.#push(), wait);
  }

  #push() {
    if (this.#pushTimer) clearTimeout(this.#pushTimer);
    this.#pushTimer = undefined;
    this.#lastPush = this.#now();
    this.#o.onState?.(this.snapshot());
  }
}

function idleState(): State {
  return {
    status: 'idle',
    levels: { mic: null, system: null },
    heard: { mic: false, system: false },
    line: null,
    transcription: 'off',
    error: null,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e: unknown) => (clearTimeout(timer), reject(e instanceof Error ? e : new Error(String(e)))),
    );
  });
}
