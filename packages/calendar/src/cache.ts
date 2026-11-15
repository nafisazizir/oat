import {
  compareCalendarEvents,
  currentMeetingFor,
  startingSoon,
  upcoming,
  type CalendarAccess,
  type CalendarEvent,
  type UpcomingOptions,
} from '@oat/core';

import type { CalendarSource, CalendarWatch, Unsubscribe } from './types.ts';

export interface CalendarCacheOptions {
  /** Clock (tests). Default `() => new Date()`. */
  now?: () => Date;
  /** Window kept in the cache, relative to now: from `now - pastMs` … Default 24 h. */
  pastMs?: number;
  /** … to `now + futureMs`. Default 14 days. */
  futureMs?: number;
  /**
   * Safety-net refresh even without change notifications; also slides the window forward and re-checks
   * access. Default 10 min; 0 disables.
   */
  refreshIntervalMs?: number;
  /** First delay before re-watching after the watch died; doubles up to `maxRewatchDelayMs`. Default 5 s. */
  rewatchDelayMs?: number;
  /** Default 5 min. */
  maxRewatchDelayMs?: number;
}

const HOUR = 3_600_000;
/** A watch alive this long resets the re-watch backoff. */
const STABLE_WATCH_MS = 60_000;

/**
 * Keeps the events of a `CalendarSource` for the window around now (default −24 h … +14 d, like the EventKit
 * reference behaviour) and tells listeners when they change.
 *
 * - **Change-driven:** after `start()` it watches the source; each change notification triggers a refresh.
 *   A periodic refresh (default 10 min) slides the window and covers missed notifications.
 * - **Coalesced:** refreshes never overlap; requests made while one runs collapse into a single follow-up.
 * - **Quiet:** `onChange` fires only when the event list actually differs; `onAccess` when access changes.
 * - **No access:** events are cleared, no watch runs; the periodic refresh keeps re-checking `status()` (which
 *   never prompts), so a later grant is picked up — or call `refresh()` right after granting.
 * - **Errors** (fetch failures, a watch dying) go to `onError`; the last good events are kept. A dead watch is
 *   re-established with exponential backoff, followed by a refresh.
 */
export class CalendarCache {
  readonly #source: CalendarSource;
  readonly #now: () => Date;
  readonly #pastMs: number;
  readonly #futureMs: number;
  readonly #refreshIntervalMs: number;
  readonly #rewatchDelayMs: number;
  readonly #maxRewatchDelayMs: number;

  #events: CalendarEvent[] = [];
  #access: CalendarAccess | null = null;
  #fingerprint = '[]';
  #running = false;
  #inflight: Promise<void> | undefined;
  #queued: Promise<void> | undefined;
  #watch: CalendarWatch | undefined;
  #watching: Promise<void> | undefined;
  #rewatchTimer: ReturnType<typeof setTimeout> | undefined;
  #rewatchAttempt = 0;
  #watchStartedAt = 0;
  #intervalTimer: ReturnType<typeof setInterval> | undefined;
  #lastRefreshedAt: Date | null = null;

  #changeListeners = new Set<(events: readonly CalendarEvent[]) => void>();
  #accessListeners = new Set<(access: CalendarAccess) => void>();
  #errorListeners = new Set<(error: Error) => void>();

  constructor(source: CalendarSource, options: CalendarCacheOptions = {}) {
    this.#source = source;
    this.#now = options.now ?? (() => new Date());
    this.#pastMs = options.pastMs ?? 24 * HOUR;
    this.#futureMs = options.futureMs ?? 14 * 24 * HOUR;
    this.#refreshIntervalMs = options.refreshIntervalMs ?? 10 * 60_000;
    this.#rewatchDelayMs = options.rewatchDelayMs ?? 5_000;
    this.#maxRewatchDelayMs = options.maxRewatchDelayMs ?? 5 * 60_000;
  }

  /** Cached events, sorted by start. */
  get events(): readonly CalendarEvent[] {
    return this.#events;
  }

  /** Last known access, or null before the first refresh. */
  get access(): CalendarAccess | null {
    return this.#access;
  }

  get lastRefreshedAt(): Date | null {
    return this.#lastRefreshedAt;
  }

  get running(): boolean {
    return this.#running;
  }

