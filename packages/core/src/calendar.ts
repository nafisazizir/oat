/**
 * Calendar events (SPEC §4 Calendar, task 7.1): one normalised `CalendarEvent` shape for every source —
 * macOS EventKit via the `oat-audio calendar` sidecar commands now, Google Calendar later (7.4) — plus pure
 * helpers for "which meeting is this?" (D-21) and "what's coming up?".
 *
 * The JSON a sidecar `calendar events` line carries parses directly with `CalendarEventSchema` (ISO strings
 * are coerced to `Date`s). Field rules are in `native/oat-audio/PROTOCOL.md` → "Calendar".
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------------------------------------

export const CALENDAR_SOURCES = ['eventkit', 'google'] as const;
export const CalendarSourceKindSchema = z.enum(CALENDAR_SOURCES);
export type CalendarSourceKind = z.infer<typeof CalendarSourceKindSchema>;

/** Attendee response (Google's `needsAction` is `needs_action`). */
export const ATTENDEE_STATUSES = [
  'accepted',
  'declined',
  'tentative',
  'needs_action',
  'unknown',
] as const;
export const AttendeeStatusSchema = z.enum(ATTENDEE_STATUSES);
export type AttendeeStatus = z.infer<typeof AttendeeStatusSchema>;

export const CALENDAR_EVENT_STATUSES = ['confirmed', 'tentative', 'cancelled'] as const;
export const CalendarEventStatusSchema = z.enum(CALENDAR_EVENT_STATUSES);
export type CalendarEventStatus = z.infer<typeof CalendarEventStatusSchema>;

export const CONFERENCE_PROVIDERS = ['zoom', 'google_meet', 'teams'] as const;
export const ConferenceProviderSchema = z.enum(CONFERENCE_PROVIDERS);
export type ConferenceProvider = z.infer<typeof ConferenceProviderSchema>;

/** Calendar permission (`oat-audio calendar status`). Only `full_access` can read events. */
export const CALENDAR_ACCESS_STATUSES = [
  'full_access',
  'write_only',
  'denied',
  'restricted',
  'not_determined',
  'unknown',
] as const;
export const CalendarAccessStatusSchema = z.enum(CALENDAR_ACCESS_STATUSES);
export type CalendarAccessStatus = z.infer<typeof CalendarAccessStatusSchema>;

export const CalendarAccessSchema = z.object({
  status: CalendarAccessStatusSchema,
  canRead: z.boolean(),
});
export type CalendarAccess = z.infer<typeof CalendarAccessSchema>;

// ---------------------------------------------------------------------------------------------------------
// CalendarEvent
// ---------------------------------------------------------------------------------------------------------

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const CalendarAttendeeSchema = z.object({
  name: z.string().nullable(),
  /** Lower-cased. */
  email: z.string().nullable(),
  status: AttendeeStatusSchema,
  /** The signed-in user (EventKit `isCurrentUser`, Google `self`). */
  isSelf: z.boolean(),
  isOrganizer: z.boolean(),
});
export type CalendarAttendee = z.infer<typeof CalendarAttendeeSchema>;

export const CalendarRefSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  /** `#RRGGBB` (sRGB). */
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable(),
});
export type CalendarRef = z.infer<typeof CalendarRefSchema>;

