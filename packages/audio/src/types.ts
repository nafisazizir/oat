/**
 * Audio model shared by every `AudioSource` (sidecar, file) and every consumer (STT, archive, meters).
 *
 * Mirrors the oat-audio sidecar wire protocol (`native/oat-audio/PROTOCOL.md`, protocol 1): two sources that
 * are never mixed, PCM signed 16-bit mono, one shared microsecond clock. Field names are camelCase here;
 * the sidecar parser (task 2.4) maps `t_us` → `tUs`, `sample_rate` → `sampleRate`, source `0`/`1` →
 * `'mic'`/`'system'`.
 */

/** `mic` = "me" (local microphone), `system` = "them" (everything the machine plays). */
export type AudioSourceKind = 'mic' | 'system';

export const AUDIO_SOURCES: readonly AudioSourceKind[] = ['mic', 'system'];

/** The rate every source emits and every consumer expects (protocol default, STT input rate). */
export const DEFAULT_SAMPLE_RATE = 16_000;

/**
 * One block of mono PCM from one source.
 *
 * Frames are immutable by contract and never reuse their buffer, so consumers may keep references (replay
 * ring buffer, archive writer) without copying. Do not mutate `pcm`; the same object goes to every listener.
 */
export interface AudioFrame {
  readonly source: AudioSourceKind;
  /**
   * Time of the frame's first sample in microseconds on the source's shared clock. Mic and system values are
   * directly comparable; per source they are strictly increasing. Not globally sorted across sources.
   * Consecutive frames are contiguous except across a gap: dropped audio (always announced by an `overrun`
   * event), pause/resume, or a device switch. Treat `overrun` as the authoritative dropped-audio signal.
   */
  readonly tUs: number;
  /** Signed 16-bit mono samples. Length is the frame size, except possibly the last frame before a gap. */
  readonly pcm: Int16Array;
  readonly sampleRate: number;
}

/** Why a source stopped. The first six mirror the sidecar's `stopped.reason`. */
export type AudioStopReason =
  | 'duration'
  | 'command'
  | 'stdin_eof'
  | 'signal'
  | 'error'
  | 'output_closed'
  /** FileSource reached the end of its input. */
  | 'end_of_input';

/**
 * Error codes the sidecar emits (PROTOCOL.md, protocol 1). `code` stays an open string because consumers
 * must treat unknown codes as generic errors.
 */
export const SIDECAR_ERROR_CODES = [
  'tap_create_failed',
  'tap_format',
  'aggregate_failed',
  'ioproc_failed',
  'device_start_failed',
  'no_device',
  'mic_start_failed',
  'device_lost',
  'start_failed',
  'convert_failed',
  'tap_buffer_invalid',
  'mic_buffer_invalid',
  'aec_unavailable',
  'invalid_command',
] as const;
/** Emitted by an `AudioSource` itself (never the sidecar) when one of its listeners threw; non-fatal. */
export const LISTENER_ERROR = 'listener_error';
export type KnownAudioErrorCode = (typeof SIDECAR_ERROR_CODES)[number] | typeof LISTENER_ERROR;

