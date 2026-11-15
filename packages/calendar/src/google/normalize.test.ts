import { readFileSync } from 'node:fs';

import { type CalendarFixture, googleDataFromFixture } from '@oat/mocks';
import type { CalendarEvent } from '@oat/core';
import { describe, expect, it } from 'vitest';

import week from '../../../../fixtures/calendar/week.json' with { type: 'json' };
import { parseEventLines } from '../fixture-source.ts';
import { type GoogleEvent, GoogleCalendarListEntrySchema, GoogleEventSchema } from './api.ts';
import {
  calendarInfoFromListEntry,
  type GoogleCalendarInfo,
  normalizeGoogleEvent,
} from './normalize.ts';

/**
 * Golden EventKit output: `oat-audio calendar events --fixture fixtures/calendar/week.json
 * --from 2026-11-15T00:00:00Z --to 2026-11-23T00:00:00Z` (the sidecar int test checks the live binary still
 * prints exactly this).
 */
const EVENTKIT = parseEventLines(
  readFileSync(
    new URL('../../../../fixtures/calendar/week.eventkit.jsonl', import.meta.url),
    'utf8',
  ),
);

/** The same fixture week as the Google Calendar API mock serves it, through the Google normaliser. */
function googleWeek(): CalendarEvent[] {
  const data = googleDataFromFixture(week as CalendarFixture);
  const out: CalendarEvent[] = [];
  for (const raw of data.calendars) {
    const info = calendarInfoFromListEntry(GoogleCalendarListEntrySchema.parse(raw));
    for (const item of data.events.get(raw.id) ?? []) {
      const event = normalizeGoogleEvent(GoogleEventSchema.parse(item), info);
      if (item.eventType !== 'default') {
        // Google-only status blocks (working location, OOO, focus time): never events.
        expect(event, `event ${item.id}`).toBeNull();
        continue;
      }
      expect(event, `event ${item.id}`).not.toBeNull();
      out.push(event!);
    }
  }
  return out;
}

const order = (a: CalendarEvent, b: CalendarEvent) =>
  a.start.getTime() - b.start.getTime() ||
  a.end.getTime() - b.end.getTime() ||
  a.title.localeCompare(b.title);

/** Source-specific fields (ids are per source by design) dropped; everything else must match. */
function comparable(e: CalendarEvent) {
  const { id: _id, source: _source, recurrenceId: _recurrenceId, icalUid, ...rest } = e;
  // Google always has an iCalUID; EventKit-only local events have none.
  return { ...rest, icalUid: icalUid?.endsWith('@google.com') ? null : icalUid };
}

/** Index of each event's recurring series in sorted order (null for one-offs). */
function seriesShape(events: CalendarEvent[]) {
  const ids: string[] = [];
  return events.map((e) => {
    if (!e.recurrenceId) return null;
    if (!ids.includes(e.recurrenceId)) ids.push(e.recurrenceId);
    return ids.indexOf(e.recurrenceId);
  });
}

describe('Google normaliser vs EventKit normaliser (fixtures/calendar/week.json)', () => {
  it('normalises the fixture week identically, field by field', () => {
    const eventkit = [...EVENTKIT].sort(order);
    const google = googleWeek().sort(order);
    expect(eventkit).toHaveLength(17);
    expect(google.map(comparable)).toEqual(eventkit.map(comparable));
  });

  it('keeps the same recurring series, with source-prefixed ids', () => {
    const eventkit = [...EVENTKIT].sort(order);
    const google = googleWeek().sort(order);
    expect(seriesShape(google)).toEqual(seriesShape(eventkit));
    expect(google.every((e) => e.source === 'google' && e.id.startsWith('google:'))).toBe(true);
    const standups = google.filter((e) => e.title.startsWith('Daily standup'));
    expect(standups.map((e) => e.id)).toEqual([
      'google:cal-work/standup_20261116T173000Z',
      'google:cal-work/standup_20261117T173000Z',
      'google:cal-work/standup_20261118T173000Z', // moved occurrence keeps its original-start id
    ]);
    expect(new Set(standups.map((e) => e.recurrenceId))).toEqual(
      new Set(['google:cal-work/standup']),
    );
    expect(new Set(google.map((e) => e.id)).size).toBe(google.length);
  });
});

// ---------------------------------------------------------------------------------------------------------

const CAL: GoogleCalendarInfo = {
  id: 'alex@oat.test',
  title: 'alex@oat.test',
  color: '#9FE1E7',
  timeZone: 'America/Los_Angeles',
};

