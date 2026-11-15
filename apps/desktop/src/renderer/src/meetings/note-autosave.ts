/**
 * Autosave of a meeting note on the desktop (3.4): edits are merged into one pending patch and written to
 * the local database `delayMs` after the last change (or at once on `flush`, e.g. when another note is
 * opened, the window goes away or the app quits). One write at a time; a failed write keeps the patch and
 * is retried by itself with backoff (1 s, 2 s, … 30 s), or sooner on the next change or `flush`.
 * Pure TS (no React, no DOM), unit-tested.
 */
export interface NotePatch {
  title?: string;
  contentJson?: { type: 'doc'; [key: string]: unknown };
}

export type AutosaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

/** The stored note the editor's state is built on (D-19: saves never overwrite a newer note). */
export interface NoteBase {
  title: string;
  contentJson: { type: 'doc'; [key: string]: unknown };
}

export interface NoteAutosaveOptions {
  /**
   * Writes `patch` on top of `base`; resolves with `conflict` when the stored note had moved on (the patch
   * was then kept elsewhere, not written over it).
   */
  save: (patch: NotePatch, base: NoteBase) => Promise<{ conflict?: unknown } | void>;
  /** What the editor was opened on. */
  base: NoteBase;
  onConflict?: (conflict: unknown) => void;
  delayMs?: number;
  onState?: (state: AutosaveState, error: string | null) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** First retry delay after a failed write (doubles up to `maxRetryMs`). Default 1 s. */
  retryMs?: number;
  maxRetryMs?: number;
}

const normalizeTitle = (title: string) => title.replace(/\s+/g, ' ').trim();

export class NoteAutosave {
  readonly #o: Required<Omit<NoteAutosaveOptions, 'onState' | 'onConflict'>> &
    Pick<NoteAutosaveOptions, 'onState' | 'onConflict'>;
  /** `null` after a conflict: the next stored version is adopted, whatever it holds. */
  #base: NoteBase | null;
  #pending: NotePatch | null = null;
  #timer: unknown = null;
  #writing: Promise<void> | null = null;
  #state: AutosaveState = 'idle';
  #failures = 0;
  #disposed = false;

  constructor(options: NoteAutosaveOptions) {
    this.#o = {
      delayMs: 400,
      retryMs: 1_000,
      maxRetryMs: 30_000,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      ...options,
    };
    this.#base = options.base;
  }

  /** The stored note my edits build on (`null`: adopt the next one). */
  get base(): NoteBase | null {
    return this.#base;
  }

  /** A newer stored note was adopted by the editor (a reload while nothing was pending). */
  rebase(base: NoteBase): void {
    this.#base = base;
  }

  get state(): AutosaveState {
    return this.#state;
  }

  /** Unsaved edits exist (queued or being written). */
  get dirty(): boolean {
    return this.#pending !== null || this.#writing !== null;
  }

  #set(state: AutosaveState, error: string | null = null) {
    this.#state = state;
    this.#o.onState?.(state, error);
  }

  queue(patch: NotePatch): void {
    this.#pending = { ...this.#pending, ...patch };
    this.#set('pending');
    this.#schedule(this.#o.delayMs);
  }

  #schedule(ms: number) {
    if (this.#timer !== null) this.#o.clearTimer(this.#timer);
    this.#timer = this.#o.setTimer(() => {
      this.#timer = null;
      void this.flush();
    }, ms);
  }

  /** Writes what is pending now; resolves when everything queued so far is written (or failed). */
  async flush(): Promise<void> {
    if (this.#timer !== null) {
      this.#o.clearTimer(this.#timer);
      this.#timer = null;
    }
    while (this.#writing) await this.#writing;
    const patch = this.#pending;
    if (!patch) return;
    this.#pending = null;
    this.#set('saving');
    this.#writing = (async () => {
      try {
        const sent = this.#base ?? this.#o.base;
        const result = await this.#o.save(patch, sent);
        this.#failures = 0;
        if (result && result.conflict) {
          this.#base = null;
          this.#o.onConflict?.(result.conflict);
        } else {
          this.#base = {
            title: patch.title === undefined ? sent.title : normalizeTitle(patch.title),
            contentJson: patch.contentJson ?? sent.contentJson,
          };
        }
        if (!this.#pending) this.#set('saved');
      } catch (error) {
        // Keep it (newer edits win per field) and try again by itself, backing off.
        this.#pending = { ...patch, ...this.#pending };
        this.#failures++;
        this.#set('error', error instanceof Error ? error.message : 'Couldn’t save.');
        if (!this.#disposed) {
          this.#schedule(Math.min(this.#o.maxRetryMs, this.#o.retryMs * 2 ** (this.#failures - 1)));
        }
      } finally {
        this.#writing = null;
      }
    })();
    await this.#writing;
  }

  /** Stops timers (a final `flush()` can still run). */
  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== null) this.#o.clearTimer(this.#timer);
    this.#timer = null;
  }
}
