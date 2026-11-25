import 'server-only';

import {
  disconnectGoogleCalendar,
  findGoogleCalendarConnection,
  type GoogleCalendarConnection,
  googleCalendarTokenProvider,
} from '@oat/auth';
import { CalendarAccessError, calendarEventKey, mergeCalendarEvents } from '@oat/calendar';
import { GoogleCalendarSource } from '@oat/calendar/google';
import { type CalendarEvent, compareCalendarEvents, isAttending, upcoming } from '@oat/core';
import type {
  CalendarSourceState,
  CalendarSourceStatus,
  UpcomingMeetings,
} from '@oat/services/dto/calendar';

import { googleCalendarBaseUrl, serverEnv } from '@/lib/env';

import { getAuth, getAuthConfig } from './auth';
import { getDb } from './db';

/*
 * Calendar sources of a signed-in user, merged. On the web that is Google Calendar (7.4); the desktop app adds
 * EventKit locally and uses the same API. One `GoogleCalendarSource` per connected Google account, kept in
 * memory: it holds that user's sync tokens and events (the per-user cache), so repeat reads are incremental.
 */

/** Upcoming list defaults: next 5 events within two weeks (wide enough to reach next week's Monday). */
export const UPCOMING_LIMIT = 5;
export const UPCOMING_HORIZON_MS = 14 * 24 * 3_600_000;
const MAX_CACHED_SOURCES = 500;

export type {
  CalendarSourceState,
  CalendarSourceStatus,
  UpcomingMeetings,
} from '@oat/services/dto/calendar';

const globalForCalendar = globalThis as typeof globalThis & {
  __oatGoogleCalendarSources?: Map<string, GoogleCalendarSource>;
};
const sources = (globalForCalendar.__oatGoogleCalendarSources ??= new Map());

function googleSource(connection: GoogleCalendarConnection, userId: string): GoogleCalendarSource {
  let source = sources.get(connection.accountId);
  if (source) {
    // Most recently used last, so the oldest is evicted first.
    sources.delete(connection.accountId);
  } else {
    source = new GoogleCalendarSource({
      clientOptions: {
        baseUrl: googleCalendarBaseUrl(serverEnv()),
        getAccessToken: googleCalendarTokenProvider(getAuth().api, {
          accountId: connection.accountId,
          userId,
        }),
      },
    });
  }
  sources.set(connection.accountId, source);
  if (sources.size > MAX_CACHED_SOURCES) sources.delete(sources.keys().next().value!);
  return source;
}

export function getGoogleCalendarConnection(userId: string) {
  return findGoogleCalendarConnection(getDb(), userId);
}

/** In-progress and upcoming events of every connected calendar (cancelled/declined/all-day left out). */
export async function listUpcomingMeetings(
  userId: string,
  options: { now?: Date; limit?: number; horizonMs?: number } = {},
): Promise<UpcomingMeetings> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? UPCOMING_LIMIT;
  const horizonMs = options.horizonMs ?? UPCOMING_HORIZON_MS;
  const connection = await getGoogleCalendarConnection(userId);
  if (!connection) return { connected: false, sources: [], events: [] };

  const status: CalendarSourceStatus = { kind: 'google', state: 'ok', email: connection.email };
  let events: CalendarEvent[] = [];
  if (!connection.hasCalendarScope) {
    status.state = 'reconnect';
  } else {
    try {
      events = await googleSource(connection, userId).fetchEvents({
        // Meetings already under way are still "upcoming" until they end.
        from: new Date(now.getTime() - 24 * 3_600_000),
        to: new Date(now.getTime() + horizonMs),
      });
    } catch (error) {
      status.state = error instanceof CalendarAccessError ? 'reconnect' : 'error';
      if (status.state === 'error') console.error('calendar: Google Calendar read failed:', error);
    }
  }
  return {
    connected: true,
    sources: [status],
    events: upcoming(mergeCalendarEvents([events]), now, horizonMs).slice(0, limit),
  };
}

/**
 * One event of the user's connected calendars by id (7.3 "Start notes"), within the window Home lists (a day
 * back … three weeks ahead); `null` when it isn't there or the calendar can't be read.
 */
