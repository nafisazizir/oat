import type { CalendarEventInput } from '@oat/core';

/** A normalised event in JSON form for tests: a 30-min meeting with one other attendee, unless overridden. */
export function eventInput(
  id: string,
  start: string,
  overrides: Partial<CalendarEventInput> = {},
): CalendarEventInput {
  const s = new Date(start);
  return {
    id: `eventkit:${id}`,
    source: 'eventkit',
    calendar: { id: 'cal-work', title: 'Work', color: '#3B82F6' },
    title: id,
    start: s.toISOString(),
    end: new Date(s.getTime() + 30 * 60_000).toISOString(),
    allDay: false,
    allDayStart: null,
    allDayEnd: null,
    timeZone: null,
    location: null,
    url: null,
    conferenceUrl: null,
    conferenceProvider: null,
    status: 'confirmed',
    attendees: [
      {
        name: 'Alex',
        email: 'alex@oat.test',
        status: 'accepted',
        isSelf: true,
        isOrganizer: false,
      },
      { name: 'Sam', email: 'sam@oat.test', status: 'accepted', isSelf: false, isOrganizer: true },
    ],
    recurrenceId: null,
    icalUid: null,
    ...overrides,
  };
}