  /** First refresh, then watch + periodic refresh. Resolves after the first refresh. */
  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    if (this.#refreshIntervalMs > 0) {
      this.#intervalTimer = setInterval(() => void this.refresh(), this.#refreshIntervalMs);
      this.#intervalTimer.unref?.();
    }
    await this.refresh();
  }

  /** Stops watching and timers. Cached events stay readable. */
  async stop(): Promise<void> {
    this.#running = false;
    clearInterval(this.#intervalTimer);
    clearTimeout(this.#rewatchTimer);
    this.#intervalTimer = undefined;
    this.#rewatchTimer = undefined;
    await this.#watching?.catch(() => undefined);
    await this.#stopWatch();
    await this.#inflight?.catch(() => undefined);
  }

  /** Re-reads access and events now. Never rejects (errors go to `onError`). */
  refresh(): Promise<void> {
    if (this.#inflight) {
      this.#queued ??= this.#inflight.then(() => {
        this.#queued = undefined;
        return this.refresh();
      });
      return this.#queued;
    }
    const run = this.#refreshOnce()
      .catch((error: unknown) => this.#emitError(error))
      .finally(() => {
        if (this.#inflight === run) this.#inflight = undefined;
      });
    this.#inflight = run;
    return run;
  }

  onChange(listener: (events: readonly CalendarEvent[]) => void): Unsubscribe {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  onAccess(listener: (access: CalendarAccess) => void): Unsubscribe {
    this.#accessListeners.add(listener);
    return () => this.#accessListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): Unsubscribe {
    this.#errorListeners.add(listener);
    return () => this.#errorListeners.delete(listener);
  }

  // --- conveniences over the cached events (D-21 helpers from @oat/core) ---------------------------------

  currentMeeting(now: Date = this.#now()): CalendarEvent | null {
    return currentMeetingFor(this.#events, now);
  }

  upcoming(horizonMs: number, options?: UpcomingOptions, now: Date = this.#now()): CalendarEvent[] {
    return upcoming(this.#events, now, horizonMs, options);
  }

  startingSoon(leadMs?: number, now: Date = this.#now()): CalendarEvent[] {
    return startingSoon(this.#events, now, leadMs);
  }

  // --- internals -----------------------------------------------------------------------------------------

  async #refreshOnce(): Promise<void> {
    const access = await this.#source.status();
    this.#setAccess(access);
    if (!access.canRead) {
      await this.#stopWatch();
      this.#setEvents([]);
      return;
    }
    const now = this.#now().getTime();
    const events = await this.#source.fetchEvents({
      from: new Date(now - this.#pastMs),
      to: new Date(now + this.#futureMs),
    });
    this.#lastRefreshedAt = new Date(now);
    this.#setEvents([...events].sort(compareCalendarEvents));
    if (this.#running && !this.#watch && !this.#watching && !this.#rewatchTimer)
      this.#watching = this.#startWatch();
  }

  async #startWatch(): Promise<void> {
    let current: CalendarWatch | undefined;
    let diedEarly: Error | undefined;
    try {
      current = await this.#source.watch(
        () => void this.refresh(),
        (error) => {
          if (current === undefined) diedEarly = error;
          else this.#watchDied(current, error);
        },
      );
      if (!this.#running) {
        await current.stop();
        return;
      }
      this.#watch = current;
      this.#watchStartedAt = Date.now();
      if (diedEarly) this.#watchDied(current, diedEarly);
    } catch (error) {
      this.#emitError(error);
      this.#scheduleRewatch();
    } finally {
      this.#watching = undefined;
    }
  }

  #watchDied(watch: CalendarWatch, error: Error): void {
    if (this.#watch !== watch) return; // an old watch we already replaced/stopped
    this.#watch = undefined;
    // A watch that ran for a while was healthy: start the backoff afresh.
    if (Date.now() - this.#watchStartedAt > STABLE_WATCH_MS) this.#rewatchAttempt = 0;
    this.#emitError(error);
    this.#scheduleRewatch();
  }

  #scheduleRewatch(): void {
    if (!this.#running || this.#rewatchTimer) return;
    const delay = Math.min(
      this.#maxRewatchDelayMs,
      this.#rewatchDelayMs * 2 ** this.#rewatchAttempt++,
    );
    this.#rewatchTimer = setTimeout(() => {
      this.#rewatchTimer = undefined;
      // The refresh re-establishes the watch (and catches up on anything missed meanwhile). If it failed
      // (status/fetch error) no watch was started: keep backing off instead of waiting for the interval.
      void this.refresh().then(() => {
        if (
          this.#running &&
          this.#access?.canRead &&
          !this.#watch &&
          !this.#watching &&
          !this.#rewatchTimer
        )
          this.#scheduleRewatch();
      });
    }, delay);
    this.#rewatchTimer.unref?.();
  }

  async #stopWatch(): Promise<void> {
    const watch = this.#watch;
    this.#watch = undefined;
    await watch?.stop().catch((error: unknown) => this.#emitError(error));
  }

  #setAccess(access: CalendarAccess): void {
    const prev = this.#access;
    this.#access = access;
    if (prev?.status === access.status && prev.canRead === access.canRead) return;
    for (const l of [...this.#accessListeners]) l(access);
  }

  #setEvents(events: CalendarEvent[]): void {
    const fingerprint = JSON.stringify(events);
    if (fingerprint === this.#fingerprint) return;
    this.#fingerprint = fingerprint;
    this.#events = events;
    for (const l of [...this.#changeListeners]) l(events);
  }

  #emitError(error: unknown): void {
    const e = error instanceof Error ? error : new Error(String(error));
    for (const l of [...this.#errorListeners]) l(e);
  }
}
