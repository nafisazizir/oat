/**
 * `SidecarSource`: live capture through the `oat-audio` Swift sidecar (D-8), speaking the wire protocol in
 * `native/oat-audio/PROTOCOL.md` (D-16). Node-only (child processes); import it from `@oat/audio/node`.
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FrameParser,
  KIND,
  ProtocolError,
  SIDECAR_PROTOCOL,
  toAudioEvent,
  toAudioFrame,
  type RawFrame,
} from './sidecar-protocol.ts';
import { SourceEmitter } from './source-emitter.ts';
import {
  AUDIO_SOURCES,
  DEFAULT_SAMPLE_RATE,
  type AudioEvent,
  type AudioEventOf,
  type AudioFrame,
  type AudioSource,
  type AudioSourceKind,
  type AudioSourceState,
  type AudioStopReason,
  type Unsubscribe,
} from './types.ts';

/** How to run the sidecar: a binary path, or a command + leading args (tests run a Node fake this way). */
export type SidecarBinary =
  string | { readonly command: string; readonly args?: readonly string[] };

export interface RestartPolicy {
  /** Restarts allowed in a row (the count resets after `resetAfterMs` of stable capture). Default 3. */
  maxRestarts?: number;
  /** Backoff before the first restart; doubles (`factor`) per consecutive restart. Default 250 ms. */
  initialDelayMs?: number;
  /** Default 2. */
  factor?: number;
  /** Default 5000 ms. */
  maxDelayMs?: number;
  /** A child that captured this long counts as stable: the next crash starts the backoff afresh. Default 30 s. */
  resetAfterMs?: number;
}

export interface SidecarSourceOptions {
  /** Default: `locateSidecarBinary()`. */
  binary?: SidecarBinary;
  /** Default both (`mic`, `system`). */
  sources?: readonly AudioSourceKind[];
  /** Default 16 kHz. */
  sampleRate?: number;
  /** 20–100 ms; default: the sidecar's (50 ms). */
  frameMs?: number;
  /** Deterministic tone generator, no devices and no permission prompts. Every automated test uses it. */
  synthetic?: boolean;
  /** Mic echo cancellation (D-17). Default on; `false` passes `--no-aec` (headphones). */
  aec?: boolean;
  /** Sidecar stops itself after this long (`--duration`). */
  durationSeconds?: number;
  /** PIDs to keep out of the system tap (e.g. the app's own playback). */
  excludePids?: readonly number[];
  /**
   * Respawn the sidecar when it dies unexpectedly (crash, kill, protocol violation). The session continues:
   * no second `started`, the clock stays continuous and monotonic (the new process's timeline is shifted by
   * an offset ≈ wall time since capture start; the outage shows as a timestamp gap), a pause is re-applied.
   * Each crash is announced as an `error` event (`sidecar_exited` / `sidecar_protocol_error`), `fatal: false`
   * while a restart follows. `true` = default policy. Default: no restart (the crash is fatal).
   */
  restart?: boolean | RestartPolicy;
  /** Wait this long for the `started` frame. Default 10 s. */
  startTimeoutMs?: number;
  /** Graceful stop: wait this long after `{"cmd":"stop"}` + EOF, then SIGTERM. Default 5 s (the sidecar
   *  itself gives a stalled reader ≤ 3 s). */
  stopTimeoutMs?: number;
  /** After SIGTERM wait this long, then SIGKILL. Default 2 s. */
  killTimeoutMs?: number;
  /** Run `oat-audio version` and refuse an incompatible protocol before spawning. Default true. */
  checkVersion?: boolean;
  /** Environment for the child (default: inherited). */
  env?: NodeJS.ProcessEnv;
  /** Every stderr line (free-form logs, PROTOCOL.md). The last lines also go into crash messages. */
  onStderr?: (line: string) => void;
  /** Called with every error thrown by a listener. Default `console.error`. */
  onListenerError?: (error: unknown) => void;
}

const DEFAULT_RESTART: Required<RestartPolicy> = {
  maxRestarts: 3,
  initialDelayMs: 250,
  factor: 2,
  maxDelayMs: 5000,
  resetAfterMs: 30_000,
};
const STDERR_TAIL_LINES = 20;
/** A stderr "line" longer than this without a newline is cut (a misbehaving child cannot grow memory). */
const STDERR_MAX_LINE = 4096;

