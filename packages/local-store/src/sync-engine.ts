/**
 * The sync loop (D-19), transport-agnostic so it runs against the real API in the desktop app and in the
 * web app's integration tests, and against fakes in unit tests.
 *
 * One run = push the outbox in batches until it is empty, then pull pages until the server has nothing
 * more. Runs never overlap; a `kick()` (local write) during a run schedules another one after it.
 * Triggers: `start()`, `kick()` (debounced), `syncNow()`, and an interval backstop. Failures back off
 * exponentially with jitter (network/5xx/429 → `offline`/`error`, retried; 401 → `stopped` until started
 * again). A 409 on pull (stale cursor) restarts the pull from the beginning. Every request is idempotent
 * on the server, so a lost response is simply retried.
 */
import {
  MAX_PUSH_ENTRIES,
  type SyncPullResponse,
  type SyncPushEntry,
  type SyncPushRequest,
  type SyncPushResponse,
} from '@oat/core';

import type { LocalStore } from './store.ts';

export interface SyncTransport {
  push(request: SyncPushRequest): Promise<SyncPushResponse>;
  pull(cursor: string | null): Promise<SyncPullResponse>;
}

/** A failed request. `status` 0 = the server couldn't be reached. */
export class SyncTransportError extends Error {
  override name = 'SyncTransportError';
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error' | 'stopped';

export interface SyncStatus {
  state: SyncState;
  /** Local changes not yet acknowledged by the server (not counting parked ones). */
  pending: number;
  /** Changes that can't be sent as they are (rejected, or breaking a push): kept, retried later (D-28). */
  parked: number;
  /** Wall clock (Unix ms) of the last complete run. */
  lastSyncedAt: number | null;
  /** User-facing reason for `offline` / `error` / `stopped`. */
  error: string | null;
}

export interface SyncEngineOptions {
  store: LocalStore;
  transport: SyncTransport;
  onStatus?: (status: SyncStatus) => void;
  /** A 401: the session is gone. The engine stops; the app signs out. */
  onUnauthorized?: () => void;
  log?: { info(message: string): void; warn(message: string): void };
  now?: () => number;
  /** Returns a cancel function. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  random?: () => number;
  /** Delay after a local write before pushing (coalesces bursts). Default 500 ms. */
  debounceMs?: number;
  /** Backstop interval between runs while idle. Default 30 s. */
  intervalMs?: number;
  /** First retry delay; doubles per failure up to `maxBackoffMs`. Defaults 1 s / 60 s. */
  backoffMs?: number;
  maxBackoffMs?: number;
  pushBatchSize?: number;
  /** Rough cap on a push's JSON size (the server takes 4 MB). Default 1 MB. */
  pushBatchBytes?: number;
  /** Consecutive 5xx on a push before it is split to find a bad entry. Default 3. */
  serverErrorsBeforeSplit?: number;
  /** Parked entries are retried after this long. Default 15 min. */
  parkedRetryMs?: number;
  /** Safety cap per run (a run never loops forever). */
  maxPushBatches?: number;
  maxPullPages?: number;
}

const defaultTimer = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  (t as { unref?: () => void }).unref?.();
  return () => clearTimeout(t);
};

export class SyncEngine {
  readonly #o: SyncEngineOptions;
  readonly #setTimer: (fn: () => void, ms: number) => () => void;
  readonly #now: () => number;
  #status: SyncStatus;
  #started = false;
  #running: Promise<void> | null = null;
  #again = false;
  #failures = 0;
  #cancelTimer: (() => void) | null = null;
  #timerDue = Infinity;
  #serverErrors = 0;

