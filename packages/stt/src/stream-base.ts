import { Fanout, type AudioFrame, type Unsubscribe } from '@oat/audio';

import { uuidv7 } from './ids.ts';
import type {
  SttError,
  SttSegment,
  SttSegmentData,
  SttSource,
  SttStatus,
  SttStream,
  SttStreamEvents,
  SttStreamOptions,
} from './types.ts';

function logListenerError(error: unknown): void {
  console.error('[@oat/stt] listener threw:', error);
}

/** Event plumbing and status bookkeeping shared by every `SttStream` implementation. */
export abstract class BaseSttStream implements SttStream {
  readonly source: SttSource;
  readonly sampleRate: number;
  readonly #fanouts: { [K in keyof SttStreamEvents]: Fanout<SttStreamEvents[K]> } = {
    segment: new Fanout<SttSegment>(logListenerError),
    status: new Fanout<SttStatus>(logListenerError),
    error: new Fanout<SttError>(logListenerError),
  };
  #status: SttStatus = 'connecting';

  constructor(options: SttStreamOptions) {
    if (!(options.sampleRate > 0)) throw new RangeError('sampleRate must be positive');
    this.source = options.source;
    this.sampleRate = options.sampleRate;
  }

  get status(): SttStatus {
    return this.#status;
  }

  /** `closed` or `error`: nothing more happens. */
  get terminated(): boolean {
    return this.#status === 'closed' || this.#status === 'error';
  }

  on<K extends keyof SttStreamEvents>(
    event: K,
    listener: (value: SttStreamEvents[K]) => void,
  ): Unsubscribe {
    return this.#fanouts[event].add(listener);
  }

  abstract write(frame: AudioFrame): void;
  abstract finish(): Promise<void>;
  abstract close(): void;

  protected checkFrame(frame: AudioFrame): void {
    if (frame.source !== this.source) {
      throw new Error(`frame from "${frame.source}" written to the "${this.source}" stream`);
    }
    if (frame.sampleRate !== this.sampleRate) {
      throw new Error(`frame sample rate ${frame.sampleRate} ≠ stream rate ${this.sampleRate}`);
    }
  }

  protected setStatus(status: SttStatus): void {
    if (this.terminated || status === this.#status) return;
    this.#status = status;
    this.#fanouts.status.emit(status);
    if (this.terminated) {
      this.#fanouts.segment.clear();
      this.#fanouts.status.clear();
      this.#fanouts.error.clear();
    }
  }

  /** The interim currently on screen (its id is reused by the final that closes it). */
  #openInterim: SttSegment | undefined;

  /** `true` while an interim has been emitted and no final/retraction has closed it yet. */
  get hasOpenInterim(): boolean {
    return this.#openInterim !== undefined;
  }

  /**
   * Emits a segment, assigning its id: interims share one id until a final (same id) closes them; the next
   * interim/final starts a new id. Implementations never set `id` themselves.
   */
  protected emitSegment(segment: SttSegmentData): void {
    if (this.terminated) return;
    const out: SttSegment = { id: this.#openInterim?.id ?? uuidv7(), ...segment };
    this.#openInterim = out.isFinal ? undefined : out;
    this.#fanouts.segment.emit(out);
  }

  /**
   * A final produced nothing (empty transcript, or all of it was already emitted before a reconnect) while
   * an interim is open: emit the retraction — a final with the interim's id and `text: ''` — so consumers
   * drop the stale interim. No-op without an open interim.
   */
  protected retractInterim(): void {
    const open = this.#openInterim;
    if (!open || this.terminated) return;
    this.#openInterim = undefined;
    const { words: _words, confidence: _confidence, ...rest } = open;
    this.#fanouts.segment.emit({ ...rest, text: '', isFinal: true, speechFinal: false });
  }

  /** A fatal error also moves the stream to `error`. */
  protected emitError(error: SttError): void {
    if (this.terminated) return;
    this.#fanouts.error.emit(error);
    if (error.fatal) this.setStatus('error');
  }
}
