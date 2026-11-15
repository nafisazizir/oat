/**
 * Recording + live transcript in the main process (task 2.5). Electron-free (sources and the STT provider
 * are injected), so the whole pipeline is unit-tested with `FileSource` + `FakeSttProvider`.
 *
 * ```
 *   AudioSource (SidecarSource | FileSource)
 *        │ frames + events
 *        ▼
 *   RecordingController ──► RecordingArchive  → <userData>/audio/<meeting>/{mic,system}[.n].opus (D-10/24)
 *        │              └─► SttPipe → SttStream per source (DeepgramProvider; mock in dev)  (D-17)
 *        │                              │ segments (recording clock)
 *        ▼                              ▼
 *   RecordingSnapshot (throttled)   TranscriptBuffer (meeting clock, batched)  → windows
 * ```
 *
 * - Every consumer has its own bounded queue (`RecordingController.subscribe`): STT being slow or down
 *   never delays capture or the archive. While STT is down the provider keeps reconnecting and replays
 *   its rolling buffer; the recording and the archive carry on (SPEC §8).
 * - Nothing fails silently: capture, STT and archive problems become `issues` on the snapshot.
 * - Times: STT segments come on the recording clock (frame `tUs`); the transcript uses the meeting clock
 *   = recording ms − session origin (`started.tUs`) + the session's offset in the meeting (0 for the first
 *   session; the end of the previous one for a resumed meeting, D-24), the clock the archive parts use.
 */
import {
  type ArchiveError,
  type AudioEvent,
  type AudioEventOf,
  type AudioFrame,
  type AudioRecording,
  type AudioRecordingStore,
  type AudioSource,
  type AudioSourceKind,
  type AudioSourceState,
  type FrameSubscription,
  InMemoryAudioRecordingStore,
  RecordingArchive,
  RecordingController,
  type RecordingError,
  type Unsubscribe,
} from '@oat/audio/node';
import type {
  ArchivedAudio,
  AudioLevel,
  LiveSegment,
  RecordingIssue,
  RecordingSnapshot,
  RecordingStatus,
  SttStreamStatus,
  TranscriptBatch,
  TranscriptSnapshot,
} from '@oat/core/bridge';
import type { SttError, SttProvider, SttSegment, SttStream } from '@oat/stt';
import { uuidv7 } from '@oat/stt/ids';

import { formatClock } from '../shared/transcript.ts';
import type { Logger } from './ipc.ts';
import { TranscriptBuffer } from './transcript-buffer.ts';

export type InputSpec = { input: 'sidecar' } | { input: 'file'; fixture: string };

/**
 * Where the meeting and its final segments are stored (2.6: the local SQLite cache, synced). Segments are
 * on the meeting clock; an empty final is a retraction.
 */
export interface TranscriptPersistence {
  /** Before the audio starts (new or resumed meeting). A rejection fails the start with its message. */
  beginMeeting(meetingId: string, startedAt: number): Promise<void>;
  saveSegment(meetingId: string, segment: LiveSegment): void;
  /** Latest stored segment end of a meeting (ms, meeting clock), for resuming it after a relaunch. */
  meetingEndMs?(meetingId: string): number;
  /** After a recording session's files are closed. */
  endMeeting(meetingId: string, endedAt: number): void;
}

export interface SttContext {
  meetingId: string;
  spec: InputSpec;
}

