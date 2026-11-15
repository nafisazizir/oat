import { describe, expect, it } from 'vitest';

import linkCases from '../../../fixtures/calendar/conference-links.json' with { type: 'json' };
import {
  CALENDAR_ACCESS_STATUSES,
  CalendarEventSchema,
  CONFERENCE_PROVIDERS,
  compareCalendarEvents,
  currentMeetingFor,
  detectConferenceLink,
  findConferenceLink,
  hasOtherAttendees,
  isAttending,
  isDeclined,
  isNotifiable,
  nextStartingSoonAt,
  selfAttendee,
  startingSoon,
  upcoming,
  type CalendarAttendee,
  type CalendarEvent,
  type CalendarEventInput,
} from './calendar.ts';

const MIN = 60_000;
const at = (iso: string) => new Date(iso);

const SELF: CalendarAttendee = {
  name: 'Alex Rivera',
  email: 'alex@oat.test',
  status: 'accepted',
  isSelf: true,
  isOrganizer: false,
};
const SAM: CalendarAttendee = {
  name: 'Sam Okafor',
  email: 'sam@oat.test',
  status: 'accepted',
  isSelf: false,
  isOrganizer: true,
};

/** A timed meeting with Sam, 17:00–17:30 UTC on Mon 16 Nov 2026, unless overridden. */
function ev(id: string, overrides: Partial<CalendarEventInput> = {}): CalendarEvent {
  return CalendarEventSchema.parse({
    id: `eventkit:${id}`,
    source: 'eventkit',
    calendar: { id: 'cal-work', title: 'Work', color: '#3B82F6' },
    title: id,
    start: '2026-11-16T17:00:00.000Z',
    end: '2026-11-16T17:30:00.000Z',
    allDay: false,
    allDayStart: null,
    allDayEnd: null,
    timeZone: 'America/Los_Angeles',
    location: null,
    url: null,
    conferenceUrl: null,
    conferenceProvider: null,
    status: 'confirmed',
    attendees: [SELF, SAM],
    recurrenceId: null,
    icalUid: null,
    ...overrides,
  });
}
const solo = (id: string, o: Partial<CalendarEventInput> = {}) => ev(id, { attendees: [], ...o });
const declined = (id: string, o: Partial<CalendarEventInput> = {}) =>
  ev(id, { attendees: [{ ...SELF, status: 'declined' }, SAM], ...o });
const allDay = (id: string, startDay: string, endDay: string, start: string, end: string) =>
  ev(id, { allDay: true, allDayStart: startDay, allDayEnd: endDay, start, end, timeZone: null });
const ids = (events: CalendarEvent[]) => events.map((e) => e.id.replace('eventkit:', ''));

describe('CalendarEventSchema', () => {
  it('parses a sidecar JSON line (ISO strings → Dates, unknown fields stripped)', () => {
    const line =
      '{"id":"eventkit:E9","source":"eventkit","calendar":{"id":"cal-work","title":"Work","color":"#3B82F6"},' +
      '"title":"Say \\"hi\\"","start":"2026-11-16T17:00:00.000Z","end":"2026-11-16T17:30:00.000Z","allDay":false,' +
      '"allDayStart":null,"allDayEnd":null,"timeZone":null,"location":null,"url":null,' +
      '"conferenceUrl":"https://meet.google.com/abc-defg-hij","conferenceProvider":"google_meet","status":"confirmed",' +
      '"attendees":[{"name":"Alex","email":"alex@oat.test","status":"needs_action","isSelf":true,"isOrganizer":false}],' +
      '"recurrenceId":null,"icalUid":"uid9","futureField":1}';
    const e = CalendarEventSchema.parse(JSON.parse(line));
    expect(e.start).toEqual(at('2026-11-16T17:00:00Z'));
    expect(e.title).toBe('Say "hi"');
    expect(e.attendees[0]?.status).toBe('needs_action');
    expect('futureField' in e).toBe(false);
  });

  it('accepts offsets and compares instants, not wall-clock text', () => {
    const tokyo = ev('tokyo', {
      start: '2026-11-17T02:00:00+09:00',
      end: '2026-11-17T03:00:00+09:00',
      timeZone: 'Asia/Tokyo',
    });
    expect(tokyo.start).toEqual(at('2026-11-16T17:00:00Z'));
  });

  it('rejects inconsistent events', () => {
    expect(() => ev('backwards', { end: '2026-11-16T16:00:00Z' })).toThrow(/end is before start/);
    expect(() => ev('half-all-day', { allDay: true })).toThrow(/allDayStart/);
    expect(() =>
      ev('days-without-flag', { allDayStart: '2026-11-16', allDayEnd: '2026-11-17' }),
    ).toThrow(/allDayStart/);
    expect(() => ev('link-without-provider', { conferenceUrl: 'https://zoom.us/j/1' })).toThrow(
      /go together/,
    );
    expect(() =>
      ev('bad-day', { allDay: true, allDayStart: '16/11/2026', allDayEnd: '2026-11-17' }),
    ).toThrow();
    expect(() => ev('bad-color', { calendar: { id: 'c', title: 'C', color: 'blue' } })).toThrow();
    expect(() => ev('bad-source', { source: 'outlook' as never })).toThrow();
  });

  it('exposes enum tuples shared with the sidecar', () => {
    expect(CONFERENCE_PROVIDERS).toEqual(['zoom', 'google_meet', 'teams']);
    expect(CALENDAR_ACCESS_STATUSES).toContain('not_determined');
  });
});