function event(overrides: Partial<GoogleEvent> = {}): GoogleEvent {
  return {
    id: 'evt1',
    status: 'confirmed',
    summary: '  Planning  ',
    start: { dateTime: '2026-11-16T10:00:00-08:00', timeZone: 'America/Los_Angeles' },
    end: { dateTime: '2026-11-16T10:30:00-08:00', timeZone: 'America/Los_Angeles' },
    iCalUID: 'evt1@google.com',
    ...overrides,
  };
}

describe('normalizeGoogleEvent', () => {
  it('maps a timed event', () => {
    expect(normalizeGoogleEvent(event({ location: '  ' }), CAL)).toEqual({
      id: 'google:alex@oat.test/evt1',
      source: 'google',
      calendar: { id: 'alex@oat.test', title: 'alex@oat.test', color: '#9FE1E7' },
      title: 'Planning',
      start: new Date('2026-11-16T18:00:00Z'),
      end: new Date('2026-11-16T18:30:00Z'),
      allDay: false,
      allDayStart: null,
      allDayEnd: null,
      timeZone: 'America/Los_Angeles',
      location: null,
      url: null,
      conferenceUrl: null,
      conferenceProvider: null,
      status: 'confirmed',
      attendees: [],
      recurrenceId: null,
      icalUid: 'evt1@google.com',
    });
  });

  it('defaults a timed event’s zone to the calendar’s', () => {
    const e = normalizeGoogleEvent(
      event({
        start: { dateTime: '2026-11-16T18:00:00Z' },
        end: { dateTime: '2026-11-16T19:00:00Z' },
      }),
      CAL,
    );
    expect(e?.timeZone).toBe('America/Los_Angeles');
  });

  it('maps all-day events to midnights in the calendar zone (end exclusive, missing end = one day)', () => {
    const offsite = normalizeGoogleEvent(
      event({ start: { date: '2026-11-17' }, end: { date: '2026-11-19' } }),
      CAL,
    );
    expect(offsite).toMatchObject({
      allDay: true,
      allDayStart: '2026-11-17',
      allDayEnd: '2026-11-19',
      timeZone: null,
      start: new Date('2026-11-17T08:00:00Z'),
      end: new Date('2026-11-19T08:00:00Z'),
    });
    const noEnd = normalizeGoogleEvent(event({ start: { date: '2026-03-08' }, end: {} }), CAL);
    // US DST starts on 8 March 2026: the next midnight is 23 h later.
    expect(noEnd).toMatchObject({ allDayEnd: '2026-03-09' });
    expect(noEnd!.end.getTime() - noEnd!.start.getTime()).toBe(23 * 3_600_000);
  });

  it('finds the join link: conferenceData, then hangoutLink, then url → location → description', () => {
    const zoom = 'https://acme.zoom.us/j/123456789';
    const meet = 'https://meet.google.com/abc-defg-hij';
    const both = normalizeGoogleEvent(
      event({
        hangoutLink: meet,
        conferenceData: {
          entryPoints: [
            { entryPointType: 'phone', uri: 'tel:+1-555-0100' },
            { entryPointType: 'video', uri: zoom },
          ],
        },
      }),
      CAL,
    );
    expect(both).toMatchObject({ conferenceUrl: zoom, conferenceProvider: 'zoom' });

    // An unknown conferencing product in conferenceData falls through to the next field.
    const webex = normalizeGoogleEvent(
      event({
        conferenceData: {
          entryPoints: [{ entryPointType: 'video', uri: 'https://x.webex.com/m/1' }],
        },
        hangoutLink: meet,
      }),
      CAL,
    );
    expect(webex).toMatchObject({ conferenceUrl: meet, conferenceProvider: 'google_meet' });

    const fromDescription = normalizeGoogleEvent(
      event({
        location: 'Room 4',
        description:
          'Join <a href="https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0">here</a>',
      }),
      CAL,
    );
    expect(fromDescription).toMatchObject({
      conferenceProvider: 'teams',
      conferenceUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0',
      location: 'Room 4',
    });

    const fromSource = normalizeGoogleEvent(
      event({ source: { url: meet, title: 'link' }, location: zoom }),
      CAL,
    );
    expect(fromSource).toMatchObject({ url: meet, conferenceProvider: 'google_meet' });
  });

  it('maps attendees: resources dropped, emails lower-cased and de-duplicated, statuses mapped', () => {
    const e = normalizeGoogleEvent(
      event({
        organizer: { email: 'Sam@Oat.test', displayName: 'Sam' },
        attendees: [
          {
            email: 'room@resource.calendar.google.com',
            resource: true,
            responseStatus: 'accepted',
          },
          {
            email: 'ALEX@oat.test',
            displayName: 'Alex',
            self: true,
            responseStatus: 'needsAction',
          },
          { email: 'alex@oat.test', responseStatus: 'accepted' },
          { email: 'sam@oat.test', displayName: 'Sam', responseStatus: 'tentative' },
          { email: 'kim@oat.test', responseStatus: 'declined' },
          { responseStatus: 'whatever' },
        ],
      }),
      CAL,
    );
    expect(e?.attendees).toEqual([
      {
        name: 'Alex',
        email: 'alex@oat.test',
        status: 'needs_action',
        isSelf: true,
        isOrganizer: false,
      },
      { name: 'Sam', email: 'sam@oat.test', status: 'tentative', isSelf: false, isOrganizer: true },
      { name: null, email: 'kim@oat.test', status: 'declined', isSelf: false, isOrganizer: false },
      { name: null, email: null, status: 'unknown', isSelf: false, isOrganizer: false },
    ]);
  });

  it('prepends an unlisted organizer when there are attendees, but not for solo events', () => {
    const withGuests = normalizeGoogleEvent(
      event({
        organizer: { email: 'priya@oat.test', displayName: 'Priya' },
        attendees: [{ email: 'alex@oat.test', self: true, responseStatus: 'accepted' }],
      }),
      CAL,
    );
    expect(withGuests?.attendees[0]).toEqual({
      name: 'Priya',
      email: 'priya@oat.test',
      status: 'accepted',
      isSelf: false,
      isOrganizer: true,
    });
    const solo = normalizeGoogleEvent(
      event({ organizer: { email: 'alex@oat.test', self: true } }),
      CAL,
    );
    expect(solo?.attendees).toEqual([]);
    // A calendar (not a person) as organizer is never prepended.
    const shared = normalizeGoogleEvent(
      event({
        organizer: { email: 'team123@group.calendar.google.com', displayName: 'Team' },
        attendees: [{ email: 'alex@oat.test', self: true, responseStatus: 'accepted' }],
      }),
      CAL,
    );
    expect(shared?.attendees.map((a) => a.email)).toEqual(['alex@oat.test']);
  });

  it('maps status and recurrence', () => {
    expect(normalizeGoogleEvent(event({ status: 'tentative' }), CAL)?.status).toBe('tentative');
    expect(normalizeGoogleEvent(event({ status: 'cancelled' }), CAL)?.status).toBe('cancelled');
    expect(normalizeGoogleEvent(event({ status: undefined }), CAL)?.status).toBe('confirmed');
    expect(
      normalizeGoogleEvent(event({ id: 's_20261116T180000Z', recurringEventId: 's' }), CAL)
        ?.recurrenceId,
    ).toBe('google:alex@oat.test/s');
    expect(
      normalizeGoogleEvent(event({ id: 'master', recurrence: ['RRULE:FREQ=WEEKLY'] }), CAL)
        ?.recurrenceId,
    ).toBe('google:alex@oat.test/master');
  });

  it('skips working-location, out-of-office and focus-time blocks (not meetings)', () => {
    for (const eventType of ['workingLocation', 'outOfOffice', 'focusTime']) {
      expect(normalizeGoogleEvent(event({ eventType }), CAL), eventType).toBeNull();
    }
    for (const eventType of ['default', 'birthday', 'fromGmail', undefined]) {
      expect(normalizeGoogleEvent(event({ eventType }), CAL), String(eventType)).not.toBeNull();
    }
  });

  it('returns null for events it can’t show', () => {
    expect(normalizeGoogleEvent({ id: 'gone', status: 'cancelled' }, CAL)).toBeNull();
    expect(
      normalizeGoogleEvent(event({ start: { dateTime: 'nonsense' }, end: { dateTime: 'x' } }), CAL),
    ).toBeNull();
    expect(
      normalizeGoogleEvent(event({ start: { date: '2026-11-17' }, end: { date: '2026-11-18' } }), {
        ...CAL,
        timeZone: 'Not/AZone',
      }),
    ).toBeNull();
  });

  it('keeps end ≥ start', () => {
    const e = normalizeGoogleEvent(event({ end: { dateTime: '2026-11-16T09:00:00-08:00' } }), CAL);
    expect(e?.end).toEqual(e?.start);
  });
});

describe('calendarInfoFromListEntry', () => {
  it('prefers summaryOverride, upper-cases valid colours, keeps the zone', () => {
    expect(
      calendarInfoFromListEntry({
        id: 'c1',
        summary: 'Team',
        summaryOverride: 'My team',
        backgroundColor: '#9fe1e7',
        timeZone: 'Europe/Berlin',
      }),
    ).toEqual({ id: 'c1', title: 'My team', color: '#9FE1E7', timeZone: 'Europe/Berlin' });
    expect(calendarInfoFromListEntry({ id: 'c2', backgroundColor: 'teal' })).toEqual({
      id: 'c2',
      title: 'c2',
      color: null,
      timeZone: null,
    });
  });
});