export type AudioEvent =
  | {
      readonly type: 'started';
      readonly tUs: number;
      readonly sampleRate: number;
      readonly frameMs: number;
      readonly sources: readonly AudioSourceKind[];
      /** Sidecar protocol number and tool version (absent for non-sidecar sources). */
      readonly protocol?: number;
      readonly version?: string;
      /** Sidecar `--synthetic` tone generator instead of real devices. */
      readonly synthetic?: boolean;
      /** Whether mic echo cancellation is active (D-17). Absent when not applicable. */
      readonly aec?: boolean;
    }
  | {
      readonly type: 'stopped';
      readonly tUs: number;
      readonly reason: AudioStopReason;
      /** Samples emitted per source over the whole session. */
      readonly samples: Readonly<Record<AudioSourceKind, number>>;
    }
  | { readonly type: 'paused'; readonly tUs: number }
  | { readonly type: 'resumed'; readonly tUs: number }
  | {
      readonly type: 'error';
      readonly tUs: number;
      /** Absent for session-level errors. */
      readonly source?: AudioSourceKind;
      /** See `SIDECAR_ERROR_CODES` / `LISTENER_ERROR`; treat unknown codes as generic errors. */
      readonly code: KnownAudioErrorCode | (string & {});
      readonly message: string;
      /** `true` = that source (or, without `source`, the session) has stopped. */
      readonly fatal: boolean;
    }
  | {
      readonly type: 'device_changed';
      readonly tUs: number;
      readonly source: AudioSourceKind;
      readonly device: string;
    }
  | {
      /** The same device changed its own format; capture continues and frames keep `sampleRate`. */
      readonly type: 'format_changed';
      readonly tUs: number;
      readonly source: AudioSourceKind;
      readonly deviceSampleRate: number;
      readonly previousDeviceSampleRate: number;
      readonly channels: number;
    }
  | {
      readonly type: 'level';
      readonly tUs: number;
      readonly source: AudioSourceKind;
      /** dBFS, −100 = silence. */
      readonly rmsDb: number;
      readonly peakDb: number;
    }
  | {
      /**
       * Audio of `source` was dropped because a consumer fell behind: a visible gap that STT replay (D-17) and
       * the archive (D-10) must not paper over. `tUs` = first dropped audio (`output`) or emission time
       * (`capture`). Per source, delivered samples + Σ `droppedSamples` = samples captured.
       */
      readonly type: 'overrun';
      readonly tUs: number;
      readonly source: AudioSourceKind;
      readonly stage: 'capture' | 'output';
      /** Exact, at `sampleRate`. */
      readonly droppedSamples: number;
      readonly droppedMs: number;
    };

export type AudioEventType = AudioEvent['type'];
export type AudioEventOf<T extends AudioEventType> = Extract<AudioEvent, { type: T }>;

/** Every event type, in PROTOCOL.md table order. Checked at compile time to cover `AudioEventType`. */
export const AUDIO_EVENT_TYPES = [
  'started',
  'stopped',
  'paused',
  'resumed',
  'error',
  'device_changed',
  'format_changed',
  'level',
  'overrun',
] as const satisfies readonly AudioEventType[];
type MissingEventTypes = Exclude<AudioEventType, (typeof AUDIO_EVENT_TYPES)[number]>;
/** Fails to compile if a member of the union is missing from `AUDIO_EVENT_TYPES`. */
export const AUDIO_EVENT_TYPES_COMPLETE: [MissingEventTypes] extends [never]
  ? true
  : MissingEventTypes = true;

export type AudioSourceState = 'idle' | 'running' | 'paused' | 'stopped';

export type Unsubscribe = () => void;

/**
 * A live or recorded pair of audio streams (mic + system).
 *
 * Delivery is push-based: `onFrame` / `onEvent` listeners are called synchronously, in registration order,
 * as soon as a frame exists. Any number of consumers can subscribe (STT stream per source, archive writer,
 * level meter) and none of them can slow the others or the producer down — live capture cannot wait, so
 * there is deliberately no backpressure. A consumer that needs async work queues the frame itself. Use
 * `framesOf()` for a pull-style async iterator over one subscription.
 *
 * A listener that throws never stops the session or starves other listeners: the error is reported (to the
 * console by default) and announced as a non-fatal `error` event with code `listener_error`.
 *
 * Lifecycle: `idle` → `start()` → `running` ⇄ `pause()`/`resume()` → `stopped` (via `stop()`, end of
 * input or a fatal error). `started` is always the first event and `stopped` always the last; nothing is
 * delivered after `stopped`. A stopped source cannot be restarted.
 */
export interface AudioSource {
  readonly state: AudioSourceState;
  /** Sample rate of every emitted frame. */
  readonly sampleRate: number;
  /** Resolves once the `started` event has been delivered; rejects if the source cannot start. */
  start(): Promise<void>;
  /** Graceful stop; resolves after the `stopped` event has been delivered. Idempotent. */
  stop(): Promise<void>;
  /**
   * No frames are delivered while paused. Takes effect at the next frame boundary (a listener that pauses
   * mid-delivery may still see the other source's frame for the same instant). No-op unless running.
   */
  pause(): void;
  /** No-op unless paused. */
  resume(): void;
  onFrame(listener: (frame: AudioFrame) => void): Unsubscribe;
  onEvent(listener: (event: AudioEvent) => void): Unsubscribe;
  /** Resolves with the `stopped` event, however the session ended. */
  whenStopped(): Promise<AudioEventOf<'stopped'>>;
}