describe('conference links (shared cases with the Swift sidecar)', () => {
  it.each(linkCases.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const fields = c as { url?: string; location?: string; notes?: string };
    expect(detectConferenceLink(fields)).toEqual(c.expect);
  });

  it('has enough cases to mean something', () => {
    expect(linkCases.cases.length).toBeGreaterThanOrEqual(20);
  });

  it('treats null / empty fields as absent', () => {
    expect(detectConferenceLink({ url: null, location: '', notes: undefined })).toBeNull();
    expect(findConferenceLink('')).toBeNull();
  });
});

describe('attendance helpers', () => {
  it('finds self and declined state', () => {
    expect(selfAttendee(ev('a'))).toEqual(SELF);
    expect(selfAttendee(solo('s'))).toBeNull();
    expect(isDeclined(declined('d'))).toBe(true);
    expect(isDeclined(solo('s'))).toBe(false);
    expect(isAttending(ev('c', { status: 'cancelled' }))).toBe(false);
    expect(isAttending(ev('t', { status: 'tentative' }))).toBe(true);
    expect(hasOtherAttendees(ev('a', { attendees: [SELF] }))).toBe(false);
  });

  it('sorts by start, end, id', () => {
    const list = [
      ev('b'),
      ev('a'),
      ev('long', { end: '2026-11-16T18:00:00Z' }),
      ev('early', { start: '2026-11-16T16:00:00Z' }),
    ];
    expect(ids(list.sort(compareCalendarEvents))).toEqual(['early', 'a', 'b', 'long']);
  });
});

