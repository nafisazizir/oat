/**
 * Google Calendar event → the shared `CalendarEvent` (`@oat/core`), following the same rules as the EventKit
 * normaliser in the sidecar (`native/oat-audio/PROTOCOL.md` → "Calendar"), so one meeting looks the same
 * whichever source it came through (`google-normalize.test.ts` runs the calendar fixture week through both).
 *
 * - `id` = `google:<calendarId>/<eventId>` (instance ids are already unique per occurrence);
 *   `recurrenceId` = `google:<calendarId>/<recurringEventId>` for instances (or the event's own id for a series
 *   master), else null. `icalUid` = `iCalUID`.
 * - Timed: `start/end.dateTime`, `timeZone` = the event's zone, else the calendar's. All-day (`date`):
 *   midnights in the calendar's zone, `allDayStart/End` the days (end exclusive), `timeZone` null.
 * - Title/location trimmed (blank → `""` / null). `url` = `source.url` (Google's equivalent of EventKit's URL;
 *   `htmlLink` is a Calendar page, not the meeting).
 * - Join link: Meet/Zoom/Teams from `conferenceData` video entry points, then `hangoutLink`, then
 *   `detectConferenceLink` over url → location → description.
 * - Attendees: resources dropped, emails lower-cased, de-duplicated by email; `responseStatus` → status
 *   (`needsAction` → `needs_action`); `self` → isSelf. The organizer is flagged, or prepended (as accepted) when
 *   there are attendees but Google didn't list them. Events without attendees have `[]` (solo).
 * - `status`: `cancelled` / `tentative` / else `confirmed`.
 * - Not meetings, so not events here (null): `eventType` `workingLocation` ("Office 9–17" blocks),
 *   `outOfOffice` and `focusTime` (`NON_MEETING_EVENT_TYPES`). EventKit doesn't surface the first; the
 *   others would otherwise show as upcoming and could name a meeting (D-21).
 */
import {
  type AttendeeStatus,
  type CalendarAttendee,
  type CalendarEvent,
  CalendarEventSchema,
  type CalendarEventStatus,
  type ConferenceLink,
  detectConferenceLink,
  findConferenceLink,
} from '@oat/core';

import type { GoogleAttendee, GoogleCalendarListEntry, GoogleEvent } from './api.ts';
import { addDays, midnightIn } from './time.ts';

/** What the normaliser needs to know about the calendar an event came from. */
export interface GoogleCalendarInfo {
  id: string;
  title: string;
  /** `#RRGGBB`. */
  color: string | null;
  /** IANA zone (all-day events are midnights here; also the default for timed events without one). */
  timeZone: string | null;
}

const COLOR = /^#[0-9a-f]{6}$/i;

/** Google event types that are status blocks, not meetings. */
export const NON_MEETING_EVENT_TYPES: ReadonlySet<string> = new Set([
  'workingLocation',
  'outOfOffice',
  'focusTime',
]);

const nonEmpty = (s: string | null | undefined): string | null => {
  const t = s?.trim();
  return t ? t : null;
};

export function calendarInfoFromListEntry(entry: GoogleCalendarListEntry): GoogleCalendarInfo {
  const color = entry.backgroundColor?.trim();
  return {
    id: entry.id,
    title: nonEmpty(entry.summaryOverride) ?? nonEmpty(entry.summary) ?? entry.id,
    color: color && COLOR.test(color) ? color.toUpperCase() : null,
    timeZone: nonEmpty(entry.timeZone),
  };
}

export function googleAttendeeStatus(status: string | undefined): AttendeeStatus {
  switch (status) {
    case 'accepted':
      return 'accepted';
    case 'declined':
      return 'declined';
    case 'tentative':
      return 'tentative';
    case 'needsAction':
      return 'needs_action';
    default:
      return 'unknown';
  }
}

function eventStatus(status: string | undefined): CalendarEventStatus {
  return status === 'cancelled' ? 'cancelled' : status === 'tentative' ? 'tentative' : 'confirmed';
}

