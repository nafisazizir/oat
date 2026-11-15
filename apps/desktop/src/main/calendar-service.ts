/**
 * The desktop's calendar (task 7.3): the Mac's calendars (EventKit through the sidecar, or a dev fixture) and
 * Google Calendar through the web API (7.4), merged into one list (`mergeCalendarEvents`: one entry per
 * meeting occurrence, the Mac's copy winning). It feeds
 * - the sidebar's "Upcoming" (today + tomorrow, in progress or ahead; `calendar:changed`),
 * - meeting detection (D-21: which event a detected call is), and
 * - "meeting starting" prompts ~1 min before events with attendees (`startingSoon`, once per event).
 *
 * Nothing here prompts for a permission: the EventKit source's `status` never does, and access is only asked
 * for when the user clicks "Connect" (`connect('eventkit')`).
 */
import {
  type CalendarSource,
  CalendarCache,
  calendarEventKey,
  mergeCalendarEvents,
} from '@oat/calendar';
import type {
  CalendarSnapshot,
  EventkitState,
  GoogleCalendarState,
  UpcomingEvent,
} from '@oat/core/bridge';
import {
  type CalendarEvent,
  hasOtherAttendees,
  nextStartingSoonAt,
  startingSoon,
  upcoming,
} from '@oat/core';

import type { Logger } from './ipc.ts';

/** What `GET /api/calendar/upcoming` says (7.4). */
export interface GoogleUpcoming {
  connected: boolean;
  state: 'ok' | 'reconnect' | 'error' | null;
  events: CalendarEvent[];
}

export interface LocalCalendar {
  source: CalendarSource;
  /** Asks macOS for access (the only prompting call; user-initiated only). */
  requestAccess?: () => Promise<void>;
  /** Opens System Settings → Privacy → Calendars (access was refused before). */
  openSettings?: () => void;
}

export interface CalendarServiceOptions {
  /** The Mac's calendars; `null` when not used (dev default). */
  local: LocalCalendar | null;
  google: {
    /** Rejects when the API can't be reached or refuses; `signal` aborts it (quit). */
    fetch(signal: AbortSignal): Promise<GoogleUpcoming>;
    /** Opens the web app's integrations page (connect Google Calendar). */
    openConnect(): void;
  };
  /** The signed-in account (`null` signed out): Google events belong to it. */
  user: () => string | null;
  /** The note already made for one of these calendar keys, if any (document id). */
  noteFor: (keys: readonly string[]) => string | null;
  /** Merged events changed (detection). */
  onEvents?: (events: readonly CalendarEvent[]) => void;
  onSnapshot?: (snapshot: CalendarSnapshot) => void;
  /** An event with attendees starts in about a minute (called once per event). */
  onStartingSoon?: (event: CalendarEvent) => void;
  now?: () => Date;
  /** Google refresh interval. Default 5 min. */
  googleIntervalMs?: number;
  log?: Logger;
}

const DAY = 24 * 3_600_000;

/** Start of the day after tomorrow (local time): "Upcoming" shows today and tomorrow. */
export function upcomingEnd(now: Date): Date {
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() + 2);
  return end;
}

/** The keys a note for `event` may carry (shared meeting key first, then the source id). */
export function noteKeys(event: CalendarEvent): string[] {
  const key = calendarEventKey(event);
  return key === event.id ? [key] : [key, event.id];
}

export function toUpcomingEvent(event: CalendarEvent, documentId: string | null): UpcomingEvent {
  return {
    id: event.id,
    source: event.source,
    title: event.title,
    start: event.start.toISOString(),
    end: event.end.toISOString(),
    calendarTitle: event.calendar.title,
    calendarColor: event.calendar.color,
    others: event.attendees.filter((a) => !a.isSelf).length,
    conferenceUrl: event.conferenceUrl,
    conferenceProvider: event.conferenceProvider,
    documentId,
  };
}