export const CalendarEventSchema = z
  .object({
    /** Unique per occurrence and source-prefixed (`eventkit:…`, `google:…`). */
    id: z.string().min(1),
    source: CalendarSourceKindSchema,
    calendar: CalendarRefSchema,
    /** Trimmed; may be empty. */
    title: z.string(),
    start: z.coerce.date(),
    /** `>= start`. All-day: the midnight after the last day. */
    end: z.coerce.date(),
    allDay: z.boolean(),
    /** All-day only (else null): first day and the day after the last day, `YYYY-MM-DD`. */
    allDayStart: day.nullable(),
    allDayEnd: day.nullable(),
    /** IANA zone the event was scheduled in; null for floating / all-day events. */
    timeZone: z.string().nullable(),
    location: z.string().nullable(),
    url: z.string().nullable(),
    /** Zoom / Meet / Teams join link found in url → location → notes (`detectConferenceLink`). */
    conferenceUrl: z.string().nullable(),
    conferenceProvider: ConferenceProviderSchema.nullable(),
    status: CalendarEventStatusSchema,
    /** People only (rooms/resources dropped), organizer included and flagged. Empty for solo events. */
    attendees: z.array(CalendarAttendeeSchema),
    /** Shared by every occurrence of a recurring series; null for one-off events. */
    recurrenceId: z.string().nullable(),
    /** iCalendar UID when known — the same meeting seen through two sources shares it. */
    icalUid: z.string().nullable(),
  })
  .superRefine((e, ctx) => {
    if (e.end.getTime() < e.start.getTime())
      ctx.addIssue({ code: 'custom', path: ['end'], message: 'end is before start' });
    if (e.allDay !== (e.allDayStart !== null && e.allDayEnd !== null))
      ctx.addIssue({
        code: 'custom',
        path: ['allDayStart'],
        message: 'allDayStart/allDayEnd are set exactly when allDay is true',
      });
    if ((e.conferenceUrl === null) !== (e.conferenceProvider === null))
      ctx.addIssue({
        code: 'custom',
        path: ['conferenceProvider'],
        message: 'conferenceUrl and conferenceProvider go together',
      });
  });
export type CalendarEvent = z.infer<typeof CalendarEventSchema>;
/** The JSON form (ISO strings for dates), e.g. one sidecar output line. */
export type CalendarEventInput = z.input<typeof CalendarEventSchema>;

// ---------------------------------------------------------------------------------------------------------
// Conference links
// ---------------------------------------------------------------------------------------------------------

/**
 * Join-link patterns (case-insensitive). Mirrors `ConferenceLinks` in the Swift sidecar; both run the shared
 * cases in `fixtures/calendar/conference-links.json`, so change them together.
 */
