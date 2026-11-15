import {
  CalendarEventSchema,
  compareCalendarEvents,
  type CalendarAccess,
  type CalendarAccessStatus,
  type CalendarEvent,
  type CalendarEventInput,
} from '@oat/core';

import {
  CalendarAccessError,
  type CalendarRange,
  type CalendarSource,
  type CalendarWatch,
} from './types.ts';

export interface FixtureCalendarSourceOptions {
  /** Normalised events (JSON form or parsed). */
  events?: readonly (CalendarEvent | CalendarEventInput)[];
  /** Default `full_access`. */
  access?: CalendarAccessStatus;
}

/**
 * In-memory `CalendarSource` for tests and for running without the sidecar (e.g. on Linux CI or in the
 * renderer). `setEvents` simulates an `EKEventStoreChanged` by notifying watchers.
 */
export class FixtureCalendarSource implements CalendarSource {
  readonly name = 'fixture';
  #events: CalendarEvent[];
  #access: CalendarAccessStatus;
  #watchers = new Set<() => void>();
  #failNext: Error | undefined;
  /** How many times `fetchEvents` ran (tests). */
  fetchCount = 0;

  constructor(options: FixtureCalendarSourceOptions = {}) {
    this.#events = parseEvents(options.events ?? []);
    this.#access = options.access ?? 'full_access';
  }

  /** Replaces the events and notifies watchers. */
  setEvents(events: readonly (CalendarEvent | CalendarEventInput)[]): void {
    this.#events = parseEvents(events);
    for (const w of [...this.#watchers]) w();
  }

  /** Changes the reported access (does not notify, like a real permission change). */
  setAccess(access: CalendarAccessStatus): void {
    this.#access = access;
  }

  /** Makes the next `fetchEvents` reject with `error`. */
  failNextFetch(error: Error): void {
    this.#failNext = error;
  }

  get watcherCount(): number {
    return this.#watchers.size;
  }

  async status(): Promise<CalendarAccess> {
    return { status: this.#access, canRead: this.#access === 'full_access' };
  }

  async fetchEvents(range: CalendarRange): Promise<CalendarEvent[]> {
    this.fetchCount++;
    const fail = this.#failNext;
    this.#failNext = undefined;
    if (fail) throw fail;
    if (this.#access !== 'full_access')
      throw new CalendarAccessError(`calendar access is ${this.#access}`);
    return filterRange(this.#events, range).map((e) => structuredClone(e));
  }

  async watch(onChange: () => void): Promise<CalendarWatch> {
    if (this.#access !== 'full_access')
      throw new CalendarAccessError(`calendar access is ${this.#access}`);
    const listener = () => onChange();
    this.#watchers.add(listener);
    return {
      stop: async () => {
        this.#watchers.delete(listener);
      },
    };
  }
}

export function parseEvents(events: readonly unknown[]): CalendarEvent[] {
  return events.map((e) => CalendarEventSchema.parse(e)).sort(compareCalendarEvents);
}

/** Events overlapping `[from, to)` (a zero-length event at `from` counts), sorted. */
export function filterRange(
  events: readonly CalendarEvent[],
  range: CalendarRange,
): CalendarEvent[] {
  const from = range.from.getTime();
  const to = range.to.getTime();
  return events
    .filter((e) => {
      const s = e.start.getTime();
      const end = e.end.getTime();
      return s < to && (end > from || (end === s && s >= from));
    })
    .sort(compareCalendarEvents);
}

/** Parses JSON-lines text (one normalised event per line, as `oat-audio calendar events` prints). */
export function parseEventLines(text: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (e) {
      throw new SyntaxError(`line ${i + 1}: ${(e as Error).message}`, { cause: e });
    }
    const parsed = CalendarEventSchema.safeParse(json);
    if (!parsed.success) throw new TypeError(`line ${i + 1}: ${parsed.error.message}`);
    events.push(parsed.data);
  });
  return events;
}
