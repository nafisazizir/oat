/**
 * Before the app quits, the main window writes note edits still waiting in its autosave debounce (3.4 review:
 * Cmd-Q right after typing must not drop the last keystrokes). Main asks with `notes:flush {id}`; the window
 * answers `notes:flushed {id}` once its saves are written. Quit waits for the answer, at most `timeoutMs`
 * (1 s): a hung or missing window never keeps the app from quitting. Electron-free, unit-tested.
 */
export interface NotesFlushOptions {
  /** Sends `notes:flush` to the window that edits notes; `false` when there is none. */
  send: (id: number) => boolean;
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export type FlushOutcome = 'flushed' | 'timeout' | 'no-window';

export class NotesFlush {
  readonly #o: NotesFlushOptions;
  #seq = 0;
  readonly #waiting = new Map<number, (outcome: FlushOutcome) => void>();

  constructor(options: NotesFlushOptions) {
    this.#o = options;
  }

  request(): Promise<FlushOutcome> {
    const id = ++this.#seq;
    return new Promise<FlushOutcome>((resolve) => {
      const setTimer = this.#o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
      const clearTimer =
        this.#o.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
      const timer = setTimer(() => finish('timeout'), this.#o.timeoutMs ?? 1_000);
      const finish = (outcome: FlushOutcome) => {
        if (!this.#waiting.delete(id)) return;
        clearTimer(timer);
        resolve(outcome);
      };
      this.#waiting.set(id, finish);
      if (!this.#o.send(id)) finish('no-window');
    });
  }

  /** The window's answer (`notes:flushed`); unknown or late ids are ignored. */
  ack(id: number): void {
    this.#waiting.get(id)?.('flushed');
  }
}