export class CalendarService {
  readonly #o: CalendarServiceOptions;
  readonly #now: () => Date;
  readonly #cache: CalendarCache | null;
  #local: CalendarEvent[] = [];
  #localError = false;
  #google: CalendarEvent[] = [];
  #googleState: GoogleCalendarState = 'signed_out';
  #merged: CalendarEvent[] = [];
  #seq = 0;
  #snapshot: CalendarSnapshot;
  #fingerprint = '';
  #updatedAt: number | null = null;
  #googleTimer: ReturnType<typeof setInterval> | undefined;
  #tickTimer: ReturnType<typeof setInterval> | undefined;
  #soonTimer: ReturnType<typeof setTimeout> | undefined;
  #googleRun: { user: string; done: Promise<void> } | undefined;
  #notified = new Set<string>();
  #started = false;
  /** Stopped for good (quit): late results (a read finishing, a timer) must not touch closed databases. */
  #stopped = false;
  /** Aborts in-flight API reads on stop: a request still open at quit can keep the process alive. */
  #abort = new AbortController();

  constructor(options: CalendarServiceOptions) {
    this.#o = options;
    this.#now = options.now ?? (() => new Date());
    this.#cache = options.local
      ? new CalendarCache(options.local.source, {
          now: this.#now,
          pastMs: DAY,
          futureMs: 3 * DAY,
        })
      : null;
    this.#snapshot = this.#build();
    this.#fingerprint = fingerprint(this.#snapshot);
    if (this.#cache) {
      this.#cache.onChange((events) => {
        this.#local = [...events];
        this.#localError = false;
        this.#updatedAt = this.#now().getTime();
        this.#merge();
      });
      this.#cache.onAccess(() => this.#emit());
      this.#cache.onError((error) => {
        this.#o.log?.warn(`calendar: ${this.#o.local?.source.name} failed: ${error.message}`);
        this.#localError = true;
        this.#emit();
      });
    }
  }

  get snapshot(): CalendarSnapshot {
    return this.#snapshot;
  }

  /** Merged events (both sources), for detection. */
  get events(): readonly CalendarEvent[] {
    return this.#merged;
  }

  async start(): Promise<void> {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    // Ended events leave the list and "today" rolls over without any source changing.
    this.#tickTimer = setInterval(() => this.#emit(), 60_000);
    this.#tickTimer.unref?.();
    this.#googleTimer = setInterval(
      () => void this.#refreshGoogle(),
      this.#o.googleIntervalMs ?? 5 * 60_000,
    );
    this.#googleTimer.unref?.();
    await Promise.all([
      this.#cache?.start().catch((error: unknown) => {
        this.#o.log?.warn(`calendar: couldn't start the Mac calendar: ${String(error)}`);
        this.#localError = true;
      }),
      this.#refreshGoogle(),
    ]);
    this.#emit();
  }

  async stop(): Promise<void> {
    this.#started = false;
    this.#stopped = true;
    this.#abort.abort();
    clearInterval(this.#googleTimer);
    clearInterval(this.#tickTimer);
    clearTimeout(this.#soonTimer);
    await this.#cache?.stop();
  }

  /** Sign-in changed: Google events belong to the account. */
  authChanged(): void {
    if (this.#stopped) return;
    if (!this.#o.user()) {
      this.#google = [];
      this.#googleState = 'signed_out';
      this.#merge();
      return;
    }
    void this.#refreshGoogle();
  }

  /** Notes changed: an event's "already has a note" may have too. */
  notesChanged(): void {
    this.#emit();
  }

  async refresh(): Promise<CalendarSnapshot> {
    await Promise.all([this.#cache?.refresh().catch(() => {}), this.#refreshGoogle()]);
    this.#emit();
    return this.#snapshot;
  }

  /** The user clicked "Connect" (never called automatically). */
  async connect(provider: 'eventkit' | 'google'): Promise<CalendarSnapshot> {
    if (provider === 'google') {
      this.#o.google.openConnect();
      return this.#snapshot;
    }
    const local = this.#o.local;
    if (!local) return this.#snapshot;
    const status = this.#cache?.access?.status;
    if (status === 'not_determined' && local.requestAccess) {
      await local.requestAccess();
      return this.refresh();
    }
    local.openSettings?.();
    return this.#snapshot;
  }

  /** An event of either source by its id (the Mac's copy or Google's). */
  find(eventId: string): CalendarEvent | null {
    return (
      this.#local.find((e) => e.id === eventId) ??
      this.#google.find((e) => e.id === eventId) ??
      null
    );
  }

  /** The event a note was made from (by the key it carries), while the calendar has it. */
  findByKey(key: string): CalendarEvent | null {
    for (const list of [this.#local, this.#google]) {
      const event = list.find((e) => e.id === key || calendarEventKey(e) === key);
      if (event) return event;
    }
    return null;
  }

  // --- internals -----------------------------------------------------------------------------------------

  #refreshGoogle(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    const user = this.#o.user();
    if (!user) {
      this.#googleState = 'signed_out';
      this.#google = [];
      this.#merge();
      return Promise.resolve();
    }
    // One read at a time per account; a read for an account that is no longer signed in is left to drop.
    if (this.#googleRun?.user === user) return this.#googleRun.done;
    const entry: { user: string; done: Promise<void> } = { user, done: Promise.resolve() };
    entry.done = (async () => {
      if (this.#googleState === 'signed_out') {
        this.#googleState = 'loading';
        this.#emit();
      }
      try {
        const result = await this.#o.google.fetch(this.#abort.signal);
        // Signed out, or another account by now: these events aren't theirs.
        if (this.#o.user() !== user) return;
        this.#googleState = !result.connected ? 'not_connected' : (result.state ?? 'ok');
        // Keep the last good events through a passing error; a revoked grant clears them.
        if (this.#googleState === 'ok' || !result.connected) this.#google = result.events;
        if (this.#googleState === 'reconnect') this.#google = [];
        this.#updatedAt = this.#now().getTime();
      } catch (error) {
        this.#o.log?.warn(`calendar: Google Calendar via the API failed: ${String(error)}`);
        if (this.#googleState === 'loading') this.#googleState = 'error';
      } finally {
        if (this.#googleRun === entry) this.#googleRun = undefined;
      }
      this.#merge();
    })();
    this.#googleRun = entry;
    return entry.done;
  }

  #merge(): void {
    if (this.#stopped) return;
    this.#merged = mergeCalendarEvents([this.#local, this.#google]);
    this.#o.onEvents?.(this.#merged);
    this.#armStartingSoon();
    this.#emit();
  }

  #eventkitState(): EventkitState {
    if (!this.#o.local) return 'off';
    const access = this.#cache?.access;
    if (access) return access.status;
    return this.#localError ? 'error' : 'unknown';
  }

  #build(): CalendarSnapshot {
    const now = this.#now();
    const events = upcoming(this.#merged, now, upcomingEnd(now).getTime() - now.getTime()).map(
      (e) => toUpcomingEvent(e, this.#noteFor(e)),
    );
    return {
      seq: this.#seq,
      eventkit: this.#eventkitState(),
      google: this.#googleState,
      events: events.slice(0, 200),
      updatedAt: this.#updatedAt,
    };
  }

  /** Never throws: a database that is closing (sign-out, quit) just means "no note known". */
  #noteFor(event: CalendarEvent): string | null {
    try {
      return this.#o.noteFor(noteKeys(event));
    } catch (error) {
      this.#o.log?.warn(`calendar: couldn't look up notes: ${String(error)}`);
      return null;
    }
  }

  #emit(): void {
    if (this.#stopped) return;
    const next = this.#build();
    const print = fingerprint(next);
    if (print === this.#fingerprint) return;
    this.#fingerprint = print;
    this.#snapshot = { ...next, seq: ++this.#seq };
    this.#o.onSnapshot?.(this.#snapshot);
  }

  #armStartingSoon(): void {
    clearTimeout(this.#soonTimer);
    this.#soonTimer = undefined;
    if (!this.#started || !this.#o.onStartingSoon) return;
    const now = this.#now();
    for (const event of startingSoon(this.#merged, now)) {
      if (this.#notified.has(event.id) || !hasOtherAttendees(event)) continue;
      this.#notified.add(event.id);
      this.#o.onStartingSoon(event);
    }
    // Forget events that are over (the set stays small).
    for (const id of this.#notified) {
      const e = this.#merged.find((x) => x.id === id);
      if (!e || e.end.getTime() <= now.getTime()) this.#notified.delete(id);
    }
    const pending = this.#merged.filter((e) => !this.#notified.has(e.id));
    const at = nextStartingSoonAt(pending, now);
    if (at === null) return;
    // Long waits are re-armed on the next change or tick anyway; cap the timer so a sleep doesn't skew it.
    const delay = Math.min(Math.max(0, at.getTime() - now.getTime()), 10 * 60_000);
    this.#soonTimer = setTimeout(() => this.#armStartingSoon(), delay);
    this.#soonTimer.unref?.();
  }
}

function fingerprint(s: CalendarSnapshot): string {
  return JSON.stringify({ ...s, seq: 0 });
}
