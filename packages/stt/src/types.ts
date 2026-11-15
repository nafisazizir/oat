import type { AudioFrame, AudioSourceKind, Unsubscribe } from '@oat/audio';

/**
 * Live speech-to-text behind one interface (SPEC §3.3/§5, D-17): one stream per audio source, never mixed,
 * segments tagged by source and timed on the **recording clock** (the `tUs` of the frames written), not the
 * provider socket's clock, so reconnects and replays never shift timestamps.
 */
export type SttSource = AudioSourceKind;

export interface SttWord {
  /** Normalised word (lower case, no punctuation) as the provider returns it. */
  word: string;
  /** With punctuation/casing when the provider formats (smart formatting). */
  punctuatedWord?: string;
  startMs: number;
  endMs: number;
  confidence?: number;
}

/**
 * A piece of transcript, identified by `id` (D-19: stable row id). Interims are provisional and share the
 * id of the final that eventually replaces them; consumers upsert by id. A stream has at most one open
 * interim at a time; its id is reused until a final with that id arrives, then the next segment gets a
 * new id. Finals are immutable, in time order, and never overlap within a stream.
 *
 * **Retraction:** a final with `text: ''` (and no words) means the interim with that id turned out to be
 * nothing (empty final, or audio already transcribed before a reconnect): delete it, store nothing. Every
 * interim is closed by a final or a retraction before `finish()` resolves.
 */
export interface SttSegment {
  /** UUIDv7, unique per utterance chunk; shared by its interims and its final. */
  id: string;
  source: SttSource;
  /** Recording-clock ms (frame `tUs / 1000`). */
  startMs: number;
  endMs: number;
  /** `''` only on a retraction (see above). */
  text: string;
  isFinal: boolean;
  /** The provider detected the end of an utterance after this final (Deepgram `speech_final`). */
  speechFinal?: boolean;
  words?: SttWord[];
  confidence?: number;
}

/** A segment before the stream assigned its id (what provider adapters produce). */
export type SttSegmentData = Omit<SttSegment, 'id'>;

/**
 * `connecting` (first attempt) → `open` ⇄ `reconnecting` → `closed` (after `finish()`/`close()`) or
 * `error` (fatal: gave up, e.g. auth rejected). `closed` and `error` are terminal.
 */
export type SttStatus = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error';

export type SttErrorCode =
  /** Provider rejected the credentials (HTTP 401/403 on the handshake). */
  | 'auth'
  /** `getToken()` failed. */
  | 'token'
  /** Provider rejected the request parameters (HTTP 400). */
  | 'bad_request'
  /** Account out of credit (HTTP 402, fatal) or rate limited (HTTP 429, retried a few times). */
  | 'quota'
  /** Connection failed or dropped; the stream reconnects unless `fatal`. */
  | 'connection'
  /** No message from the provider for too long while audio was flowing; the stream reconnects. */
  | 'stall'
  /** The provider sent something we could not understand, or an error message. */
  | 'protocol'
  /** Audio older than the replay buffer was lost while disconnected (D-17: back-fill from the archive). */
  | 'replay_overflow'
  /** `finish()` gave up waiting for the provider's last results. */
  | 'finish_timeout';

export interface SttError {
  code: SttErrorCode;
  message: string;
  /** `true` = the stream has stopped (status `error`). Non-fatal errors are informational. */
  fatal: boolean;
  /** HTTP status of a rejected handshake, close code of a dropped socket, … */
  status?: number;
  /** `replay_overflow`: the recording-clock range that was not transcribed. */
  lostFromMs?: number;
  lostToMs?: number;
}

export interface SttStreamEvents {
  segment: SttSegment;
  status: SttStatus;
  error: SttError;
}

export interface SttStreamOptions {
  source: SttSource;
  /** Sample rate of every frame written (16 kHz from `@oat/audio`). */
  sampleRate: number;
  /** BCP-47 tag, e.g. `en`, `en-US`, or `multi`. Provider default when absent. */
  language?: string;
  /** Vocabulary to boost (names, jargon). */
  keyterms?: readonly string[];
}

export interface SttStream {
  readonly source: SttSource;
  readonly status: SttStatus;
  /**
   * Feed one frame of this stream's source (throws on a different source or sample rate). Never blocks:
   * frames are buffered while (re)connecting. Ignored after `finish()`/`close()` or a fatal error.
   */
  write(frame: AudioFrame): void;
  /**
   * Graceful end: tells the provider no more audio comes, waits for the last finals (every interim is
   * superseded by then), then `closed`. Idempotent; resolves (never rejects) — failures arrive as `error`.
   */
  finish(): Promise<void>;
  /** Immediate stop without waiting for results; no events after `closed`. Idempotent. */
  close(): void;
  /** Listeners are called synchronously; a throwing listener is logged and does not affect others. */
  on<K extends keyof SttStreamEvents>(
    event: K,
    listener: (value: SttStreamEvents[K]) => void,
  ): Unsubscribe;
}

export interface SttProvider {
  readonly name: string;
  /** Opens one stream (per D-17, one per source). Connects in the background; status starts `connecting`. */
  openStream(options: SttStreamOptions): SttStream;
}