/** Thrown by `start()` (and `readSidecarVersion`) when the sidecar is missing, incompatible or fails early. */
export class SidecarError extends Error {
  override readonly name = 'SidecarError';
}

export interface LocateOptions {
  env?: NodeJS.ProcessEnv;
  /** Electron `process.resourcesPath` of a packaged app (packaging is task 9.1). */
  resourcesPath?: string;
}

/** `native/oat-audio/.build/release/oat-audio` in this repo (`pnpm --filter @oat/audio build:sidecar`). */
export const DEV_SIDECAR_PATH = fileURLToPath(
  new URL('../../../native/oat-audio/.build/release/oat-audio', import.meta.url),
);

/**
 * Find the sidecar binary: `OAT_AUDIO_BIN` (must exist if set), then the packaged app's resources
 * (`<resourcesPath>/oat-audio`, finalised with packaging in 9.1), then the dev build. `undefined` if none.
 */
export function locateSidecarBinary(options: LocateOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const fromEnv = env.OAT_AUDIO_BIN;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new SidecarError(`OAT_AUDIO_BIN=${fromEnv} does not exist`);
    return fromEnv;
  }
  const resources =
    options.resourcesPath ?? (process as { resourcesPath?: string }).resourcesPath ?? undefined;
  const candidates = [resources && join(resources, 'oat-audio'), DEV_SIDECAR_PATH];
  return candidates.find((p): p is string => !!p && existsSync(p));
}

function commandOf(binary: SidecarBinary): { command: string; args: string[] } {
  return typeof binary === 'string'
    ? { command: binary, args: [] }
    : { command: binary.command, args: [...(binary.args ?? [])] };
}

/** `oat-audio version` → `{ version, protocol }`. */
export function readSidecarVersion(
  binary: SidecarBinary,
  env?: NodeJS.ProcessEnv,
): Promise<{ version: string; protocol: number }> {
  const { command, args } = commandOf(binary);
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args, 'version'],
      { timeout: 5000, env: env ?? process.env },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new SidecarError(`\`${command} version\` failed: ${error.message} ${stderr}`.trim()),
          );
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as { version?: unknown; protocol?: unknown };
          if (typeof parsed.protocol !== 'number') throw new Error('no protocol number');
          resolve({ version: String(parsed.version ?? ''), protocol: parsed.protocol });
        } catch (e) {
          reject(
            new SidecarError(
              `\`${command} version\` printed ${JSON.stringify(stdout)}: ${(e as Error).message}`,
            ),
          );
        }
      },
    );
  });
}

/** Build the `capture` argument list for the options. */
export function captureArgs(options: SidecarSourceOptions): string[] {
  const args = ['capture'];
  const sources = options.sources ?? AUDIO_SOURCES;
  if (sources.length === 0) throw new RangeError('at least one source is required');
  // Default = both; naming one source restricts capture to it.
  if (sources.length === 1) args.push(`--${sources[0]}`);
  args.push('--sample-rate', String(options.sampleRate ?? DEFAULT_SAMPLE_RATE));
  if (options.frameMs !== undefined) args.push('--frame-ms', String(options.frameMs));
  if (options.synthetic) args.push('--synthetic');
  if (options.aec === false) args.push('--no-aec');
  if (options.durationSeconds !== undefined)
    args.push('--duration', String(options.durationSeconds));
  for (const pid of options.excludePids ?? []) args.push('--exclude-pid', String(pid));
  return args;
}

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: Error;
}

/** One sidecar process. A session has one, or several if it was restarted. */
interface Child {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly parser: FrameParser;
  readonly offsetUs: number;
  readonly exited: Promise<ExitInfo>;
  hasExited: boolean;
  started: boolean;
  handshake?: AudioEventOf<'started'>;
  startupEvents: AudioEvent[];
  startedAt: number;
  stopped?: AudioEventOf<'stopped'>;
  /** First failure we detected ourselves (protocol violation, start timeout); the process gets killed. */
  failure?: { code: string; message: string };
  stopSent: boolean;
  delivered: Record<AudioSourceKind, number>;
  /**
   * A process respawned while the session is paused starts unpaused: its audio is captured after the user
   * paused, so it is dropped until this process's own `paused` event confirms the re-applied pause.
   */
  muted: boolean;
  /** Samples dropped while `muted` (subtracted from the process's own `stopped.samples`). */
  discarded: Record<AudioSourceKind, number>;
  stderrTail: string[];
  stderrPartial: string;
  startTimer?: ReturnType<typeof setTimeout>;
  terminating?: Promise<void>;
}

