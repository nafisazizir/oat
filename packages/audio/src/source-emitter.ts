import { Fanout, logListenerError } from './emitter.ts';
import {
  LISTENER_ERROR,
  type AudioEvent,
  type AudioEventOf,
  type AudioFrame,
  type AudioSourceKind,
  type Unsubscribe,
} from './types.ts';

/** At most one `listener_error` event per this interval; the next one says how many were suppressed. */
const LISTENER_ERROR_EVENT_INTERVAL_MS = 1000;

export interface SourceEmitterOptions {
  /** Called with every error thrown by a listener. Default `console.error`. */
  onListenerError?: (error: unknown) => void;
  /** Current position on the source's clock, for `listener_error` announcements. */
  clockUs: () => number;
  /** Once true, nothing is announced any more (nothing may follow `stopped`). */
  isStopped: () => boolean;
}

/**
 * Listener bookkeeping shared by `AudioSource` implementations (FileSource, SidecarSource): frame/event
 * fan-out, and the listener-error contract — a throwing listener is reported (`onListenerError`) and
 * announced as a non-fatal `error` event (`listener_error`, throttled to one per second) once the current
 * delivery has reached every listener, so ordering guarantees hold (`started` is still the first event
 * every listener sees). Delivery and the session carry on.
 */
export class SourceEmitter {
  readonly #options: SourceEmitterOptions;
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

  constructor(options: SourceEmitterOptions) {
    this.#options = options;
  }

  onFrame(listener: (frame: AudioFrame) => void): Unsubscribe {
    return this.#frames.add(listener);
  }

  onEvent(listener: (event: AudioEvent) => void): Unsubscribe {
    return this.#events.add(listener);
  }

  emitFrame(frame: AudioFrame): void {
    this.#deliver(() => this.#frames.emit(frame));
  }

  emitEvent(event: AudioEvent): void {
    this.#deliver(() => this.#events.emit(event));
  }

  /** Drop every listener (after `stopped`). */
  clear(): void {
    this.#frames.clear();
    this.#events.clear();
  }

  #listenerFailed(
    error: unknown,
    what: string,
    source: AudioSourceKind | undefined,
    whileReportingListenerError = false,
  ): void {
    (this.#options.onListenerError ?? logListenerError)(error);
    // Never announce after `stopped`, and never recurse when a listener throws on the announcement itself.
    if (this.#options.isStopped() || whileReportingListenerError) return;
    const t = performance.now();
    if (t - this.#lastListenerErrorEventAt < LISTENER_ERROR_EVENT_INTERVAL_MS) {
      this.#suppressedListenerErrors++;
      return;
    }
    const suppressed = this.#suppressedListenerErrors;
    this.#lastListenerErrorEventAt = t;
    this.#suppressedListenerErrors = 0;
    const detail = error instanceof Error ? error.message : String(error);
    this.#pendingAnnouncement = {
      type: 'error',
      tUs: this.#options.clockUs(),
      ...(source ? { source } : {}),
      code: LISTENER_ERROR,
      message:
        `${what} threw: ${detail}` +
        (suppressed > 0 ? ` (${suppressed} earlier listener errors not announced)` : ''),
      fatal: false,
    };
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
      if (!this.#options.isStopped()) this.emitEvent(announcement);
    }
  }
}
