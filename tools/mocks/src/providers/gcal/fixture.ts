/**
 * Turns the EventKit-shaped calendar fixture (`fixtures/calendar/week.json`, PROTOCOL.md → "Calendar
 * fixtures") into Google Calendar v3 resources, the way the same meetings would look through the API:
 *
 * - Calendars → `calendarListEntry` (first one `primary`; colours lower-case hex like Google's).
 * - Timed events: `start/end.dateTime` in the event's zone with its offset, plus `timeZone`. All-day: `date`
 *   (end exclusive; EventKit's last-day 23:59:59 end becomes the next day).
 * - Recurring occurrences (`recurring` + `occurrenceDate`) → instances as `singleEvents=true` returns them:
 *   `id = <series>_<YYYYMMDDTHHMMSSZ of the original start>`, `recurringEventId`, `originalStartTime`.
 * - Attendees: the organizer is always in the list (`organizer: true`) when there are attendees, as Google
 *   does; rooms/resources get `resource: true`; EventKit statuses map to `responseStatus`.
 * - The event `url` becomes `source.url`; a Meet link also becomes `hangoutLink` + Meet `conferenceData`, a
 *   Zoom/Teams link add-on `conferenceData`. Notes → `description`. `externalId` → `iCalUID`
 *   (else `<id>@google.com`).
 * - `status: cancelled` events stay in the store as deleted events (only `showDeleted` / sync return them).
 *
 * Google-only events EventKit never shows are added to the primary calendar (`GOOGLE_ONLY_EVENTS`): a working
 * location, an out-of-office block and a focus-time block (`eventType` other than `default`).
 *
 * `weeks` shifts every event by whole weeks of wall-clock time in its own zone (09:30 stays 09:30).
 */
import {
  addDays,
  compactUtc,
  dayIn,
  midnightIn,
  rfc3339InZone,
  shiftWallDays,
  wallToInstant,
  weekday,
} from './time.ts';
import type { GoogleAttendee, GoogleCalendarListEntry, GoogleEvent } from './types.ts';

interface FixtureParticipant {
  name?: string | null;
  email?: string | null;
  url?: string | null;
  status?: string;
  type?: string;
  self?: boolean;
}

interface FixtureEvent {
  id?: string;
  externalId?: string | null;
  calendarId: string;
  title?: string | null;
  start: string;
  end: string;
  allDay?: boolean;
  timeZone?: string | null;
  location?: string | null;
  url?: string | null;
  notes?: string | null;
  status?: string;
  recurring?: boolean;
  detached?: boolean;
  occurrenceDate?: string | null;
  organizer?: FixtureParticipant | null;
  attendees?: FixtureParticipant[];
}

export interface CalendarFixture {
  timeZone?: string;
  calendars: { id: string; title: string; color?: string | null }[];
  events: FixtureEvent[];
}