function conferenceLink(event: GoogleEvent, url: string | null): ConferenceLink | null {
  for (const entry of event.conferenceData?.entryPoints ?? []) {
    if (entry.entryPointType !== 'video' || !entry.uri) continue;
    const link = findConferenceLink(entry.uri);
    if (link) return link;
  }
  const hangout = event.hangoutLink ? findConferenceLink(event.hangoutLink) : null;
  if (hangout) return hangout;
  return detectConferenceLink({ url, location: event.location, notes: event.description });
}

function isCalendarAddress(email: string): boolean {
  return /@(?:group\.)?(?:v\.)?calendar\.google\.com$/i.test(email);
}

function attendees(event: GoogleEvent): CalendarAttendee[] {
  const organizerEmail = nonEmpty(event.organizer?.email)?.toLowerCase() ?? null;
  const out: CalendarAttendee[] = [];
  const seen = new Set<string>();
  let organizerListed = false;
  for (const a of event.attendees ?? ([] as GoogleAttendee[])) {
    if (a.resource) continue;
    const email = nonEmpty(a.email)?.toLowerCase() ?? null;
    if (email) {
      if (seen.has(email)) continue;
      seen.add(email);
    }
    const isOrganizer = a.organizer === true || (email !== null && email === organizerEmail);
    if (isOrganizer) organizerListed = true;
    out.push({
      name: nonEmpty(a.displayName),
      email,
      status: googleAttendeeStatus(a.responseStatus),
      isSelf: a.self === true,
      isOrganizer,
    });
  }
  const organizer = event.organizer;
  const organizerName = nonEmpty(organizer?.displayName);
  if (
    out.length > 0 &&
    !organizerListed &&
    organizer &&
    (organizerEmail || organizerName) &&
    !(organizerEmail && isCalendarAddress(organizerEmail))
  ) {
    // Organizers implicitly attend.
    out.unshift({
      name: organizerName,
      email: organizerEmail,
      status: 'accepted',
      isSelf: organizer.self === true,
      isOrganizer: true,
    });
  }
  return out;
}

/**
 * Normalises one event. Returns null when it isn't shown: a non-meeting event type, a deleted stub without
 * times, or data that doesn't form a valid `CalendarEvent` (e.g. an unknown time zone).
 */
export function normalizeGoogleEvent(
  event: GoogleEvent,
  calendar: GoogleCalendarInfo,
): CalendarEvent | null {
  if (event.eventType && NON_MEETING_EVENT_TYPES.has(event.eventType)) return null;
  const { start, end } = event;
  if (!start || !end || (!start.dateTime && !start.date)) return null;
  try {
    const allDay = !start.dateTime;
    let startAt: Date;
    let endAt: Date;
    let allDayStart: string | null = null;
    let allDayEnd: string | null = null;
    let timeZone: string | null = null;
    if (allDay) {
      const zone = calendar.timeZone ?? 'UTC';
      allDayStart = start.date!;
      allDayEnd = end.date && end.date > allDayStart ? end.date : addDays(allDayStart, 1);
      startAt = midnightIn(allDayStart, zone);
      endAt = midnightIn(allDayEnd, zone);
    } else {
      startAt = new Date(start.dateTime!);
      const endTime = end.dateTime ? new Date(end.dateTime) : startAt;
      endAt = endTime.getTime() < startAt.getTime() ? startAt : endTime;
      timeZone = nonEmpty(start.timeZone) ?? calendar.timeZone;
    }

    const url = nonEmpty(event.source?.url);
    const link = conferenceLink(event, url);
    const recurrenceBase = event.recurringEventId ?? (event.recurrence?.length ? event.id : null);
    const parsed = CalendarEventSchema.safeParse({
      id: `google:${calendar.id}/${event.id}`,
      source: 'google',
      calendar: { id: calendar.id, title: calendar.title, color: calendar.color },
      title: (event.summary ?? '').trim(),
      start: startAt,
      end: endAt,
      allDay,
      allDayStart,
      allDayEnd,
      timeZone,
      location: nonEmpty(event.location),
      url,
      conferenceUrl: link?.url ?? null,
      conferenceProvider: link?.provider ?? null,
      status: eventStatus(event.status),
      attendees: attendees(event),
      recurrenceId: recurrenceBase ? `google:${calendar.id}/${recurrenceBase}` : null,
      icalUid: nonEmpty(event.iCalUID),
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // RangeError: unknown time zone, invalid date
  }
}