export async function findCalendarEvent(
  userId: string,
  eventId: string,
  options: { now?: Date } = {},
): Promise<CalendarEvent | null> {
  const now = options.now ?? new Date();
  const connection = await getGoogleCalendarConnection(userId);
  if (!connection?.hasCalendarScope) return null;
  try {
    const events = await googleSource(connection, userId).fetchEvents({
      from: new Date(now.getTime() - 24 * 3_600_000),
      to: new Date(now.getTime() + 21 * 24 * 3_600_000),
    });
    return events.find((e) => e.id === eventId) ?? null;
  } catch (error) {
    if (!(error instanceof CalendarAccessError)) {
      console.error('calendar: Google Calendar read failed:', error);
    }
    return null;
  }
}

/**
 * The event a meeting note was started from, by its meeting key (`meeting.calendar_event_id`,
 * `calendarEventKey`), while the user's calendar still has it (yesterday to three weeks out, as above).
 * `null` when not connected, not found or the calendar can't be read: the note simply shows no event line.
 */
export async function findCalendarEventByKey(
  userId: string,
  key: string,
  options: { now?: Date } = {},
): Promise<CalendarEvent | null> {
  const now = options.now ?? new Date();
  const connection = await getGoogleCalendarConnection(userId);
  if (!connection?.hasCalendarScope) return null;
  try {
    const events = await googleSource(connection, userId).fetchEvents({
      from: new Date(now.getTime() - 24 * 3_600_000),
      to: new Date(now.getTime() + 21 * 24 * 3_600_000),
    });
    return events.find((e) => calendarEventKey(e) === key) ?? null;
  } catch (error) {
    if (!(error instanceof CalendarAccessError)) {
      console.error('calendar: Google Calendar read failed:', error);
    }
    return null;
  }
}

/** How far either side of a note's time its linkable events are looked for. */
export const NEAR_MS = 12 * 3_600_000;

export interface EventsNear {
  connected: boolean;
  /** `null` when not connected. */
  state: CalendarSourceState | null;
  events: CalendarEvent[];
}

/**
 * The user's timed events overlapping `at` ± 12 h (cancelled/declined/all-day left out): what a meeting note
 * recorded then can be linked to. Inside the window Home reads (a day back … three weeks ahead) this is the
 * cached source; an older time is read once with a source of its own, so the shared cache keeps its window.
 */
export async function listEventsNear(
  userId: string,
  at: Date,
  options: { now?: Date } = {},
): Promise<EventsNear> {
  const now = options.now ?? new Date();
  const connection = await getGoogleCalendarConnection(userId);
  if (!connection) return { connected: false, state: null, events: [] };
  if (!connection.hasCalendarScope) return { connected: true, state: 'reconnect', events: [] };
  const range = { from: new Date(at.getTime() - NEAR_MS), to: new Date(at.getTime() + NEAR_MS) };
  const cached = googleSource(connection, userId);
  const recent =
    range.from.getTime() >= now.getTime() - 24 * 3_600_000 &&
    range.to.getTime() <= now.getTime() + 21 * 24 * 3_600_000;
  try {
    let events: CalendarEvent[];
    if (recent) {
      events = await cached.fetchEvents(range);
    } else {
      const once = new GoogleCalendarSource({
        client: cached.client,
        now: () => at,
        windowPastMs: NEAR_MS,
        windowFutureMs: NEAR_MS,
      });
      // Synced without a range first: a ranged first read would pad the window by a week each side.
      await once.sync();
      events = await once.fetchEvents(range);
    }
    return {
      connected: true,
      state: 'ok',
      events: mergeCalendarEvents([events])
        .filter((e) => !e.allDay && isAttending(e))
        .sort(compareCalendarEvents),
    };
  } catch (error) {
    if (error instanceof CalendarAccessError)
      return { connected: true, state: 'reconnect', events: [] };
    console.error('calendar: Google Calendar read failed:', error);
    return { connected: true, state: 'error', events: [] };
  }
}

/** Revokes and removes the user's Google Calendar grant and forgets its cached events. */
export async function disconnectGoogleCalendarFor(userId: string) {
  const connection = await getGoogleCalendarConnection(userId);
  if (connection) sources.delete(connection.accountId);
  return disconnectGoogleCalendar({
    db: getDb(),
    api: getAuth().api,
    google: getAuthConfig().google,
    userId,
  });
}