export interface RecordingServiceOptions {
  /** Data folder (`app.getPath('userData')`); audio goes to `<baseDir>/audio/`. */
  baseDir: string;
  /** A fresh source per recording session. May throw (e.g. no sidecar binary): the start fails visibly. */
  createSource: (spec: InputSpec) => AudioSource;
  /**
   * The STT provider for a session. Called at start, in parallel with the audio starting; frames wait
   * in the STT queue meanwhile (never the archive's). A rejection is reported and the session records
   * without a transcript.
   */
  createStt: (context: SttContext) => Promise<SttProvider>;
  /** `audio_recording` rows (SQLite in the app, 2.6). Default in memory. */
  store?: AudioRecordingStore;
  /** The signed-in account, stored on the audio rows (D-30). */
  userId?: () => string | null;
  /** Meeting + final segments to the local database (2.6). Without it the transcript lives in memory. */
  persistence?: TranscriptPersistence;
  onState?: (snapshot: RecordingSnapshot) => void;
  onSegments?: (batch: TranscriptBatch) => void;
  /** Coarse status for the main store (every window). */
  onStatus?: (status: RecordingStatus, meetingId: string | null) => void;
  log: Logger;
  /** Wall clock (Unix ms). */
  now?: () => number;
  newMeetingId?: () => string;
  /** Minimum gap between `onState` pushes for levels/elapsed. Status changes go out at once. Default 100. */
  stateThrottleMs?: number;
  /** Transcript batch window. Default 50 ms. */
  batchMs?: number;
  /** STT frames queued (per service) while the provider is being resolved. Default 3000 (~30 s). */
  sttQueueFrames?: number;
  /**
   * System sleep/wake (Electron `powerMonitor`). On `suspend` a running recording pauses (nothing can be
   * captured while the Mac sleeps) with a visible note; on `resume` it resumes. Elapsed time and the
   * audio files therefore never include the sleep.
   */
  power?: PowerEvents;
}

/** The part of Electron's `powerMonitor` the service uses. */
export interface PowerEvents {
  on(event: 'suspend' | 'resume', listener: () => void): unknown;
}

const SLEEP_ISSUE = 'system_sleep';

