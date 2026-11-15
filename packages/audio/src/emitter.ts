import type { AudioFrame, AudioSource, AudioSourceKind, Unsubscribe } from './types.ts';

/**
 * Minimal synchronous fan-out used by `AudioSource` implementations. No Node `EventEmitter` so it also runs
 * in a renderer/worker.
 *
 * A throwing listener does not stop delivery to the others and never escapes as an uncaught error (which
 * would kill an Electron main process mid-recording): it goes to `onError` (default `console.error`). If
 * `onError` itself throws, that is logged too and delivery continues.
 */
export type ListenerErrorHandler<T> = (error: unknown, value: T) => void;

export function logListenerError(error: unknown): void {
  console.error('[@oat/audio] listener threw:', error);
}

export class Fanout<T> {
  readonly #listeners = new Set<(value: T) => void>();
  readonly #onError: ListenerErrorHandler<T>;

  constructor(onError: ListenerErrorHandler<T> = logListenerError) {
    this.#onError = onError;
  }

  get size(): number {
    return this.#listeners.size;
  }

  add(listener: (value: T) => void): Unsubscribe {
    // Wrap so the same function can subscribe twice and unsubscribe independently.
    const entry = (value: T) => listener(value);
    this.#listeners.add(entry);
    return () => {
      this.#listeners.delete(entry);
    };
  }

  emit(value: T): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(value);
      } catch (error) {
        try {
          this.#onError(error, value);
        } catch (handlerError) {
          logListenerError(handlerError);
        }
      }
    }
  }

  clear(): void {
    this.#listeners.clear();
  }
}

export interface FramesOfOptions {
  /** Only yield frames from these sources (default: all). */
  sources?: readonly AudioSourceKind[];
}

/**
 * Pull-style view of one subscription: an async iterator that yields every frame (buffered without bound,
 * so a slow reader never blocks the source or other consumers) and finishes after the `stopped` event.
 * Subscribe before `start()` to see every frame. Breaking out of `for await` unsubscribes.
 */
export function framesOf(
  source: AudioSource,
  options: FramesOfOptions = {},
): AsyncIterableIterator<AudioFrame> {
  const wanted = options.sources ? new Set(options.sources) : undefined;
  const queue: AudioFrame[] = [];
  let head = 0;
  let done = false;
  let wake: (() => void) | undefined;

  const notify = () => {
    const w = wake;
    wake = undefined;
    w?.();
  };
  const offFrame = source.onFrame((frame) => {
    if (wanted && !wanted.has(frame.source)) return;
    queue.push(frame);
    notify();
  });
  const offEvent = source.onEvent((event) => {
    if (event.type === 'stopped') finish();
  });
  if (source.state === 'stopped') finish();

  function finish() {
    done = true;
    offFrame();
    offEvent();
    notify();
  }

  const iterator: AsyncIterableIterator<AudioFrame> = {
    async next(): Promise<IteratorResult<AudioFrame>> {
      for (;;) {
        if (head < queue.length) {
          const value = queue[head] as AudioFrame;
          queue[head++] = undefined as unknown as AudioFrame; // release for GC
          if (head > 1024 && head * 2 > queue.length) {
            queue.splice(0, head);
            head = 0;
          }
          return { value, done: false };
        }
        if (done) return { value: undefined, done: true };
        await new Promise<void>((resolve) => (wake = resolve));
      }
    },
    async return(): Promise<IteratorResult<AudioFrame>> {
      finish();
      queue.length = 0;
      head = 0;
      return { value: undefined, done: true };
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
  return iterator;
}
