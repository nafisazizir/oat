/**
 * `GoogleCalendarSource`: a `CalendarSource` over the Google Calendar API, with its own incremental cache.
 *
 * - **Full sync** (first use, a requested range outside the synced window, or once a day): lists the user's
 *   calendars (primary + those shown in Google's UI; free/busy-only ones skipped), then every calendar's
 *   events in the window (default −1 day … +28 days, expanded instances), keeping each calendar's
 *   `nextSyncToken`.
 * - **Incremental sync** (later calls, at most every `minSyncIntervalMs`): re-lists calendars (new ones get a
 *   full sync, removed ones are dropped) and asks each calendar for changes since its sync token: changed events
 *   are upserted, `cancelled` ones removed. **410** (`fullSyncRequired`) → that calendar is fully re-synced.
 *   Changes may lie outside the window; reads filter by range, and the window check above makes sure events
 *   that never changed are only trusted inside it.
 * - Deleted/cancelled events are not shown (Google can't tell "cancelled by the organizer" from "deleted").
 * - Auth failures (token refused after a refresh, missing scope) clear the cache and switch `status()` to
 *   `denied` until a later sync succeeds; reads then throw `CalendarAccessError`.
 * - `watch` polls (Google push notifications need a public webhook; out of scope).
 *
 * One instance per connected Google account: the instance *is* the per-user cache. Concurrent calls share
 * one sync.
 */
import { type CalendarAccess, type CalendarEvent, compareCalendarEvents } from '@oat/core';

import { filterRange } from '../fixture-source.ts';
import {
  CalendarAccessError,
  type CalendarRange,
  type CalendarSource,
  type CalendarWatch,
} from '../types.ts';
import type { GoogleCalendarListEntry } from './api.ts';
import {
  GoogleCalendarAuthError,
  GoogleCalendarClient,
  type GoogleCalendarClientOptions,
  GoogleSyncTokenExpiredError,
} from './client.ts';
import {
  calendarInfoFromListEntry,
  type GoogleCalendarInfo,
  normalizeGoogleEvent,
} from './normalize.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Slack added around a requested range that reaches beyond the default window. */
const WINDOW_PAD_MS = 7 * DAY;

export interface GoogleCalendarSourceOptions {
  /** Or pass `baseUrl` + `getAccessToken` (+ client options) and one is created. */
  client?: GoogleCalendarClient;
  clientOptions?: GoogleCalendarClientOptions;
  now?: () => Date;
  /** Synced window relative to now. Defaults: 1 day back, 28 days ahead. */
  windowPastMs?: number;
  windowFutureMs?: number;
  /** Reads within this long of the last sync are served from the cache. Default 30 s. */
  minSyncIntervalMs?: number;
  /** Full re-sync at least this often. Default 24 h. */
  fullResyncAfterMs?: number;
  /** `watch` polling interval. Default 60 s. */
  pollIntervalMs?: number;
}

interface CalendarState {
  info: GoogleCalendarInfo;
  syncToken: string | null;
  /** By Google event id. */
  events: Map<string, CalendarEvent>;
}

interface SyncState {
  window: CalendarRange;
  fullAt: number;
  syncedAt: number;
  calendars: Map<string, CalendarState>;
}

export interface GoogleSyncStats {
  fullSyncs: number;
  incrementalSyncs: number;
  /** Calendars re-synced because a sync token was refused (410). */
  expiredSyncTokens: number;
  /** Calendars skipped in a sync because their request failed (the others were still read). */
  calendarFailures: number;
}

/** Calendars whose events Oat reads: primary + those shown in Google's UI, never free/busy-only. */
export function isReadableCalendar(entry: GoogleCalendarListEntry): boolean {
  if (entry.deleted || entry.hidden) return false;
  if (entry.accessRole === 'freeBusyReader') return false;
  return entry.primary === true || entry.selected === true;
}

export class GoogleCalendarSource implements CalendarSource {
  readonly name = 'google';
  readonly client: GoogleCalendarClient;
  readonly #now: () => Date;
  readonly #pastMs: number;
  readonly #futureMs: number;
  readonly #minSyncIntervalMs: number;
  readonly #fullResyncAfterMs: number;
  readonly #pollIntervalMs: number;

  #state: SyncState | null = null;
  #authError: Error | null = null;
  #inflight: Promise<void> | undefined;
  #version = 0;
  readonly stats: GoogleSyncStats = {
    fullSyncs: 0,
    incrementalSyncs: 0,
    expiredSyncTokens: 0,
    calendarFailures: 0,
  };