/** Thrown by commands; `code` maps to a bridge error code. */
export class RecordingServiceError extends Error {
  override name = 'RecordingServiceError';
  constructor(
    readonly code: 'invalid_state' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

const MAX_ISSUES = 20;
/** `createStt` must settle within this; otherwise the session records without a transcript. */
const PROVIDER_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

interface Session {
  readonly meetingId: string;
  readonly spec: InputSpec;
  /** Where this session starts on the meeting clock. */
  readonly offsetMs: number;
  readonly archive: RecordingArchive;
  readonly stt: SttPipe;
  /** Recording clock (frame `tUs`) of the `started` event: session time 0. */
  originUs: number | undefined;
  lastEndUs: number | undefined;
  finalized: Promise<AudioRecording[]> | undefined;
}

export class RecordingService {
  readonly #o: RecordingServiceOptions;
  readonly #now: () => number;
  readonly #store: AudioRecordingStore;
  readonly #controller: RecordingController;
  readonly #transcript: TranscriptBuffer;
  /** Meeting-clock end of each meeting recorded since launch (the next part's offset, D-24). */
  readonly #meetingEnds = new Map<string, number>();

  #session: Session | undefined;
  #nextSpec: InputSpec | undefined;
  #starting = false;
  /** The meeting a start in progress records into, as soon as it is known (3.8: storage must not touch it). */
  #startingMeetingId: string | undefined;
  #stopping = false;
  /** The stop in progress (a second stop, or quit, waits for the same one). */
  #stopPromise: Promise<{ meetingId: string | null; audio: ArchivedAudio[] }> | undefined;
  /** Files of the last session are still being closed. */
  #closing = false;
  /** Wall clock when the system went to sleep while we were recording (we paused for it). */
  #sleptAt: number | undefined;
  #seq = 0;
  #issueId = 0;
  #issues: RecordingIssue[] = [];
  #levels: Record<AudioSourceKind, AudioLevel | null> = { mic: null, system: null };
  #stt: Record<AudioSourceKind, SttStreamStatus> = { mic: 'idle', system: 'idle' };
  #startedAt: number | null = null;
  #stateTimer: ReturnType<typeof setTimeout> | undefined;
  #lastStatus: RecordingStatus = 'idle';

  constructor(options: RecordingServiceOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#store = options.store ?? new InMemoryAudioRecordingStore();
    this.#transcript = new TranscriptBuffer({
      onBatch: (batch) => this.#o.onSegments?.(batch),
      ...(options.batchMs !== undefined ? { batchMs: options.batchMs } : {}),
    });
    this.#controller = new RecordingController({
      createSource: () => {
        try {
          return this.#o.createSource(this.#nextSpec!);
        } catch (error) {
          // e.g. no sidecar binary: fail like a source that can't start (state `error`, visible issue).
          return new UnavailableSource(error);
        }
      },
    });
    this.#controller.onStateChange((change) => {
      if (change.to === 'idle' || change.to === 'error') {
        // The source ended (stop, end of a fixture, crash): close STT streams and audio files.
        const session = this.#session;
        if (session) void this.#finalize(session);
      }
      this.#changed(true);
    });
    this.#controller.onLevel((event) => {
      this.#levels[event.source] = { rmsDb: event.rmsDb, peakDb: event.peakDb };
      this.#changed();
    });
    this.#controller.onError((error) => this.#audioIssue(error));
    this.#controller.onEvent((event) => this.#onAudioEvent(event));
    options.power?.on('suspend', () => this.#onSuspend());
    options.power?.on('resume', () => this.#onResume());
  }

  get status(): RecordingStatus {
    if (this.#stopping) return 'stopping';
    return this.#controller.state;
  }

  /**
   * Something is in flight that a quit or sign-out must wait for: a recording (any non-idle status), a
   * start, or the files of an ended session still being closed.
   */
  get busy(): boolean {
    return this.status !== 'idle' || this.#starting || this.#closing;
  }

  get meetingId(): string | null {
    return this.#session?.meetingId ?? this.#transcript.meetingId;
  }

  /**
   * The meeting whose audio is in use right now (starting, recording, stopping, files closing), else `null`.
   * Unlike `meetingId`, it names a resumed meeting from the very start of `start()` (3.8).
   */
  get busyMeetingId(): string | null {
    return this.#startingMeetingId ?? (this.busy ? this.meetingId : null);
  }

  /** Audio rows of every session since launch (tests, 2.6). */
  get audioStore(): AudioRecordingStore {
    return this.#store;
  }

  snapshot(): RecordingSnapshot {
    const session = this.#session;
    return {
      seq: this.#seq,
      status: this.status,
      meetingId: this.meetingId,
      input: session?.spec.input ?? null,
      fixture: session?.spec.input === 'file' ? session.spec.fixture : null,
      startedAt: this.#startedAt,
      elapsedMs: Math.max(0, Math.round(this.#controller.elapsedMs)),
      elapsedAt: this.#now(),
      levels: { ...this.#levels },
      stt: { ...this.#stt },
      issues: [...this.#issues],
    };
  }

  transcript(): TranscriptSnapshot {
    return this.#transcript.snapshot();
  }

  async start({
    meetingId: requested,
    spec,
  }: {
    meetingId?: string;
    spec: InputSpec;
  }): Promise<{ meetingId: string }> {
    // Checked and claimed synchronously: two concurrent starts can't both get past here.
    if (this.#starting || this.#stopping || !['idle', 'error'].includes(this.#controller.state)) {
      throw new RecordingServiceError('invalid_state', 'Already recording.');
    }
    this.#starting = true;
    this.#startingMeetingId = requested;
    try {
      return await this.#start(requested, spec);
    } finally {
      this.#starting = false;
      this.#startingMeetingId = undefined;
    }
  }

  /**
   * Where an earlier part of this meeting ended when this launch didn't record it (D-24: after a relaunch the
   * new part continues the meeting clock): the end of its archived audio parts, or of its stored transcript,
   * whichever is later. 0 for a new meeting.
   */
  async #persistedEnd(meetingId: string): Promise<number> {
    let end = 0;
    try {
      for (const row of await this.#store.list({ meetingId })) {
        end = Math.max(end, row.offsetMs + row.durationMs);
      }
    } catch (error) {
      this.#o.log.error('recording: could not read earlier parts of the meeting', error);
    }
    try {
      end = Math.max(end, this.#o.persistence?.meetingEndMs?.(meetingId) ?? 0);
    } catch (error) {
      this.#o.log.error('recording: could not read the meeting’s transcript end', error);
    }
    return Math.round(end);
  }

  async #start(requested: string | undefined, spec: InputSpec): Promise<{ meetingId: string }> {
    const previous = this.#session;
    if (previous?.finalized) await previous.finalized; // files of the last session are closed first
    if (this.#controller.state === 'error') await this.#controller.stop(); // acknowledge
    this.#sleptAt = undefined;

    const meetingId = requested ?? (this.#o.newMeetingId ?? (() => uuidv7()))();
    this.#startingMeetingId = meetingId;
    if (this.#o.persistence) {
      try {
        await this.#o.persistence.beginMeeting(meetingId, this.#now());
      } catch (error) {
        this.#o.log.error('recording: could not create the meeting', error);
        throw new RecordingServiceError(
          'unavailable',
          error instanceof Error && error.name === 'PersistenceError'
            ? error.message
            : 'Recording couldn’t start: the meeting can’t be saved on this Mac.',
        );
      }
    }
    if (this.#transcript.meetingId !== meetingId) this.#transcript.reset(meetingId);
    const offsetMs = this.#meetingEnds.get(meetingId) ?? (await this.#persistedEnd(meetingId));

    this.#issues = [];
    this.#levels = { mic: null, system: null };
    this.#stt = { mic: 'idle', system: 'idle' };
    this.#startedAt = null;
    this.#nextSpec = spec;

    const archive = new RecordingArchive({
      controller: this.#controller,
      store: this.#store,
      baseDir: this.#o.baseDir,
      meetingId,
      userId: this.#o.userId?.() ?? null,
      offsetMs,
      onError: (error) => this.#archiveIssue(error),
    });
    const provider = withTimeout(
      this.#o.createStt({ meetingId, spec }),
      PROVIDER_TIMEOUT_MS,
      'timed out',
    ).catch((error: unknown) => {
      this.#o.log.error('recording: no transcription provider', error);
      this.#issue({
        scope: 'stt',
        code: 'unavailable',
        message:
          'Live transcription couldn’t start. Recording continues; audio is saved on this Mac.',
        source: null,
        fatal: true,
      });
      return undefined;
    });
    // Callbacks only act while their session is the current one (a late event of an old session is ignored).
    const ref: { session?: Session } = {};
    const current = () => (ref.session && this.#session === ref.session ? ref.session : undefined);
    const stt = new SttPipe({
      controller: this.#controller,
      provider,
      maxQueuedFrames: this.#o.sttQueueFrames ?? 3000,
      onFrame: (frame) => {
        const s = current();
        if (!s) return;
        const end = frame.tUs + (frame.pcm.length / frame.sampleRate) * 1e6;
        s.lastEndUs = Math.max(s.lastEndUs ?? end, end);
      },
      onSegment: (segment) => {
        const s = current();
        if (s) this.#onSegment(s, segment);
      },
      onStatus: (source, status) => {
        if (!current()) return;
        this.#stt[source] = status;
        this.#changed(true);
      },
      onError: (source, error) => {
        if (current()) this.#sttIssue(source, error);
      },
    });
    const session: Session = {
      meetingId,
      spec,
      offsetMs,
      archive,
      stt,
      originUs: undefined,
      lastEndUs: undefined,
      finalized: undefined,
    };
    ref.session = session;
    this.#session = session;

    try {
      await this.#controller.start();
    } catch (error) {
      this.#o.log.error('recording: start failed', error);
      await this.#finalize(session);
      throw new RecordingServiceError('unavailable', startFailureMessage(error));
    }
    return { meetingId };
  }

  pause(): void {
    this.#command('pause', () => this.#controller.pause());
  }

  resume(): void {
    this.#command('resume', () => this.#controller.resume());
    this.#sleptAt = undefined; // resumed by hand: don't resume again on wake
  }

  /**
   * Stops recording (or acknowledges an error) and resolves once the last transcript finals are in (or
   * given up on) and the audio files are closed.
   */
  stop(): Promise<{ meetingId: string | null; audio: ArchivedAudio[] }> {
    this.#stopPromise ??= this.#stop().finally(() => (this.#stopPromise = undefined));
    return this.#stopPromise;
  }

  async #stop(): Promise<{ meetingId: string | null; audio: ArchivedAudio[] }> {
    const session = this.#session;
    const state = this.#controller.state;
    if (!session) return { meetingId: null, audio: [] };
    this.#sleptAt = undefined;
    this.#stopping = true;
    this.#changed(true);
    try {
      if (state === 'starting' || state === 'recording' || state === 'paused') {
        await this.#controller.stop();
      }
      const rows = await this.#finalize(session);
      if (this.#controller.state === 'error') await this.#controller.stop(); // acknowledge → idle
      return {
        meetingId: session.meetingId,
        audio: rows.map((r) => ({
          source: r.source,
          part: r.part,
          status: r.status,
          durationMs: r.durationMs,
          bytes: r.bytes,
        })),
      };
    } finally {
      this.#stopping = false;
      this.#changed(true);
    }
  }

  /**
   * App quit / sign-out: resolves once nothing is in flight — a running recording is stopped gracefully
   * (last finals, closed files), a stop in progress or an ended session's file closing is waited for.
   */
  async shutdown(): Promise<void> {
    while (this.#starting) await new Promise((r) => setTimeout(r, 20));
    const pending = this.#stopPromise ?? this.#session?.finalized;
    if (pending) {
      await pending.catch(() => undefined);
      return;
    }
    if (this.#session) await this.stop().catch(() => undefined);
  }

  // --- internals ---------------------------------------------------------------------------------

  #command(name: string, fn: () => void): void {
    if (this.#stopping) throw new RecordingServiceError('invalid_state', `Can’t ${name} now.`);
    try {
      fn();
    } catch (error) {
      throw new RecordingServiceError(
        'invalid_state',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** Closes STT streams and archive files of a session that has ended. Idempotent. */
  #finalize(session: Session): Promise<AudioRecording[]> {
    if (session.finalized) return session.finalized;
    this.#closing = true;
    session.finalized = (async () => {
      const [rows] = await Promise.all([
        session.archive.detach().catch((error: unknown) => {
          this.#o.log.error('recording: archive did not close', error);
          return [] as AudioRecording[];
        }),
        session.stt.finish(),
      ]);
      this.#transcript.flush();
      try {
        this.#o.persistence?.endMeeting(session.meetingId, this.#now());
      } catch (error) {
        this.#o.log.error('recording: could not stamp the meeting end', error);
      }
      const sessionMs = Math.max(
        0,
        ...rows.map((r) => r.durationMs),
        session.originUs !== undefined && session.lastEndUs !== undefined
          ? (session.lastEndUs - session.originUs) / 1000
          : 0,
      );
      this.#meetingEnds.set(session.meetingId, Math.round(session.offsetMs + sessionMs));
      return rows;
    })().finally(() => {
      if (this.#session === session) this.#closing = false;
      this.#changed(true);
    });
    return session.finalized;
  }

  // --- system sleep (SPEC §8: never stop silently; elapsed and files exclude the sleep) ---------------

  #onSuspend(): void {
    if (this.#controller.state !== 'recording' || this.#stopping) return;
    try {
      this.#controller.pause();
    } catch {
      return;
    }
    this.#sleptAt = this.#now();
    this.#o.log.info('recording: system sleep, paused');
    this.#issue({
      scope: 'audio',
      code: SLEEP_ISSUE,
      message: 'Paused while your Mac was asleep.',
      source: null,
      fatal: false,
    });
  }

  #onResume(): void {
    const sleptAt = this.#sleptAt;
    if (sleptAt === undefined) return;
    this.#sleptAt = undefined;
    const minutes = Math.max(1, Math.round((this.#now() - sleptAt) / 60_000));
    // Keep the note, now with how long nothing was recorded.
    const i = this.#issues.findLastIndex((x) => x.code === SLEEP_ISSUE);
    if (i >= 0) {
      this.#issues[i] = {
        ...this.#issues[i]!,
        message: `Paused while your Mac was asleep (${minutes} min); nothing was recorded then. Recording resumed.`,
        at: this.#now(),
      };
    }
    if (this.#controller.state === 'paused' && !this.#stopping) {
      try {
        this.#controller.resume();
        this.#o.log.info('recording: system resumed, recording resumed');
      } catch (error) {
        this.#o.log.warn(`recording: could not resume after sleep (${String(error)})`);
      }
    }
    this.#changed(true);
  }

  #onAudioEvent(event: AudioEvent): void {
    const session = this.#session;
    if (!session) return;
    if (event.type === 'started') {
      session.originUs = event.tUs;
      this.#startedAt = this.#now();
      this.#changed(true);
    } else if (event.type === 'overrun') {
      this.#issue({
        scope: 'audio',
        code: 'overrun',
        message: `${who(event.source)} audio skipped ${Math.round(event.droppedMs)} ms (the computer was busy).`,
        source: event.source,
        fatal: false,
      });
    }
  }

  #onSegment(session: Session, segment: SttSegment): void {
    if (this.#session !== session || session.originUs === undefined) return;
    const toMeeting = (ms: number) =>
      Math.max(0, Math.round(ms - session.originUs! / 1000 + session.offsetMs));
    const live: LiveSegment = {
      id: segment.id,
      source: segment.source,
      startMs: toMeeting(segment.startMs),
      endMs: toMeeting(segment.endMs),
      text: segment.text,
      isFinal: segment.isFinal,
    };
    this.#transcript.push(live);
    if (live.isFinal && this.#o.persistence) {
      try {
        this.#o.persistence.saveSegment(session.meetingId, live);
      } catch (error) {
        this.#o.log.error('recording: could not save a transcript segment', error);
        this.#issue({
          scope: 'archive',
          code: 'transcript_store_failed',
          message:
            'The transcript can’t be saved on this Mac right now. Recording continues; the live transcript is still shown.',
          source: null,
          fatal: false,
        });
      }
    }
  }

  #audioIssue(error: RecordingError): void {
    this.#o.log.warn(`recording: ${error.code}: ${error.message}`);
    this.#issue({
      scope: 'audio',
      code: error.code,
      message: audioMessage(error),
      source: error.source ?? null,
      fatal: error.fatal,
    });
  }

  #archiveIssue(error: ArchiveError): void {
    this.#o.log.error(`recording: archive ${error.code}`, error);
    const fatal = error.code !== 'archive_store_failed';
    this.#issue({
      scope: 'archive',
      code: error.code,
      message: error.source
        ? `${who(error.source)} audio can’t be saved to this Mac (${archiveReason(error)}). Live transcription continues, but this audio is not being kept.`
        : `The audio can’t be saved to this Mac (${archiveReason(error)}). Live transcription continues, but this audio is not being kept.`,
      source: error.source ?? null,
      fatal,
    });
  }

  #sttIssue(source: AudioSourceKind, error: SttError): void {
    this.#o.log.warn(`recording: stt ${source} ${error.code}: ${error.message}`);
    this.#issue({
      scope: 'stt',
      code: error.code,
      message: sttMessage(source, error, this.#session),
      source,
      fatal: error.fatal,
    });
  }

  #issue(issue: Omit<RecordingIssue, 'id' | 'at' | 'count'>): void {
    const at = this.#now();
    const i = this.#issues.findIndex(
      (x) =>
        x.scope === issue.scope &&
        x.code === issue.code &&
        x.source === issue.source &&
        x.message === issue.message,
    );
    if (i >= 0) {
      // A retry loop repeating itself: one entry, moved to the end, counted.
      const [same] = this.#issues.splice(i, 1);
      this.#issues.push({
        ...same!,
        at,
        count: same!.count + 1,
        fatal: same!.fatal || issue.fatal,
      });
    } else {
      this.#issues.push({ ...issue, id: ++this.#issueId, at, count: 1 });
      if (this.#issues.length > MAX_ISSUES)
        this.#issues.splice(0, this.#issues.length - MAX_ISSUES);
    }
    this.#changed(true);
  }

  /** Pushes a snapshot: now for status changes/issues, otherwise at most every `stateThrottleMs`. */
  #changed(now = false): void {
    const status = this.status;
    if (status !== this.#lastStatus) {
      this.#lastStatus = status;
      this.#o.onStatus?.(status, this.meetingId);
    }
    if (now) {
      if (this.#stateTimer) clearTimeout(this.#stateTimer);
      this.#stateTimer = undefined;
      this.#emit();
      return;
    }
    this.#stateTimer ??= setTimeout(() => {
      this.#stateTimer = undefined;
      this.#emit();
    }, this.#o.stateThrottleMs ?? 100);
  }

  #emit(): void {
    this.#seq += 1;
    this.#o.onState?.(this.snapshot());
  }
}