export interface MockCalendarData {
  calendars: GoogleCalendarListEntry[];
  /** Per calendar id. Includes deleted (`status: cancelled`) events. */
  events: Map<string, GoogleEvent[]>;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MEET = /https?:\/\/meet\.google\.com\/[a-z0-9-]+/i;
const ZOOM = /https?:\/\/(?:[a-z0-9-]+\.)*zoom(?:gov)?\.(?:us|com)\//i;
const TEAMS = /https?:\/\/teams\.(?:microsoft\.com|live\.com|cloud\.microsoft)\//i;

function instant(value: string, timeZone: string): number {
  return DATE_ONLY.test(value) ? midnightIn(value, timeZone) : Date.parse(value);
}

function responseStatus(status: string | undefined): GoogleAttendee['responseStatus'] {
  switch (status) {
    case 'accepted':
    case 'completed':
    case 'in_process':
      return 'accepted';
    case 'declined':
    case 'delegated':
      return 'declined';
    case 'tentative':
      return 'tentative';
    default:
      return 'needsAction';
  }
}

function emailOf(p: FixtureParticipant): string | undefined {
  if (p.email) return p.email;
  if (p.url?.toLowerCase().startsWith('mailto:')) return decodeURIComponent(p.url.slice(7));
  return undefined;
}

const nonEmpty = (s: string | null | undefined) => (s && s.trim() ? s : undefined);

/** The Monday (in the fixture's zone) on or after the first event's start day: what `weeks` counts from. */
export function fixtureAnchor(fixture: CalendarFixture): number {
  const tz = fixture.timeZone ?? 'UTC';
  const first = Math.min(...fixture.events.map((e) => instant(e.start, tz)));
  let day = dayIn(first, tz);
  while (weekday(day) !== 1) day = addDays(day, 1);
  return midnightIn(day, tz);
}

export function googleDataFromFixture(
  fixture: CalendarFixture,
  options: { weeks?: number; updated?: string } = {},
): MockCalendarData {
  const zone = fixture.timeZone ?? 'UTC';
  const days = 7 * (options.weeks ?? 0);
  const updated = options.updated ?? new Date().toISOString();

  const calendars: GoogleCalendarListEntry[] = fixture.calendars.map((c, i) => ({
    kind: 'calendar#calendarListEntry',
    etag: `"cal-${i}"`,
    id: c.id,
    summary: c.title,
    timeZone: zone,
    colorId: String(i + 1),
    backgroundColor: (c.color ?? '#9fc6e7').toLowerCase(),
    foregroundColor: '#000000',
    selected: true,
    accessRole: 'owner',
    defaultReminders: [],
    ...(i === 0 ? { primary: true } : {}),
  }));

  const events = new Map<string, GoogleEvent[]>(calendars.map((c) => [c.id, []]));
  fixture.events.forEach((e, index) => {
    const list = events.get(e.calendarId);
    if (!list) throw new Error(`fixture event ${e.id ?? index}: unknown calendar ${e.calendarId}`);
    list.push(toGoogleEvent(e, index, { zone, days, updated }));
  });
  const primary = events.get(calendars[0]!.id)!;
  const monday = addDays(dayIn(fixtureAnchor(fixture), zone), days);
  for (const extra of GOOGLE_ONLY_EVENTS) {
    const day = addDays(monday, extra.day);
    const at = (time: string) => {
      const [hour, minute] = time.split(':').map(Number) as [number, number];
      const [year, month, d] = day.split('-').map(Number) as [number, number, number];
      return rfc3339InZone(
        wallToInstant({ year, month, day: d, hour, minute, second: 0 }, zone),
        zone,
      );
    };
    primary.push({
      kind: 'calendar#event',
      etag: '"0"',
      id: `${extra.id}${day.replace(/-/g, '')}`,
      status: 'confirmed',
      created: updated,
      updated,
      summary: extra.summary,
      start: { dateTime: at(extra.start), timeZone: zone },
      end: { dateTime: at(extra.end), timeZone: zone },
      iCalUID: `${extra.id}${day.replace(/-/g, '')}@google.com`,
      sequence: 0,
      eventType: extra.eventType,
    });
  }
  return { calendars, events };
}

/**
 * Google-only events on the primary calendar (days after the fixture's Monday, local times). Oat doesn't treat
 * them as meetings (`normalizeGoogleEvent` skips these event types).
 */
export const GOOGLE_ONLY_EVENTS = [
  {
    id: 'wl',
    day: 0,
    start: '08:00',
    end: '17:00',
    summary: 'Office',
    eventType: 'workingLocation',
  },
  {
    id: 'focus',
    day: 3,
    start: '13:00',
    end: '15:00',
    summary: 'Deep work',
    eventType: 'focusTime',
  },
  {
    id: 'ooo',
    day: 4,
    start: '13:00',
    end: '17:00',
    summary: 'Out of office',
    eventType: 'outOfOffice',
  },
] as const;

function toGoogleEvent(
  e: FixtureEvent,
  index: number,
  { zone, days, updated }: { zone: string; days: number; updated: string },
): GoogleEvent {
  const tz = nonEmpty(e.timeZone) ?? zone;
  const base = e.id ?? `event${index}`;
  const recurring = !!(e.recurring || e.detached);

  let start: GoogleEvent['start'];
  let end: GoogleEvent['end'];
  let originalStartTime: GoogleEvent['originalStartTime'];
  let id = base;

  if (e.allDay) {
    const startMs = instant(e.start, zone);
    const endMs = instant(e.end, zone);
    const first = addDays(dayIn(startMs, zone), days);
    const endDay = dayIn(endMs, zone);
    let last = addDays(endMs === midnightIn(endDay, zone) ? endDay : addDays(endDay, 1), days);
    if (last <= first) last = addDays(first, 1);
    start = { date: first };
    end = { date: last };
    if (recurring) {
      const original = addDays(dayIn(instant(e.occurrenceDate ?? e.start, zone), zone), days);
      originalStartTime = { date: original };
      id = `${base}_${original.replace(/-/g, '')}`;
    }
  } else {
    const startMs = shiftWallDays(instant(e.start, zone), tz, days);
    const endMs = Math.max(startMs, shiftWallDays(instant(e.end, zone), tz, days));
    start = { dateTime: rfc3339InZone(startMs, tz), timeZone: tz };
    end = { dateTime: rfc3339InZone(endMs, tz), timeZone: tz };
    if (recurring) {
      const originalMs = shiftWallDays(instant(e.occurrenceDate ?? e.start, zone), tz, days);
      originalStartTime = { dateTime: rfc3339InZone(originalMs, tz), timeZone: tz };
      id = `${base}_${compactUtc(originalMs)}`;
    }
  }

  const organizer = e.organizer ? participant(e.organizer) : undefined;
  const attendees = attendeesOf(e);
  const url = nonEmpty(e.url)?.trim();

  const event: GoogleEvent = {
    kind: 'calendar#event',
    etag: `"0"`,
    id,
    status:
      e.status === 'cancelled' ? 'cancelled' : e.status === 'tentative' ? 'tentative' : 'confirmed',
    created: updated,
    updated,
    summary: e.title ?? undefined,
    description: nonEmpty(e.notes),
    location: nonEmpty(e.location),
    creator: organizer
      ? { email: organizer.email, displayName: organizer.displayName, self: organizer.self }
      : undefined,
    organizer: organizer
      ? { email: organizer.email, displayName: organizer.displayName, self: organizer.self }
      : undefined,
    start,
    end,
    recurringEventId: recurring ? base : undefined,
    originalStartTime,
    iCalUID: nonEmpty(e.externalId) ?? `${base}@google.com`,
    sequence: 0,
    attendees: attendees.length > 0 ? attendees : undefined,
    eventType: 'default',
  };
  if (url) {
    event.source = { title: 'Event link', url };
    if (MEET.test(url)) {
      event.hangoutLink = url;
      event.conferenceData = conference('hangoutsMeet', 'Google Meet', url);
    } else if (ZOOM.test(url)) {
      event.conferenceData = conference('addOn', 'Zoom Meeting', url);
    } else if (TEAMS.test(url)) {
      event.conferenceData = conference('addOn', 'Microsoft Teams Meeting', url);
    }
  }
  return stripUndefined(event);
}

function participant(p: FixtureParticipant): GoogleAttendee {
  return stripUndefined({
    email: emailOf(p),
    displayName: nonEmpty(p.name),
    self: p.self ? true : undefined,
    resource: p.type === 'room' || p.type === 'resource' ? true : undefined,
    responseStatus: responseStatus(p.status),
  });
}

function attendeesOf(e: FixtureEvent): GoogleAttendee[] {
  const listed = (e.attendees ?? []).map(participant);
  if (listed.length === 0) return [];
  const org = e.organizer ? participant(e.organizer) : undefined;
  const orgEmail = org?.email?.toLowerCase();
  let found = false;
  for (const a of listed) {
    if (orgEmail && a.email?.toLowerCase() === orgEmail) {
      a.organizer = true;
      found = true;
    }
  }
  if (org && !found && org.resource !== true) {
    // Google always lists the organizer; an organizer with no known response has accepted.
    const status = e.organizer?.status ?? 'unknown';
    listed.unshift({
      ...org,
      organizer: true,
      responseStatus: status === 'unknown' ? 'accepted' : org.responseStatus,
    });
  }
  return listed;
}

function conference(
  type: 'hangoutsMeet' | 'addOn',
  name: string,
  uri: string,
): NonNullable<GoogleEvent['conferenceData']> {
  return {
    entryPoints: [{ entryPointType: 'video', uri, label: uri.replace(/^https?:\/\//, '') }],
    conferenceSolution: { key: { type }, name },
    conferenceId: uri.split('/').pop()?.split('?')[0] ?? '',
  };
}

function stripUndefined<T extends object>(value: T): T {
  for (const key of Object.keys(value) as (keyof T)[]) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}
