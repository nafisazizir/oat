/**
 * The parts of Google Calendar API v3 resources Oat reads (`calendarList`, `events`). Parsed leniently:
 * unknown fields are ignored and every field Oat doesn't strictly need is optional, so API additions never
 * break a sync. Field names and meanings are Google's.
 */
import { z } from 'zod';

export const GOOGLE_CALENDAR_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

const str = z.string();

export const GoogleDateTimeSchema = z.object({
  /** All-day: `YYYY-MM-DD` (end exclusive). */
  date: str.optional(),
  /** Timed: RFC 3339 with offset. */
  dateTime: str.optional(),
  timeZone: str.optional(),
});
export type GoogleDateTime = z.infer<typeof GoogleDateTimeSchema>;

export const GoogleAttendeeSchema = z.object({
  email: str.optional(),
  displayName: str.optional(),
  organizer: z.boolean().optional(),
  self: z.boolean().optional(),
  resource: z.boolean().optional(),
  responseStatus: str.optional(),
});
export type GoogleAttendee = z.infer<typeof GoogleAttendeeSchema>;

const GooglePersonSchema = z.object({
  email: str.optional(),
  displayName: str.optional(),
  self: z.boolean().optional(),
});

export const GoogleEventSchema = z.object({
  id: str,
  /** `confirmed` · `tentative` · `cancelled` (deleted; in sync results possibly only id + status). */
  status: str.optional(),
  updated: str.optional(),
  summary: str.optional(),
  description: str.optional(),
  location: str.optional(),
  organizer: GooglePersonSchema.optional(),
  start: GoogleDateTimeSchema.optional(),
  end: GoogleDateTimeSchema.optional(),
  recurrence: z.array(str).optional(),
  recurringEventId: str.optional(),
  originalStartTime: GoogleDateTimeSchema.optional(),
  iCalUID: str.optional(),
  attendees: z.array(GoogleAttendeeSchema).optional(),
  hangoutLink: str.optional(),
  conferenceData: z
    .object({
      entryPoints: z
        .array(z.object({ entryPointType: str.optional(), uri: str.optional() }))
        .optional(),
    })
    .optional(),
  source: z.object({ url: str.optional(), title: str.optional() }).optional(),
  /** `default` · `workingLocation` · `outOfOffice` · `focusTime` · `birthday` · `fromGmail` (absent = default). */
  eventType: str.optional(),
});
export type GoogleEvent = z.infer<typeof GoogleEventSchema>;

export const GoogleEventsPageSchema = z.object({
  timeZone: str.optional(),
  items: z.array(GoogleEventSchema).optional(),
  nextPageToken: str.optional(),
  nextSyncToken: str.optional(),
});

export const GoogleCalendarListEntrySchema = z.object({
  id: str,
  summary: str.optional(),
  summaryOverride: str.optional(),
  timeZone: str.optional(),
  backgroundColor: str.optional(),
  /** Absent means not shown in Google's UI. */
  selected: z.boolean().optional(),
  hidden: z.boolean().optional(),
  deleted: z.boolean().optional(),
  primary: z.boolean().optional(),
  accessRole: str.optional(),
});
export type GoogleCalendarListEntry = z.infer<typeof GoogleCalendarListEntrySchema>;

export const GoogleCalendarListPageSchema = z.object({
  items: z.array(GoogleCalendarListEntrySchema).optional(),
  nextPageToken: str.optional(),
});

export const GoogleErrorSchema = z.object({
  error: z.object({
    code: z.number().optional(),
    message: str.optional(),
    errors: z.array(z.object({ reason: str.optional() })).optional(),
  }),
});