/**
 * Live mic + system capture via the `oat-audio` sidecar process.
 *
 * - **Wire:** stdout is parsed incrementally (`FrameParser`, any chunking); frames become `AudioFrame`s
 *   (`tUs` on the sidecar's shared clock) and event frames typed `AudioEvent`s. stdin carries
 *   `{"cmd":"pause"|"resume"|"stop"}`. stderr is logs only (`onStderr`, and its tail in crash messages).
 * - **Pause:** `state` flips immediately; audio captured before the command can still arrive until the
 *   sidecar's `paused` event, which is forwarded as the authoritative pause point.
 * - **Never silent:** a process that dies without a `stopped` frame produces an `error` event with the exit
 *   status and stderr tail, then either a restart (`restart` option) or `stopped` with reason `error`.
 * - **Stop:** `stop()` sends `{"cmd":"stop"}` + EOF and waits `stopTimeoutMs` for a clean exit, then SIGTERM,
 *   then SIGKILL (announced with a non-fatal `sidecar_stop_timeout` error); `stopped` always follows.
 * - `stopped.samples` = samples delivered by earlier (crashed) processes + the last process's own count.
 */
export class SidecarSource implements AudioSource {
  readonly sampleRate: number;

  readonly #options: SidecarSourceOptions;
  readonly #restart: Required<RestartPolicy> | undefined;
  readonly #emitter: SourceEmitter;
  readonly #stopped: Promise<AudioEventOf<'stopped'>>;
  #resolveStopped!: (event: AudioEventOf<'stopped'>) => void;

  #state: AudioSourceState = 'idle';
  #starting: Promise<void> | undefined;
  #stopping: Promise<void> | undefined;
  #startWaiter: { resolve: () => void; reject: (error: Error) => void } | undefined;
  #stopRequested = false;
  #child: Child | undefined;
  #binary: SidecarBinary | undefined;
  #restarts = 0; // total
  #consecutiveRestarts = 0;
  #restartTimer: ReturnType<typeof setTimeout> | undefined;
  #announcedPaused = false;
  #wallOriginMs = 0; // performance.now() at capture-clock 0
  #lastUs = 0; // latest tUs seen on any frame/event
  #samplesBase: Record<AudioSourceKind, number> = { mic: 0, system: 0 };
  #started: AudioEventOf<'started'> | undefined;

