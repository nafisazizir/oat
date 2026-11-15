import { type CalendarEvent, compareCalendarEvents } from '@oat/core';

import { calendarEventKey } from './prefill.ts';

/**
 * Merges events from several sources (e.g. EventKit + Google, or two Google calendars showing the same
 * invite) into one sorted list with one entry per meeting occurrence: events sharing an `icalUid` and start
 * time (all-day: start date) are the same meeting, and the copy from the earliest list wins. Events without an `icalUid` are kept.
 */
export function mergeCalendarEvents(lists: readonly (readonly CalendarEvent[])[]): CalendarEvent[] {
  const seen = new Set<string>();
  const out: CalendarEvent[] = [];
  for (const list of lists) {
    for (const event of list) {
      if (event.icalUid) {
        // The meeting key (`calendarEventKey`): UID + start, all-day by date.
        const key = calendarEventKey(event);
        if (seen.has(key)) continue;
        seen.add(key);
      }
      out.push(event);
    }
  }
  return out.sort(compareCalendarEvents);
}