  constructor(options: GoogleCalendarSourceOptions) {
    const client =
      options.client ?? (options.clientOptions && new GoogleCalendarClient(options.clientOptions));
    if (!client) throw new TypeError('GoogleCalendarSource needs `client` or `clientOptions`');
    this.client = client;
    this.#now = options.now ?? (() => new Date());
    this.#pastMs = options.windowPastMs ?? DAY;
    this.#futureMs = options.windowFutureMs ?? 28 * DAY;
    this.#minSyncIntervalMs = options.minSyncIntervalMs ?? 30_000;
    this.#fullResyncAfterMs = options.fullResyncAfterMs ?? DAY;
    this.#pollIntervalMs = options.pollIntervalMs ?? 60_000;
  }

  /** Never calls the API: reports what the last sync learned. */
  async status(): Promise<CalendarAccess> {
    return this.#authError
      ? { status: 'denied', canRead: false }
      : { status: 'full_access', canRead: true };
  }

  /** The last auth failure (e.g. for "reconnect" UI), or null. */
  get authError(): Error | null {
    return this.#authError;
  }

  async fetchEvents(range: CalendarRange): Promise<CalendarEvent[]> {
    await this.sync({ range });
    return filterRange(this.#all(), range);
  }

  /**
   * Brings the cache up to date (see the class comment for when it is full vs incremental). `force` skips the
   * minimum interval. Rejects with `CalendarAccessError` on auth failures, else with the API error.
   */
  sync(options: { range?: CalendarRange; force?: boolean } = {}): Promise<void> {
    const running = this.#inflight;
    if (running) {
      // Join the running sync; if it was for a narrower window than this caller needs, sync again after.
      return running.then(() => (this.#covers(options.range) ? undefined : this.sync(options)));
    }
    const run = this.#sync(options).finally(() => {
      if (this.#inflight === run) this.#inflight = undefined;
    });
    this.#inflight = run;
    return run;
  }

  /** Drops the cache (next read does a full sync). */
  invalidate(): void {
    this.#state = null;
  }

  async watch(onChange: () => void, onError: (error: Error) => void): Promise<CalendarWatch> {
    if (this.#authError) throw new CalendarAccessError(this.#authError.message);
    let seen = this.#version;
    let stopped = false;
    const timer = setInterval(() => {
      this.sync({ force: true }).then(
        () => {
          if (stopped || this.#version === seen) return;
          seen = this.#version;
          onChange();
        },
        (error: unknown) => {
          if (stopped || !(error instanceof CalendarAccessError)) return; // transient: next poll retries
          stopped = true;
          clearInterval(timer);
          onError(error);
        },
      );
    }, this.#pollIntervalMs);
    timer.unref?.();
    return {
      stop: async () => {
        stopped = true;
        clearInterval(timer);
      },
    };
  }

  // --- internals -----------------------------------------------------------------------------------------

  #all(): CalendarEvent[] {
    const out: CalendarEvent[] = [];
    for (const cal of this.#state?.calendars.values() ?? []) out.push(...cal.events.values());
    return out.sort(compareCalendarEvents);
  }

  #covers(range: CalendarRange | undefined): boolean {
    const state = this.#state;
    return (
      !!state &&
      (!range ||
        (range.from.getTime() >= state.window.from.getTime() &&
          range.to.getTime() <= state.window.to.getTime()))
    );
  }

  async #sync({ range, force }: { range?: CalendarRange; force?: boolean }): Promise<void> {
    const now = this.#now().getTime();
    const state = this.#state;
    try {
      if (!state || !this.#covers(range) || now - state.fullAt >= this.#fullResyncAfterMs) {
        await this.#full(now, range);
      } else if (force || now - state.syncedAt >= this.#minSyncIntervalMs) {
        await this.#incremental(state, now);
      }
      this.#authError = null;
    } catch (error) {
      if (error instanceof GoogleCalendarAuthError) {
        this.#authError = error;
        if (this.#state) this.#version++;
        this.#state = null;
        throw new CalendarAccessError(`Google Calendar access failed: ${error.message}`, {
          cause: error,
        });
      }
      throw error;
    }
  }

  async #full(now: number, range: CalendarRange | undefined): Promise<void> {
    // A range reaching past the default window gets `WINDOW_PAD_MS` of slack, so the same request made a
    // little later (now has moved on) is still covered instead of forcing another full sync.
    const window: CalendarRange = {
      from: new Date(
        Math.min(now - this.#pastMs, (range?.from.getTime() ?? Infinity) - WINDOW_PAD_MS),
      ),
      to: new Date(
        Math.max(now + this.#futureMs, (range?.to.getTime() ?? -Infinity) + WINDOW_PAD_MS),
      ),
    };
    const entries = (await this.client.listCalendars()).filter(isReadableCalendar);
    const calendars = new Map<string, CalendarState>();
    const results = await Promise.allSettled(
      entries.map(async (entry) => {
        calendars.set(entry.id, await this.#fullCalendar(entry, window));
      }),
    );
    // One failing calendar (a 404/5xx, a shared calendar we lost access to) doesn't hide the others: it
    // is kept without a sync token, so the next sync retries it in full.
    this.#settle(results, entries.length, () => undefined);
    for (const entry of entries) {
      if (!calendars.has(entry.id)) {
        calendars.set(entry.id, {
          info: calendarInfoFromListEntry(entry),
          syncToken: null,
          events: new Map(),
        });
      }
    }
    this.stats.fullSyncs++;
    this.#state = { window, fullAt: now, syncedAt: now, calendars };
    this.#version++;
  }

  /**
   * Per-calendar results: an auth failure anywhere is the account's problem (rethrown); other failures are
   * isolated (`onFailed`), unless every calendar failed — then the first error is thrown.
   */
  #settle(
    results: PromiseSettledResult<unknown>[],
    total: number,
    onFailed: (index: number) => void,
  ): void {
    const failures = results.flatMap((r, i) =>
      r.status === 'rejected' ? [{ i, error: r.reason as unknown }] : [],
    );
    const auth = failures.find((f) => f.error instanceof GoogleCalendarAuthError);
    if (auth) throw auth.error;
    if (failures.length > 0 && failures.length === total) throw failures[0]!.error;
    for (const f of failures) {
      this.stats.calendarFailures++;
      onFailed(f.i);
    }
  }

  async #fullCalendar(
    entry: GoogleCalendarListEntry,
    window: CalendarRange,
  ): Promise<CalendarState> {
    const list = await this.client.listEvents(entry.id, {
      timeMin: window.from,
      timeMax: window.to,
    });
    const info = calendarInfoFromListEntry(entry);
    info.timeZone ??= list.timeZone;
    const events = new Map<string, CalendarEvent>();
    for (const item of list.items) {
      if (item.status === 'cancelled') continue;
      const event = normalizeGoogleEvent(item, info);
      if (event) events.set(item.id, event);
    }
    return { info, syncToken: list.nextSyncToken, events };
  }

  async #incremental(state: SyncState, now: number): Promise<void> {
    const entries = (await this.client.listCalendars()).filter(isReadableCalendar);
    const next = new Map<string, CalendarState>();
    let changed = entries.length !== state.calendars.size;
    const results = await Promise.allSettled(
      entries.map(async (entry) => {
        const existing = state.calendars.get(entry.id);
        if (!existing?.syncToken) {
          changed = true;
          next.set(entry.id, await this.#fullCalendar(entry, state.window));
          return;
        }
        let list;
        try {
          list = await this.client.listEvents(entry.id, { syncToken: existing.syncToken });
        } catch (error) {
          if (!(error instanceof GoogleSyncTokenExpiredError)) throw error;
          this.stats.expiredSyncTokens++;
          changed = true;
          next.set(entry.id, await this.#fullCalendar(entry, state.window));
          return;
        }
        const info = calendarInfoFromListEntry(entry);
        info.timeZone ??= list.timeZone ?? existing.info.timeZone;
        const events = new Map(existing.events);
        if (JSON.stringify(info) !== JSON.stringify(existing.info)) {
          // Renamed / recoloured: the calendar ref is part of every event.
          changed = true;
          for (const [id, e] of events) {
            events.set(id, {
              ...e,
              calendar: { id: info.id, title: info.title, color: info.color },
            });
          }
        }
        for (const item of list.items) {
          changed = true;
          const event = item.status === 'cancelled' ? null : normalizeGoogleEvent(item, info);
          if (event) events.set(item.id, event);
          else events.delete(item.id);
        }
        next.set(entry.id, { info, syncToken: list.nextSyncToken ?? existing.syncToken, events });
      }),
    );
    // A calendar that failed keeps what we had for it (and retries next time).
    this.#settle(results, entries.length, (index) => {
      const entry = entries[index]!;
      const existing = state.calendars.get(entry.id);
      if (existing && !next.has(entry.id)) next.set(entry.id, existing);
    });
    this.stats.incrementalSyncs++;
    // Only commit if no full sync replaced the state meanwhile.
    if (this.#state === state) {
      this.#state = { ...state, syncedAt: now, calendars: next };
      if (changed) this.#version++;
    }
  }
}
