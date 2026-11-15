import 'server-only';

import {
  disconnectGoogleCalendar,
  findGoogleCalendarConnection,
  type GoogleCalendarConnection,
  googleCalendarTokenProvider,
} from '@oat/auth';
import { CalendarAccessError, mergeCalendarEvents } from '@oat/calendar';
import { GoogleCalendarSource } from '@oat/calendar/google';
import { type CalendarEvent, upcoming } from '@oat/core';

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

export type CalendarSourceState =
  /** Events loaded. */
  | 'ok'
  /** Access was refused or lacks the calendar scope: connect again. */
  | 'reconnect'
  /** Google (or the network) failed; try later. */
  | 'error';

export interface CalendarSourceStatus {
  kind: 'google';
  state: CalendarSourceState;
  /** The connected Google account. */
  email: string | null;
}

export interface UpcomingMeetings {
  /** Whether any calendar is connected. */
  connected: boolean;
  sources: CalendarSourceStatus[];
  events: CalendarEvent[];
}

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