  constructor(options: SidecarSourceOptions = {}) {
    this.#options = options;
    this.sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
    captureArgs(options); // validate early
    this.#restart =
      options.restart === true
        ? DEFAULT_RESTART
        : options.restart
          ? { ...DEFAULT_RESTART, ...options.restart }
          : undefined;
    this.#stopped = new Promise((resolve) => (this.#resolveStopped = resolve));
    this.#emitter = new SourceEmitter({
      ...(options.onListenerError ? { onListenerError: options.onListenerError } : {}),
      clockUs: () => this.#clockUs(),
      isStopped: () => this.#state === 'stopped',
    });
  }

  get state(): AudioSourceState {
    return this.#state;
  }

  /** PID of the current sidecar process (undefined between restarts / when not running). */
  get pid(): number | undefined {
    const child = this.#child;
    return child && !child.hasExited ? child.proc.pid : undefined;
  }

  /** How many times the sidecar was restarted in this session. */
  get restarts(): number {
    return this.#restarts;
  }

  /** The `started` event (after `start()` resolved). */
  get startedEvent(): AudioEventOf<'started'> | undefined {
    return this.#started;
  }

  onFrame(listener: (frame: AudioFrame) => void): Unsubscribe {
    return this.#emitter.onFrame(listener);
  }

  onEvent(listener: (event: AudioEvent) => void): Unsubscribe {
    return this.#emitter.onEvent(listener);
  }

  whenStopped(): Promise<AudioEventOf<'stopped'>> {
    return this.#stopped;
  }

  start(): Promise<void> {
    if (this.#state !== 'idle' || this.#starting) {
      return Promise.reject(new Error(`SidecarSource cannot start from state "${this.#state}"`));
    }
    this.#starting = this.#start().catch((error: unknown) => {
      this.#finish('error', false);
      throw error;
    });
    return this.#starting;
  }

  async #start(): Promise<void> {
    const binary =
      this.#options.binary ?? locateSidecarBinary({ env: this.#options.env ?? process.env });
    if (!binary) {
      throw new SidecarError(
        'oat-audio binary not found (set OAT_AUDIO_BIN or run `pnpm --filter @oat/audio build:sidecar`)',
      );
    }
    this.#binary = binary;
    if (this.#options.checkVersion !== false) {
      const { protocol, version } = await readSidecarVersion(binary, this.#options.env);
      if (protocol !== SIDECAR_PROTOCOL) {
        throw new SidecarError(
          `oat-audio ${version} speaks protocol ${protocol}; this build of @oat/audio needs ${SIDECAR_PROTOCOL}`,
        );
      }
    }
    if (this.#stopRequested) {
      // stop() during the version check: never spawn; like FileSource, no `started`/`stopped` events.
      this.#finish('command', false);
      return;
    }
    const started = new Promise<void>(
      (resolve, reject) => (this.#startWaiter = { resolve, reject }),
    );
    this.#spawn(0);
    try {
      await started;
    } finally {
      this.#startWaiter = undefined;
    }
  }

  /** Concurrent and repeated calls share one stop. */
  stop(): Promise<void> {
    this.#stopping ??= this.#stop();
    return this.#stopping;
  }

  async #stop(): Promise<void> {
    this.#stopRequested = true;
    if (this.#state === 'idle' && !this.#starting) {
      this.#finish('command', false);
      return;
    }
    // A process still starting (e.g. waiting on a permission prompt) is terminated now rather than after
    // `startTimeoutMs`; start() then resolves without `started` (same as a stop during the version check).
    const starting = this.#child;
    if (starting && !starting.started) void this.#terminate(starting, false);
    await this.#starting?.catch(() => undefined);
    if (this.#state === 'stopped') {
      await this.#stopped;
      if (this.#child) await this.#child.exited;
      return;
    }
    if (this.#restartTimer !== undefined) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = undefined;
      this.#finish('command', true);
      return;
    }
    const child = this.#child;
    if (child) await this.#terminate(child, true);
    await this.#stopped;
  }

  pause(): void {
    if (this.#state !== 'running') return;
    this.#state = 'paused';
    if (!this.#send('pause')) this.#announcePaused(true, this.#clockUs());
  }

  resume(): void {
    if (this.#state !== 'paused') return;
    this.#state = 'running';
    if (!this.#send('resume')) this.#announcePaused(false, this.#clockUs());
  }

  // ── process lifecycle ────────────────────────────────────────────────────────────────────────────────

  #spawn(offsetUs: number, durationSeconds = this.#options.durationSeconds): Child {
    const { command, args } = commandOf(this.#binary as SidecarBinary);
    const capture = captureArgs({
      ...this.#options,
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    });
    const proc = spawn(command, [...args, ...capture], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.#options.env ?? process.env,
    });
    let resolveExit!: (info: ExitInfo) => void;
    const child: Child = {
      proc,
      parser: new FrameParser(),
      offsetUs,
      exited: new Promise((resolve) => (resolveExit = resolve)),
      hasExited: false,
      started: false,
      startupEvents: [],
      startedAt: performance.now(),
      stopSent: false,
      delivered: { mic: 0, system: 0 },
      muted: false,
      discarded: { mic: 0, system: 0 },
      stderrTail: [],
      stderrPartial: '',
    };
    this.#child = child;
    const startTimeoutMs = this.#options.startTimeoutMs ?? 10_000;
    child.startTimer = setTimeout(
      () =>
        this.#fail(
          child,
          'sidecar_start_timeout',
          `no \`started\` frame within ${startTimeoutMs} ms`,
        ),
      startTimeoutMs,
    );

    let spawnError: Error | undefined;
    proc.on('error', (error) => {
      // Spawn failure (ENOENT, EACCES) or a failed kill(); a spawn failure never emits 'close' reliably.
      spawnError ??= error;
      if (proc.pid === undefined) finalizeExit(null, null);
    });
    proc.on('close', (code, signal) => finalizeExit(code, signal));
    const finalizeExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (child.hasExited) return;
      child.hasExited = true;
      clearTimeout(child.startTimer);
      const info: ExitInfo = { code, signal, ...(spawnError ? { spawnError } : {}) };
      resolveExit(info);
      this.#onExit(child, info);
    };

    proc.stdin.on('error', () => undefined); // EPIPE after the child died: the exit path reports it
    proc.stdout.on('data', (chunk: Buffer) => this.#onData(child, chunk));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (text: string) => this.#onStderr(child, text));
    return child;
  }

  #onStderr(child: Child, text: string): void {
    const lines = (child.stderrPartial + text).split('\n');
    child.stderrPartial = lines.pop() ?? '';
    if (child.stderrPartial.length > STDERR_MAX_LINE) {
      lines.push(`${child.stderrPartial.slice(0, STDERR_MAX_LINE)}…`);
      child.stderrPartial = '';
    }
    for (const line of lines) {
      child.stderrTail.push(line);
      if (child.stderrTail.length > STDERR_TAIL_LINES) child.stderrTail.shift();
      this.#options.onStderr?.(line);
    }
  }

  #onData(child: Child, chunk: Buffer): void {
    if (child !== this.#child || child.failure || this.#state === 'stopped') return;
    let frames: RawFrame[];
    try {
      frames = child.parser.push(chunk);
    } catch (error) {
      this.#fail(child, 'sidecar_protocol_error', (error as Error).message);
      return;
    }
    for (const raw of frames) {
      try {
        this.#onFrame(child, raw);
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        this.#fail(child, 'sidecar_protocol_error', error.message);
      }
      if (child.failure || this.#isStopped()) return;
    }
  }

  #isStopped(): boolean {
    return this.#state === 'stopped';
  }

  #onFrame(child: Child, raw: RawFrame): void {
    if (!child.started) {
      this.#onStartupFrame(child, raw);
      return;
    }

    if (raw.kind === KIND.AUDIO) {
      const frame = toAudioFrame(raw, this.sampleRate, child.offsetUs);
      this.#lastUs = Math.max(this.#lastUs, frame.tUs);
      if (child.muted) {
        child.discarded[frame.source] += frame.pcm.length;
        return;
      }
      child.delivered[frame.source] += frame.pcm.length;
      this.#emitter.emitFrame(frame);
      return;
    }

    const event = toAudioEvent(raw, child.offsetUs);
    if (!event) return; // unknown type: ignored (forward compatible)
    this.#lastUs = Math.max(this.#lastUs, event.tUs);
    switch (event.type) {
      case 'started':
        return; // duplicate: ignore
      case 'paused':
      case 'resumed':
        if (event.type === 'paused') child.muted = false;
        this.#announcePaused(event.type === 'paused', event.tUs);
        return;
      case 'stopped': {
        child.stopped = event;
        const reason = this.#stopRequested && event.reason !== 'error' ? 'command' : event.reason;
        this.#finish(reason, true, event);
        void this.#terminate(child, false); // normally it exits by itself right after `stopped`
        return;
      }
      default:
        this.#emitter.emitEvent(event);
    }
  }

  #onStartupFrame(child: Child, raw: RawFrame): void {
    // A stop during a permission dialog can race with the helper becoming ready.
    if (this.#stopRequested) return;
    if (!child.handshake) {
      if (raw.kind !== KIND.EVENT || raw.event?.type !== 'started') {
        throw new ProtocolError('first frame is not a `started` event');
      }
      const started = toAudioEvent(raw, child.offsetUs) as AudioEventOf<'started'>;
      if (started.protocol !== SIDECAR_PROTOCOL) {
        throw new ProtocolError(`unsupported protocol ${String(started.protocol)}`);
      }
      if (started.sampleRate !== this.sampleRate) {
        throw new ProtocolError(`sample rate ${started.sampleRate}, expected ${this.sampleRate}`);
      }
      child.handshake = started;
      clearTimeout(child.startTimer); // Device setup can now wait for macOS permission prompts.
      if (!this.#started) this.#wallOriginMs = performance.now() - Number(raw.tUs) / 1000;
      if (raw.event.await_capture_ready === true) return;
    } else if (raw.event?.type !== 'capture_ready') {
      if (raw.kind !== KIND.EVENT) throw new ProtocolError('audio before `capture_ready`');
      const event = toAudioEvent(raw, child.offsetUs);
      if (event?.type === 'stopped') {
        // On an initial failure, wait for exit so start() rejects with the helper's diagnostics.
        if (this.#started) {
          this.#flushStartupEvents(child);
          this.#finish(event.reason, true, event);
          void this.#terminate(child, false);
        }
      } else if (event?.type === 'error') {
        child.startupEvents.push(event);
      }
      return;
    }

    const started = child.handshake;
    child.started = true;
    child.startedAt = performance.now();
    this.#lastUs = Math.max(this.#lastUs, started.tUs);
    if (!this.#started) {
      this.#started = started;
      this.#state = 'running';
      this.#emitter.emitEvent(started);
      this.#startWaiter?.resolve();
    } else if (this.#state === 'paused') {
      // Re-apply pause across a restart, dropping audio until the child confirms it.
      child.muted = true;
      this.#send('pause');
    }
    this.#flushStartupEvents(child);
  }

  #flushStartupEvents(child: Child): void {
    for (const event of child.startupEvents) {
      this.#lastUs = Math.max(this.#lastUs, event.tUs);
      this.#emitter.emitEvent(event);
    }
    child.startupEvents = [];
  }

  #announcePaused(paused: boolean, tUs: number): void {
    if (this.#announcedPaused === paused) return;
    this.#announcedPaused = paused;
    this.#emitter.emitEvent({ type: paused ? 'paused' : 'resumed', tUs });
  }

  /** We detected a fatal problem with this process: remember why and kill it; `#onExit` takes over. */
  #fail(child: Child, code: string, message: string): void {
    if (child.failure || child.hasExited) return;
    child.failure = { code, message };
    child.proc.kill('SIGKILL');
  }

  #onExit(child: Child, info: ExitInfo): void {
    if (child !== this.#child || this.#state === 'stopped') return;
    const why = describeExit(child, info);

    if (!child.started && !this.#started) {
      if (this.#stopRequested) {
        // stop() while the first process was starting: start() resolves, no events (like FileSource).
        this.#finish('command', false);
        this.#startWaiter?.resolve();
        return;
      }
      // The first process never started: start() rejects (and #finish('error') runs there).
      const startupErrors = child.startupEvents
        .filter((event): event is AudioEventOf<'error'> => event.type === 'error' && event.fatal)
        .map((event) => `${event.source ?? 'capture'} ${event.code}: ${event.message}`);
      this.#startWaiter?.reject(new SidecarError([why, ...startupErrors].join('; ')));
      return;
    }
    if (this.#stopRequested) {
      // Asked to stop and it exited without a `stopped` frame (e.g. killed after the timeout).
      this.#finish('command', true);
      return;
    }

    const code =
      child.failure?.code === 'sidecar_protocol_error'
        ? 'sidecar_protocol_error'
        : 'sidecar_exited';
    const policy = this.#restart;
    if (policy && child.started && performance.now() - child.startedAt >= policy.resetAfterMs) {
      this.#consecutiveRestarts = 0;
    }
    if (policy && this.#consecutiveRestarts < policy.maxRestarts) {
      const delay = Math.min(
        policy.maxDelayMs,
        policy.initialDelayMs * policy.factor ** this.#consecutiveRestarts,
      );
      this.#consecutiveRestarts++;
      this.#emitter.emitEvent({
        type: 'error',
        tUs: this.#clockUs(),
        code,
        message: `${why}; restarting in ${Math.round(delay)} ms (attempt ${this.#consecutiveRestarts}/${policy.maxRestarts})`,
        fatal: false,
      });
      this.#samplesBase = addSamples(this.#samplesBase, child.delivered);
      this.#restartTimer = setTimeout(() => {
        this.#restartTimer = undefined;
        if (this.#state === 'stopped') return;
        // With `durationSeconds`, the new process only captures what is left (by audio delivered so far).
        let remaining = this.#options.durationSeconds;
        if (remaining !== undefined) {
          const capturedS =
            Math.max(this.#samplesBase.mic, this.#samplesBase.system) / this.sampleRate;
          remaining -= capturedS;
          if (remaining < 0.001) {
            this.#finish('duration', true);
            return;
          }
        }
        this.#restarts++;
        // Shift the new process's clock past everything delivered so far: ≈ wall time since capture
        // start, so the outage shows as a gap, and strictly after the last timestamp.
        const offsetUs = Math.max(
          Math.round((performance.now() - this.#wallOriginMs) * 1000),
          this.#lastUs + 1,
        );
        this.#spawn(offsetUs, remaining);
      }, delay);
      return;
    }

    this.#emitter.emitEvent({
      type: 'error',
      tUs: this.#clockUs(),
      code,
      message: policy ? `${why}; giving up after ${policy.maxRestarts} restarts` : why,
      fatal: true,
    });
    this.#finish('error', true);
  }

  /**
   * Graceful stop of one process: stop command + EOF → wait → SIGTERM → wait → SIGKILL. A process that has
   * not started yet gets SIGTERM right away. One escalation per process, however often it is called.
   */
  #terminate(child: Child, announce: boolean): Promise<void> {
    child.terminating ??= this.#escalate(child, announce);
    return child.terminating;
  }

  async #escalate(child: Child, announce: boolean): Promise<void> {
    if (child.hasExited) return;
    if (!child.stopSent) {
      child.stopSent = true;
      if (child.started) this.#write(child, 'stop');
      child.proc.stdin.end();
    }
    const stopMs = child.started ? (this.#options.stopTimeoutMs ?? 5000) : 0;
    const killMs = this.#options.killTimeoutMs ?? 2000;
    if (await exitsWithin(child, stopMs)) return;
    if (announce && this.#state !== 'stopped') {
      this.#emitter.emitEvent({
        type: 'error',
        tUs: this.#clockUs(),
        code: 'sidecar_stop_timeout',
        message: `oat-audio did not stop within ${stopMs} ms; sending SIGTERM`,
        fatal: false,
      });
    }
    child.proc.kill('SIGTERM');
    if (await exitsWithin(child, killMs)) return;
    child.proc.kill('SIGKILL');
    await child.exited;
  }

  /** Send a command to the current process; false if there is none that has started. */
  #send(cmd: 'pause' | 'resume' | 'stop'): boolean {
    const child = this.#child;
    if (!child || !child.started || child.hasExited || child.failure || child.stopSent)
      return false;
    this.#write(child, cmd);
    return true;
  }

  #write(child: Child, cmd: string): void {
    if (child.proc.stdin.writable) child.proc.stdin.write(`${JSON.stringify({ cmd })}\n`);
  }

  #finish(reason: AudioStopReason, emit: boolean, fromSidecar?: AudioEventOf<'stopped'>): void {
    if (this.#state === 'stopped') return;
    this.#state = 'stopped';
    const child = this.#child;
    const last = fromSidecar
      ? subtractSamples(fromSidecar.samples, child?.discarded ?? { mic: 0, system: 0 })
      : (child?.delivered ?? { mic: 0, system: 0 });
    const event: AudioEventOf<'stopped'> = {
      type: 'stopped',
      tUs: fromSidecar?.tUs ?? this.#clockUs(),
      reason,
      samples: addSamples(this.#samplesBase, last),
    };
    if (emit) this.#emitter.emitEvent(event);
    this.#emitter.clear();
    this.#resolveStopped(event);
    if (child && !child.hasExited && !fromSidecar) void this.#terminate(child, false);
  }

  /** Best estimate of the session clock now (for events we synthesize). */
  #clockUs(): number {
    if (!this.#started) return 0;
    return Math.max(this.#lastUs, Math.round((performance.now() - this.#wallOriginMs) * 1000));
  }
}

function addSamples(
  a: Readonly<Record<AudioSourceKind, number>>,
  b: Readonly<Record<AudioSourceKind, number>>,
): Record<AudioSourceKind, number> {
  return { mic: a.mic + b.mic, system: a.system + b.system };
}

function subtractSamples(
  a: Readonly<Record<AudioSourceKind, number>>,
  b: Readonly<Record<AudioSourceKind, number>>,
): Record<AudioSourceKind, number> {
  return { mic: Math.max(0, a.mic - b.mic), system: Math.max(0, a.system - b.system) };
}

function exitsWithin(child: Child, ms: number): Promise<boolean> {
  if (child.hasExited) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void child.exited.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function describeExit(child: Child, info: ExitInfo): string {
  const parts: string[] = [];
  if (child.failure) parts.push(`${child.failure.message} (process killed)`);
  if (info.spawnError) parts.push(`could not run oat-audio: ${info.spawnError.message}`);
  else {
    const status = info.signal ? `signal ${info.signal}` : `code ${String(info.code)}`;
    parts.push(
      child.started
        ? `oat-audio exited unexpectedly (${status})`
        : `oat-audio exited before starting (${status})`,
    );
  }
  const tail = [...child.stderrTail, child.stderrPartial].filter((l) => l.trim()).slice(-5);
  if (tail.length) parts.push(`stderr: ${tail.join(' | ')}`);
  return parts.join('; ');
}
