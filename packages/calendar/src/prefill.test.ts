import { describe, expect, it } from 'vitest';

import { parseEvents } from './fixture-source.ts';
import { calendarEventKey, MAX_PREFILL_PARTICIPANTS, notePrefill } from './prefill.ts';
import { eventInput } from './testing/events.ts';

const one = (...args: Parameters<typeof eventInput>) => parseEvents([eventInput(...args)])[0]!;

const person = (
  name: string | null,
  email: string | null,
  extra: { organizer?: boolean } = {},
) => ({
  name,
  email,
  status: 'accepted' as const,
  isSelf: false,
  isOrganizer: extra.organizer ?? false,
});

describe('calendarEventKey', () => {
  it('is the same for one meeting seen through EventKit and Google (iCal UID + start)', () => {
    const ek = one('standup', '2026-11-16T17:30:00Z', { icalUid: 'standup@x' });
    const google = one('g-standup', '2026-11-16T17:30:00Z', {
      icalUid: 'standup@x',
      source: 'google',
      id: 'google:cal-work/standup_20261116T173000Z',
    });
    expect(calendarEventKey(ek)).toBe('ical:standup@x@2026-11-16T17:30:00.000Z');
    expect(calendarEventKey(google)).toBe(calendarEventKey(ek));
  });

  it('differs per occurrence of a series and falls back to the source id without a UID', () => {
    const mon = one('standup', '2026-11-16T17:30:00Z', { icalUid: 'standup@x' });
    const tue = one('standup', '2026-11-17T17:30:00Z', { icalUid: 'standup@x' });
    expect(calendarEventKey(mon)).not.toBe(calendarEventKey(tue));
    expect(calendarEventKey(one('lunch', '2026-11-16T20:00:00Z'))).toBe('eventkit:lunch');
    const long = one('x', '2026-11-16T20:00:00Z', { icalUid: 'u'.repeat(2000) });
    expect(calendarEventKey(long)).toBe('eventkit:x');
  });
});

describe('calendarEventKey: all-day events', () => {
  it('keys by date, so EventKit (local midnight) and Google (date only) agree', () => {
    const allDay = {
      allDay: true,
      allDayStart: '2026-11-18',
      allDayEnd: '2026-11-19',
      icalUid: 'offsite@x',
    };
    const mac = one('offsite', '2026-11-18T08:00:00Z', {
      ...allDay,
      end: '2026-11-19T08:00:00Z',
    });
    const google = one('g-offsite', '2026-11-18T00:00:00Z', {
      ...allDay,
      source: 'google',
      end: '2026-11-19T00:00:00Z',
    });
    expect(calendarEventKey(mac)).toBe('ical:offsite@x@2026-11-18');
    expect(calendarEventKey(google)).toBe(calendarEventKey(mac));
  });
});

describe('notePrefill', () => {
  it('copies the title and everyone but me, organizer first, deduplicated by email', () => {
    const event = one('Design review', '2026-11-16T19:00:00Z', {
      title: '  Design   review ',
      icalUid: 'review@x',
      attendees: [
        { ...person('Me', 'me@oat.test'), isSelf: true },
        person('Sam', 'SAM@oat.test'),
        person(null, 'kim@oat.test'),
        person('Jordan Lee', 'jordan@oat.test', { organizer: true }),
        person('Sam again', 'sam@oat.test'),
        person(null, null),
      ],
    });
    expect(notePrefill(event)).toEqual({
      title: 'Design review',
      calendarEventKey: 'ical:review@x@2026-11-16T19:00:00.000Z',
      participants: [
        { name: 'Jordan Lee', email: 'jordan@oat.test' },
        { name: 'Sam', email: 'sam@oat.test' },
        { name: 'kim@oat.test', email: 'kim@oat.test' },
      ],
    });
  });

  it('caps a company-wide invite', () => {
    const attendees = Array.from({ length: MAX_PREFILL_PARTICIPANTS + 20 }, (_, i) =>
      person(`P${i}`, `p${i}@oat.test`),
    );
    const event = one('All hands', '2026-11-16T19:00:00Z', { attendees });
    expect(notePrefill(event).participants).toHaveLength(MAX_PREFILL_PARTICIPANTS);
  });
});