/**
 * Frames → one `SttStream` per source, through its own bounded queue on the controller (STT can never
 * hold up capture or the archive). Streams open on the first frame of their source, once the provider
 * is known.
 */
class SttPipe {
  readonly #streams = new Map<AudioSourceKind, SttStream>();
  readonly #provider: Promise<SttProvider | undefined>;
  readonly #subscription: FrameSubscription;
  readonly #handlers: SttPipeOptions;
  #closed = false;

  constructor(options: SttPipeOptions) {
    this.#handlers = options;
    this.#provider = options.provider;
    this.#subscription = options.controller.subscribe((frame) => this.#consume(frame), {
      name: 'stt',
      maxQueuedFrames: options.maxQueuedFrames,
    });
  }

  async #consume(frame: AudioFrame): Promise<void> {
    this.#handlers.onFrame(frame);
    const provider = await this.#provider;
    if (!provider || this.#closed) return;
    let stream = this.#streams.get(frame.source);
    if (!stream) {
      stream = provider.openStream({ source: frame.source, sampleRate: frame.sampleRate });
      const source = frame.source;
      this.#streams.set(source, stream);
      this.#handlers.onStatus(source, stream.status);
      stream.on('status', (status) => this.#handlers.onStatus(source, status));
      stream.on('segment', (segment) => this.#handlers.onSegment(segment));
      stream.on('error', (error) => this.#handlers.onError(source, error));
    }
    stream.write(frame);
  }

  /**
   * After the audio stopped: hand over every queued frame, then let connected streams deliver their last
   * finals (bounded by the provider's own finish timeout). Streams that are offline are closed at once;
   * their audio is in the archive (D-17: back-fill from there).
   */
  async finish(): Promise<void> {
    await this.#subscription.drained();
    this.#subscription.unsubscribe();
    this.#closed = true;
    await Promise.all(
      [...this.#streams.values()].map(async (stream) => {
        if (stream.status === 'open' || stream.status === 'connecting') await stream.finish();
        stream.close();
      }),
    );
  }
}

/** Stands in for a source that couldn't even be created: `start()` rejects with the reason. */
class UnavailableSource implements AudioSource {
  readonly sampleRate = 16_000;
  state: AudioSourceState = 'idle';
  readonly #error: Error;
  readonly #stopped: AudioEventOf<'stopped'> = {
    type: 'stopped',
    tUs: 0,
    reason: 'error',
    samples: { mic: 0, system: 0 },
  };

  constructor(error: unknown) {
    this.#error = error instanceof Error ? error : new Error(String(error));
  }

  start(): Promise<void> {
    this.state = 'stopped';
    return Promise.reject(this.#error);
  }
  stop(): Promise<void> {
    this.state = 'stopped';
    return Promise.resolve();
  }
  pause(): void {}
  resume(): void {}
  onFrame(): Unsubscribe {
    return () => {};
  }
  onEvent(): Unsubscribe {
    return () => {};
  }
  whenStopped(): Promise<AudioEventOf<'stopped'>> {
    return Promise.resolve(this.#stopped);
  }
}

interface SttPipeOptions {
  controller: RecordingController;
  provider: Promise<SttProvider | undefined>;
  maxQueuedFrames: number;
  onFrame: (frame: AudioFrame) => void;
  onSegment: (segment: SttSegment) => void;
  onStatus: (source: AudioSourceKind, status: SttStreamStatus) => void;
  onError: (source: AudioSourceKind, error: SttError) => void;
}

// --- user-facing messages (details stay in the log) ---------------------------------------------------

const who = (source: AudioSourceKind) => (source === 'mic' ? 'Your microphone' : 'Meeting');

function startFailureMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/not found|no such file|ENOENT|does not exist|could not find/i.test(text)) {
    return 'Recording couldn’t start: the audio helper is missing.';
  }
  return 'Recording couldn’t start. Check microphone and screen-recording permissions, then try again.';
}

