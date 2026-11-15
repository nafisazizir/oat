import { type CalendarEvent, compareCalendarEvents } from '@oat/core';

/**
 * Merges events from several sources (e.g. EventKit + Google, or two Google calendars showing the same
 * invite) into one sorted list with one entry per meeting occurrence: events sharing an `icalUid` and start
 * time are the same meeting, and the copy from the earliest list wins. Events without an `icalUid` are kept.
 */
export function mergeCalendarEvents(lists: readonly (readonly CalendarEvent[])[]): CalendarEvent[] {
  const seen = new Set<string>();
  const out: CalendarEvent[] = [];
  for (const list of lists) {
    for (const event of list) {
      if (event.icalUid) {
        const key = `${event.icalUid}\u0000${event.start.getTime()}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      out.push(event);
    }
  }
  return out.sort(compareCalendarEvents);
}