describe('currentMeetingFor (D-21)', () => {
  const meeting = ev('m'); // 17:00–17:30Z

  it('matches an event in progress', () => {
    expect(currentMeetingFor([meeting], at('2026-11-16T17:10:00Z'))?.id).toBe(meeting.id);
  });

  it('matches an event starting within 90 s (inclusive) but not 91 s', () => {
    expect(currentMeetingFor([meeting], new Date(meeting.start.getTime() - 90_000))).toBe(meeting);
    expect(currentMeetingFor([meeting], new Date(meeting.start.getTime() - 91_000))).toBeNull();
  });

  it('stops matching 15 min after the start (inclusive), even while still running', () => {
    const long = ev('long', { end: '2026-11-16T18:00:00Z' });
    expect(currentMeetingFor([long], at('2026-11-16T17:15:00Z'))).toBe(long);
    expect(currentMeetingFor([long], at('2026-11-16T17:15:01Z'))).toBeNull();
  });

  it('does not match an event that has ended', () => {
    const short = ev('short', { end: '2026-11-16T17:05:00Z' });
    expect(currentMeetingFor([short], at('2026-11-16T17:05:00Z'))).toBeNull();
    expect(currentMeetingFor([short], at('2026-11-16T17:04:59Z'))).toBe(short);
  });

  it('matches a zero-length event only before or at its start', () => {
    const zero = ev('zero', { end: '2026-11-16T17:00:00Z' });
    expect(currentMeetingFor([zero], at('2026-11-16T16:59:30Z'))).toBe(zero);
    expect(currentMeetingFor([zero], at('2026-11-16T17:00:30Z'))).toBeNull();
  });

  it('ignores all-day, cancelled and declined events', () => {
    const now = at('2026-11-16T17:05:00Z');
    expect(
      currentMeetingFor(
        [
          allDay(
            'offsite',
            '2026-11-16',
            '2026-11-17',
            '2026-11-16T08:00:00Z',
            '2026-11-17T08:00:00Z',
          ),
          ev('cancelled', { status: 'cancelled' }),
          declined('declined'),
        ],
        now,
      ),
    ).toBeNull();
    expect(currentMeetingFor([ev('tentative', { status: 'tentative' })], now)?.title).toBe(
      'tentative',
    );
  });

  it('back-to-back: joining the next meeting a minute early picks the next one', () => {
    const first = ev('first', { start: '2026-11-16T16:50:00Z', end: '2026-11-16T17:00:00Z' });
    const second = ev('second', { start: '2026-11-16T17:00:00Z', end: '2026-11-16T17:30:00Z' });
    expect(currentMeetingFor([first, second], at('2026-11-16T16:59:00Z'))).toBe(second);
  });

  it('overlapping: a meeting with people beats a solo block, then the latest start wins', () => {
    const focus = solo('focus', { start: '2026-11-16T17:00:00Z', end: '2026-11-16T18:00:00Z' });
    const sync = ev('sync', { start: '2026-11-16T16:55:00Z', end: '2026-11-16T17:15:00Z' });
    const now = at('2026-11-16T17:05:00Z');
    expect(currentMeetingFor([focus, sync], now)).toBe(sync);
    expect(currentMeetingFor([sync, focus], now)).toBe(sync);
    const later = ev('later', { start: '2026-11-16T17:04:00Z', end: '2026-11-16T17:20:00Z' });
    expect(currentMeetingFor([sync, later, focus], now)).toBe(later);
    // A solo event with a join link counts as meeting-like.
    const linked = solo('linked', {
      start: '2026-11-16T17:05:00Z',
      conferenceUrl: 'https://zoom.us/j/1',
      conferenceProvider: 'zoom',
    });
    expect(currentMeetingFor([sync, linked], now)).toBe(linked);
    // Only solo blocks: still named.
    expect(currentMeetingFor([focus], now)).toBe(focus);
  });

  it('breaks exact ties by id, independent of input order', () => {
    const a = ev('a');
    const b = ev('b');
    const now = at('2026-11-16T17:01:00Z');
    expect(currentMeetingFor([b, a], now)).toBe(a);
    expect(currentMeetingFor([a, b], now)).toBe(a);
  });

  it('works across the DST change (US clocks fall back 1 Nov 2026 at 09:00Z)', () => {
    // 01:30 PDT (08:30Z) to 01:30 PST (09:30Z): one hour of real time, the wall clock reads the same.
    const dst = ev('dst', { start: '2026-11-01T01:30:00-07:00', end: '2026-11-01T01:30:00-08:00' });
    expect(dst.end.getTime() - dst.start.getTime()).toBe(60 * MIN);
    expect(currentMeetingFor([dst], at('2026-11-01T09:05:00Z'))).toBeNull(); // 35 min after start
    expect(currentMeetingFor([dst], at('2026-11-01T08:40:00Z'))).toBe(dst);
  });

  it('returns null for no events', () => {
    expect(currentMeetingFor([], at('2026-11-16T17:00:00Z'))).toBeNull();
  });
});