function audioMessage(error: RecordingError): string {
  switch (error.code) {
    case 'start_failed':
      return startFailureMessage(error.cause ?? error.message);
    case 'unexpected_stop':
      return 'Recording stopped unexpectedly. What was recorded so far is saved.';
    case 'sidecar_exited':
      return error.fatal
        ? 'The audio helper stopped. What was recorded so far is saved.'
        : 'The audio helper restarted; a moment of audio may be missing.';
    case 'device_lost':
    case 'no_device':
      return `${error.source ? who(error.source) : 'An audio device'} is unavailable.`;
    case 'aec_unavailable':
      return 'Echo cancellation is off: use headphones so the other side isn’t transcribed as you.';
    case 'subscriber_error':
    case 'listener_error':
      return 'Something went wrong while processing audio; recording continues.';
    default:
      return error.fatal
        ? `Audio capture failed (${error.code}). What was recorded so far is saved.`
        : `Audio capture problem (${error.code}); recording continues.`;
  }
}

function archiveReason(error: ArchiveError): string {
  const cause = (error.cause as NodeJS.ErrnoException | undefined)?.code;
  if (cause === 'ENOSPC') return 'the disk is full';
  if (cause === 'EACCES' || cause === 'EPERM') return 'no permission';
  return error.code.replace(/^archive_/, '').replace(/_/g, ' ');
}

