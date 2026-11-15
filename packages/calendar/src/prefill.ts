import type { CalendarEvent } from '@oat/core';

/**
 * Meeting notes from calendar events (7.3): what a note made from an event is pre-filled with, and the key
 * that ties the note to the meeting (`meeting.calendar_event_id`), shared by the desktop and the web.
 *
 * The key is the meeting occurrence, not one source's event id: the same invite seen through EventKit on the
 * Mac and through Google on the web shares its iCalendar UID and start (`mergeCalendarEvents` uses the same
 * rule), so a note started on one finds the note started on the other instead of making a second one. Events
 * without a UID fall back to their source id.
 */

/** Longest key stored (`meeting.calendar_event_id` allows 1024). */
const MAX_KEY = 1000;
/** Most attendees copied into a note (the web's participant cap). */
export const MAX_PREFILL_PARTICIPANTS = 300;

/**
 * `ical:<uid>@<start ISO>` (all-day: `ical:<uid>@<YYYY-MM-DD>` — EventKit's local midnight and Google's date-only
 * start then agree), else the event's own (source-prefixed) id. A rescheduled occurrence gets a new key (its
 * start moved): its note no longer matches it (known limitation, D-31).
 */
export function calendarEventKey(
  event: Pick<CalendarEvent, 'id' | 'icalUid' | 'start'> &
    Partial<Pick<CalendarEvent, 'allDay' | 'allDayStart'>>,
): string {
  if (event.icalUid) {
    const when = event.allDay && event.allDayStart ? event.allDayStart : event.start.toISOString();
    const key = `ical:${event.icalUid}@${when}`;
    if (key.length <= MAX_KEY) return key;
  }
  return event.id.slice(0, MAX_KEY);
}

export interface PrefillParticipant {
  name: string;
  /** Lower-cased. */
  email: string | null;
}

export interface NotePrefill {
  /** The event's title, one line; empty when the event has none. */
  title: string;
  calendarEventKey: string;
  /** Everyone invited except me (I'm the note's owner), organizer first, one entry per email. */
  participants: PrefillParticipant[];
}

/** What a meeting note made from `event` starts with. */
export function notePrefill(event: CalendarEvent): NotePrefill {
  const seen = new Set<string>();
  const participants: PrefillParticipant[] = [];
  const people = [...event.attendees].sort((a, b) => Number(b.isOrganizer) - Number(a.isOrganizer));
  for (const a of people) {
    if (a.isSelf) continue;
    const email = a.email?.trim().toLowerCase() || null;
    const name = a.name?.replace(/\s+/g, ' ').trim() || email;
    if (!name) continue;
    const dedupe = email ?? `name:${name}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    participants.push({ name: name.slice(0, 200), email });
    if (participants.length >= MAX_PREFILL_PARTICIPANTS) break;
  }
  return {
    title: event.title.replace(/\s+/g, ' ').trim(),
    calendarEventKey: calendarEventKey(event),
    participants,
  };
}