describe('upcoming', () => {
  const now = at('2026-11-16T17:10:00Z');
  const events = [
    ev('later', { start: '2026-11-16T19:00:00Z', end: '2026-11-16T20:00:00Z' }),
    ev('now'), // 17:00–17:30, in progress
    ev('past', { start: '2026-11-16T15:00:00Z', end: '2026-11-16T16:00:00Z' }),
    ev('beyond', { start: '2026-11-17T19:00:00Z', end: '2026-11-17T20:00:00Z' }),
    ev('cancelled', {
      start: '2026-11-16T18:00:00Z',
      end: '2026-11-16T18:30:00Z',
      status: 'cancelled',
    }),
    declined('declined', { start: '2026-11-16T18:00:00Z', end: '2026-11-16T18:30:00Z' }),
    allDay('offsite', '2026-11-16', '2026-11-17', '2026-11-16T08:00:00Z', '2026-11-17T08:00:00Z'),
  ];

  it('lists in-progress and upcoming events within the horizon, sorted', () => {
    expect(ids(upcoming(events, now, 24 * 60 * MIN))).toEqual(['now', 'later']);
  });

  it('excludes events starting exactly at the horizon and ending exactly now', () => {
    const edge = [
      ev('ends-now', { end: '2026-11-16T17:10:00Z' }),
      ev('at-horizon', { start: '2026-11-16T18:10:00Z', end: '2026-11-16T18:20:00Z' }),
    ];
    expect(upcoming(edge, now, 60 * MIN)).toEqual([]);
  });

  it('can include all-day and not-attending events', () => {
    expect(ids(upcoming(events, now, 24 * 60 * MIN, { includeAllDay: true }))).toEqual([
      'offsite',
      'now',
      'later',
    ]);
    expect(ids(upcoming(events, now, 24 * 60 * MIN, { includeNotAttending: true }))).toEqual([
      'now',
      'cancelled',
      'declined',
      'later',
    ]);
  });

  it('all-day events follow their instants: an all-day event in Tokyo is over for a Pacific evening', () => {
    // 16 Nov in Asia/Tokyo is 15 Nov 15:00Z – 16 Nov 15:00Z.
    const tokyoDay = allDay(
      'jp-holiday',
      '2026-11-16',
      '2026-11-17',
      '2026-11-15T15:00:00Z',
      '2026-11-16T15:00:00Z',
    );
    expect(upcoming([tokyoDay], now, 60 * MIN, { includeAllDay: true })).toEqual([]);
    expect(
      upcoming([tokyoDay], at('2026-11-16T14:00:00Z'), 60 * MIN, { includeAllDay: true }),
    ).toHaveLength(1);
  });
});

describe('startingSoon / nextStartingSoonAt (D-21 notification)', () => {
  const meeting = ev('m'); // starts 17:00Z

  it('includes notifiable events starting within the next minute (inclusive)', () => {
    expect(startingSoon([meeting], at('2026-11-16T16:59:00Z'))).toEqual([meeting]);
    expect(startingSoon([meeting], at('2026-11-16T17:00:00Z'))).toEqual([meeting]);
    expect(startingSoon([meeting], at('2026-11-16T16:58:59Z'))).toEqual([]);
    expect(startingSoon([meeting], at('2026-11-16T17:00:01Z'))).toEqual([]);
    expect(startingSoon([meeting], at('2026-11-16T16:55:00Z'), 5 * MIN)).toEqual([meeting]);
  });

  it('needs other attendees, a title, and attendance; never all-day', () => {
    const now = at('2026-11-16T16:59:30Z');
    const notEligible = [
      solo('solo'),
      ev('only-self', { attendees: [SELF] }),
      ev('untitled', { title: '' }),
      declined('declined'),
      ev('cancelled', { status: 'cancelled' }),
      allDay('all-day', '2026-11-16', '2026-11-17', '2026-11-16T17:00:00Z', '2026-11-17T17:00:00Z'),
    ];
    for (const e of notEligible) expect(isNotifiable(e), e.id).toBe(false);
    expect(startingSoon(notEligible, now)).toEqual([]);
    // Someone else's event the user was invited to without a self entry still counts (attendee list known).
    expect(isNotifiable(ev('no-self', { attendees: [SAM] }))).toBe(true);
  });

  it('returns several simultaneous starts sorted', () => {
    const b = ev('b');
    const a = ev('a');
    expect(ids(startingSoon([b, a], at('2026-11-16T16:59:30Z')))).toEqual(['a', 'b']);
  });

  it('nextStartingSoonAt gives the next notification time for a scheduler', () => {
    const later = ev('later', { start: '2026-11-16T19:00:00Z', end: '2026-11-16T19:30:00Z' });
    expect(
      nextStartingSoonAt(
        [later, meeting, solo('solo', { start: '2026-11-16T16:30:00Z' })],
        at('2026-11-16T16:00:00Z'),
      ),
    ).toEqual(at('2026-11-16T16:59:00Z'));
    // Inside the lead window: now.
    expect(nextStartingSoonAt([meeting], at('2026-11-16T16:59:30Z'))).toEqual(
      at('2026-11-16T16:59:30Z'),
    );
    // Already started: nothing left.
    expect(nextStartingSoonAt([meeting], at('2026-11-16T17:00:00Z'))).toBeNull();
    expect(nextStartingSoonAt([], at('2026-11-16T17:00:00Z'))).toBeNull();
  });
});