function sttMessage(
  source: AudioSourceKind,
  error: SttError,
  session: Session | undefined,
): string {
  const side = source === 'mic' ? 'your microphone' : 'the meeting audio';
  switch (error.code) {
    case 'auth':
      return `Transcription refused our credentials for ${side}. Recording continues; audio is saved on this Mac.`;
    case 'token':
      return `Can’t get transcription access for ${side} (offline or signed out?). Retrying; recording continues.`;
    case 'quota':
      return error.fatal
        ? `Transcription is out of quota. Recording continues; audio is saved on this Mac.`
        : `Transcription is busy; retrying ${side}.`;
    case 'connection':
    case 'stall':
      return error.fatal
        ? `Transcription for ${side} gave up. Recording continues; audio is saved on this Mac.`
        : `Transcription for ${side} is offline. Reconnecting; recording continues.`;
    case 'replay_overflow': {
      const at = (ms: number | undefined) =>
        ms === undefined || session?.originUs === undefined
          ? ''
          : formatClock(ms - session.originUs / 1000 + session.offsetMs);
      const range =
        error.lostFromMs !== undefined ? ` (${at(error.lostFromMs)}–${at(error.lostToMs)})` : '';
      return `Part of ${side} couldn’t be transcribed while offline${range}. The audio is saved.`;
    }
    case 'finish_timeout':
      return `The end of the transcript for ${side} may be missing.`;
    default:
      return error.fatal
        ? `Transcription for ${side} stopped (${error.code}). Recording continues.`
        : `Transcription problem for ${side} (${error.code}); recording continues.`;
  }
}