export const CONFERENCE_LINK_PATTERNS: readonly (readonly [ConferenceProvider, RegExp])[] = [
  [
    'zoom',
    /https?:\/\/(?:[a-z0-9-]+\.)*(?:zoom\.us|zoomgov\.com)\/(?:j|s|w|my|wc\/join)\/[^\s<>"']+/i,
  ],
  [
    'google_meet',
    /https?:\/\/meet\.google\.com\/(?:[a-z]{3,4}-[a-z]{4}-[a-z]{3,4}|lookup\/[a-z0-9_-]+)(?:\?[^\s<>"']*)?/i,
  ],
  [
    'teams',
    /https?:\/\/(?:teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft)\/(?:l\/meetup-join|meet)\/[^\s<>"']+/i,
  ],
];

const TRAILING_PUNCTUATION = /[.,;:!?)\]}*]+$/;

export interface ConferenceLink {
  provider: ConferenceProvider;
  url: string;
}

/** The earliest Zoom / Meet / Teams join link in `text`, or null. */
export function findConferenceLink(text: string): ConferenceLink | null {
  let best: { index: number; link: ConferenceLink } | null = null;
  for (const [provider, pattern] of CONFERENCE_LINK_PATTERNS) {
    const m = pattern.exec(text);
    if (!m || (best && best.index <= m.index)) continue;
    best = { index: m.index, link: { provider, url: m[0].replace(TRAILING_PUNCTUATION, '') } };
  }
  return best?.link ?? null;
}

/** Searches url → location → notes; the first field containing a link wins. */
export function detectConferenceLink(fields: {
  url?: string | null;
  location?: string | null;
  notes?: string | null;
}): ConferenceLink | null {
  for (const text of [fields.url, fields.location, fields.notes]) {
    const link = text ? findConferenceLink(text) : null;
    if (link) return link;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Helpers (pure; `now` is always passed in)
// ---------------------------------------------------------------------------------------------------------

/** D-21: a meeting app using the mic is named after an event starting within this long… */
export const CURRENT_MEETING_LEAD_MS = 90_000;
/** …or one that started no more than this long ago. */
export const CURRENT_MEETING_MAX_LATE_MS = 15 * 60_000;
/** D-21: "meeting starting" notification lead time. */
export const STARTING_SOON_LEAD_MS = 60_000;

const t = (d: Date) => d.getTime();

/** Start, then end, then id — the order every helper returns. */
export function compareCalendarEvents(a: CalendarEvent, b: CalendarEvent): number {
  return t(a.start) - t(b.start) || t(a.end) - t(b.end) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function selfAttendee(event: CalendarEvent): CalendarAttendee | null {
  return event.attendees.find((a) => a.isSelf) ?? null;
}

/** The user said no (their own attendee entry is `declined`). */
export function isDeclined(event: CalendarEvent): boolean {
  return selfAttendee(event)?.status === 'declined';
}

/** Not cancelled and not declined: the user may actually be in it. */
export function isAttending(event: CalendarEvent): boolean {
  return event.status !== 'cancelled' && !isDeclined(event);
}

/** Has someone other than the user — solo blocks ("Focus time", "Lunch") don't. */
export function hasOtherAttendees(event: CalendarEvent): boolean {
  return event.attendees.some((a) => !a.isSelf);
}

/** Looks like a meeting with people: other attendees or a join link. */
export function isMeetingLike(event: CalendarEvent): boolean {
  return hasOtherAttendees(event) || event.conferenceUrl !== null;
}

/**
 * D-21: the event a meeting detected at `now` belongs to, or null. Candidates are timed (not all-day),
 * attended (not cancelled/declined) events that are in progress (`start <= now < end`) or start within 90 s,
 * and started no more than 15 min ago (a late join gets a generic prompt). Several candidates (back-to-back or
 * overlapping): meeting-like events beat solo blocks, then the latest start wins (the one being joined), then id.
 */
export function currentMeetingFor(
  events: readonly CalendarEvent[],
  now: Date,
): CalendarEvent | null {
  const n = t(now);
  let best: CalendarEvent | null = null;
  for (const e of events) {
    if (e.allDay || !isAttending(e)) continue;
    const s = t(e.start);
    if (s - n > CURRENT_MEETING_LEAD_MS || n - s > CURRENT_MEETING_MAX_LATE_MS) continue;
    if (s <= n && t(e.end) <= n) continue; // already over
    if (best === null || rank(e, best) < 0) best = e;
  }
  return best;
}

/** Negative if `a` is the better current-meeting candidate. */
function rank(a: CalendarEvent, b: CalendarEvent): number {
  const tier = Number(isMeetingLike(b)) - Number(isMeetingLike(a));
  return tier || t(b.start) - t(a.start) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export interface UpcomingOptions {
  /** Include all-day events (default false). */
  includeAllDay?: boolean;
  /** Include cancelled / declined events (default false). */
  includeNotAttending?: boolean;
}

/** Events in progress or starting before `now + horizonMs`, sorted by start. */
export function upcoming(
  events: readonly CalendarEvent[],
  now: Date,
  horizonMs: number,
  options: UpcomingOptions = {},
): CalendarEvent[] {
  const n = t(now);
  return events
    .filter(
      (e) =>
        (options.includeAllDay || !e.allDay) &&
        (options.includeNotAttending || isAttending(e)) &&
        t(e.end) > n &&
        t(e.start) < n + horizonMs,
    )
    .sort(compareCalendarEvents);
}

/** Eligible for a "meeting starting" notification: timed, attended, titled, with other attendees. */
export function isNotifiable(event: CalendarEvent): boolean {
  return !event.allDay && isAttending(event) && event.title !== '' && hasOtherAttendees(event);
}

/** D-21: notifiable events starting in [now, now + leadMs], sorted by start. */
export function startingSoon(
  events: readonly CalendarEvent[],
  now: Date,
  leadMs: number = STARTING_SOON_LEAD_MS,
): CalendarEvent[] {
  const n = t(now);
  return events
    .filter((e) => isNotifiable(e) && t(e.start) >= n && t(e.start) <= n + leadMs)
    .sort(compareCalendarEvents);
}

/**
 * When to next check `startingSoon` for a scheduler: the earliest `start - leadMs` of a notifiable event that
 * starts after `now` (never earlier than `now`), or null if there is none. While an event is inside its lead
 * window this keeps returning `now`: callers must remember which event ids they already notified (7.2).
 */
export function nextStartingSoonAt(
  events: readonly CalendarEvent[],
  now: Date,
  leadMs: number = STARTING_SOON_LEAD_MS,
): Date | null {
  const n = t(now);
  let next: number | null = null;
  for (const e of events) {
    if (!isNotifiable(e) || t(e.start) <= n) continue;
    const at = Math.max(n, t(e.start) - leadMs);
    if (next === null || at < next) next = at;
  }
  return next === null ? null : new Date(next);
}