  constructor(options: SyncEngineOptions) {
    this.#o = options;
    this.#setTimer = options.setTimer ?? defaultTimer;
    this.#now = options.now ?? Date.now;
    this.#status = {
      state: 'stopped',
      pending: options.store.outboxSize(),
      parked: options.store.parkedCount(),
      lastSyncedAt: null,
      error: null,
    };
  }

  get status(): SyncStatus {
    return this.#status;
  }

  get started(): boolean {
    return this.#started;
  }

  /** Starts syncing now (and keeps going: kicks, interval, retries). */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#failures = 0;
    this.#set({ state: 'idle', error: null });
    this.#schedule(0);
  }

  /** Stops scheduling runs (a run in flight finishes). */
  stop(state: SyncState = 'stopped', error: string | null = null): void {
    this.#started = false;
    this.#clearTimer();
    this.#set({ state, error });
  }

  /** A local write happened: refresh the pending count and push soon (not sooner than a pending retry). */
  kick(): void {
    this.#set({ pending: this.#o.store.outboxSize(), parked: this.#o.store.parkedCount() });
    if (!this.#started) return;
    if (this.#running) {
      this.#again = true;
      return;
    }
    if (this.#failures > 0) return; // backing off: the scheduled retry will carry it
    this.#schedule(this.#o.debounceMs ?? 500);
  }

  /** Runs now (resetting any backoff) and resolves with the status after it. */
  async syncNow(): Promise<SyncStatus> {
    if (!this.#started) return this.#status;
    this.#failures = 0;
    if (this.#running) {
      this.#again = true;
      await this.#running;
    }
    if (this.#running)
      await this.#running; // the follow-up run the kick asked for
    else await this.#run();
    return this.#status;
  }

  /** Resolves when no run is in flight. */
  async idle(): Promise<void> {
    while (this.#running) await this.#running;
  }

  #set(patch: Partial<SyncStatus>): void {
    const next = { ...this.#status, ...patch };
    if (
      next.state === this.#status.state &&
      next.pending === this.#status.pending &&
      next.parked === this.#status.parked &&
      next.lastSyncedAt === this.#status.lastSyncedAt &&
      next.error === this.#status.error
    ) {
      return;
    }
    this.#status = next;
    this.#o.onStatus?.(next);
  }

  #clearTimer(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    this.#timerDue = Infinity;
  }

  /** Schedules a run in `ms` unless one is already due sooner. */
  #schedule(ms: number): void {
    if (!this.#started) return;
    const due = this.#now() + ms;
    if (this.#cancelTimer && this.#timerDue <= due) return;
    this.#clearTimer();
    this.#timerDue = due;
    this.#cancelTimer = this.#setTimer(() => {
      this.#cancelTimer = null;
      this.#timerDue = Infinity;
      void this.#run();
    }, ms);
  }

  #run(): Promise<void> {
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#clearTimer();
    this.#again = false;
    this.#running = this.#runOnce().finally(() => {
      this.#running = null;
      if (!this.#started) return;
      if (this.#again && this.#failures === 0) this.#schedule(0);
    });
    return this.#running;
  }

  async #runOnce(): Promise<void> {
    if (!this.#started) return;
    const { store, transport } = this.#o;
    this.#set({ state: 'syncing' });
    let phase: 'push' | 'pull' = 'push';
    try {
      // Parked entries get another chance now and then (D-28).
      store.unparkOlderThan(this.#now() - (this.#o.parkedRetryMs ?? 15 * 60_000));
      const size = Math.min(this.#o.pushBatchSize ?? MAX_PUSH_ENTRIES, MAX_PUSH_ENTRIES);
      const bytes = this.#o.pushBatchBytes ?? 1_000_000;
      for (let i = 0; i < (this.#o.maxPushBatches ?? 100); i++) {
        const entries = store.takePushBatch(size, bytes);
        if (entries.length === 0) break;
        await this.#pushBatch(entries);
        this.#set({ pending: store.outboxSize(), parked: store.parkedCount() });
      }
      phase = 'pull';
      let cursor = store.pullCursor();
      for (let page = 0; page < (this.#o.maxPullPages ?? 100); page++) {
        const response = await transport.pull(cursor);
        const { restart } = store.applyPull(response, cursor);
        if (restart) {
          this.#o.log?.info('sync: joined a workspace; pulling from the beginning');
          cursor = null;
          continue;
        }
        cursor = response.cursor;
        if (!response.hasMore) break;
      }
      this.#failures = 0;
      this.#set({
        state: 'idle',
        error: null,
        pending: store.outboxSize(),
        parked: store.parkedCount(),
        lastSyncedAt: this.#now(),
      });
      // Something was written while we pushed: go again right away, otherwise the interval backstop.
      if (store.outboxSize() > 0) this.#again = true;
      this.#schedule(this.#o.intervalMs ?? 30_000);
    } catch (error) {
      this.#failed(error, phase);
    }
  }

  /**
   * Pushes one batch. A request the server refuses because of what is in it (400, 413), or that fails
   * with 5xx `serverErrorsBeforeSplit` times in a row, is split in halves (in order, so parents still go
   * before children) until the entry that breaks it is alone; that entry is parked and the rest goes
   * through (D-28: one bad entry never blocks the queue). With 5xx, entries are parked only if another
   * part of the batch went through — otherwise it is an outage: the run fails (backoff), nothing parked.
   */
  async #pushBatch(entries: SyncPushEntry[]): Promise<void> {
    try {
      await this.#send(entries);
      this.#serverErrors = 0;
      return;
    } catch (error) {
      const status = error instanceof SyncTransportError ? error.status : -1;
      const content = status === 400 || status === 413;
      if (status >= 500) this.#serverErrors += 1;
      const split =
        content || (status >= 500 && this.#serverErrors >= (this.#o.serverErrorsBeforeSplit ?? 3));
      if (!split) throw error;
      this.#o.log?.warn(
        `sync: push of ${entries.length} failed with ${status}; isolating the cause`,
      );
      const state = { progress: false, suspects: [] as [SyncPushEntry, number][] };
      await this.#isolate(entries, state, status);
      if (state.suspects.length > 0 && !state.progress) throw error; // nothing went through: outage
      for (const [e, code] of state.suspects) {
        const id = e.op === 'delete' ? e.id : e.row.id;
        this.#o.store.park([e.version], `${e.table} ${id}: the server refused it (HTTP ${code})`);
      }
      this.#serverErrors = 0;
    }
  }

  /** Depth-first halving; entries that fail alone become suspects (parked by the caller). */
  async #isolate(
    entries: SyncPushEntry[],
    state: { progress: boolean; suspects: [SyncPushEntry, number][] },
    status: number,
  ): Promise<void> {
    if (entries.length === 1) {
      state.suspects.push([entries[0]!, status]);
      return;
    }
    const mid = Math.ceil(entries.length / 2);
    for (const half of [entries.slice(0, mid), entries.slice(mid)]) {
      try {
        await this.#send(half);
        state.progress = true;
      } catch (error) {
        const code = error instanceof SyncTransportError ? error.status : -1;
        if (code === 400 || code === 413 || code >= 500) await this.#isolate(half, state, code);
        else throw error; // offline, 401…: stop here, nothing parked
      }
    }
  }

  async #send(entries: SyncPushEntry[]): Promise<void> {
    const { store, transport } = this.#o;
    const response = await transport.push({ entries });
    const outcome = store.applyPushResults(entries, response.results);
    if (outcome.conflicts || outcome.rejected) {
      this.#o.log?.warn(
        `sync: push had ${outcome.conflicts} conflict(s), ${outcome.rejected} rejected (parked)`,
      );
    }
    if (outcome.acknowledged + outcome.conflicts + outcome.rejected === 0) {
      throw new SyncTransportError(502, 'The server acknowledged nothing.');
    }
  }

  #failed(error: unknown, phase: 'push' | 'pull'): void {
    const status = error instanceof SyncTransportError ? error.status : -1;
    const pending = this.#o.store.outboxSize();
    const parked = this.#o.store.parkedCount();
    if (status === 401) {
      this.stop('stopped', 'Signed out.');
      this.#set({ pending, parked });
      this.#o.onUnauthorized?.();
      return;
    }
    if (status === 409 && phase === 'pull') {
      // Stale pull cursor: start the pull over (counts as a failure so a server bug can't spin us).
      this.#o.store.resetPullCursor();
    }
    this.#failures += 1;
    const base = this.#o.backoffMs ?? 1_000;
    const max = this.#o.maxBackoffMs ?? 60_000;
    const delay = Math.min(max, base * 2 ** (this.#failures - 1));
    const jittered = Math.round(delay * (0.75 + 0.5 * (this.#o.random ?? Math.random)()));
    const offline = status === 0;
    const message = offline
      ? 'Offline — changes are saved on this Mac and will sync when the connection is back.'
      : 'Sync failed; retrying.';
    this.#o.log?.warn(
      `sync: ${error instanceof Error ? error.message : String(error)} (retry in ${jittered} ms)`,
    );
    this.#set({ state: offline ? 'offline' : 'error', error: message, pending, parked });
    this.#again = false;
    this.#schedule(jittered);
  }
}
