/**
 * Desktop IPC channels of calendar notes + meeting detection (task 7.3), spread into `bridgeContract`
 * (`bridge.ts`): the sidebar's "Upcoming" list (EventKit through the sidecar and Google through the web API,
 * merged), "Start notes" from an event, and the "Start notes?" prompt (meeting detected, or a meeting about to
 * start, D-21). Kept in its own module like `bridge-meetings.ts`. (No imports from `bridge.ts`: it imports
 * this module.)
 */
import { z } from 'zod';

const iso = z.string().max(40);
/** A calendar event id (`eventkit:…` / `google:…`, per occurrence). */
const eventId = z.string().min(1).max(1024);

/** EventKit (the Mac's calendars) as the sidebar sees it: `off` = not used by this build/config. */
export const EVENTKIT_STATES = [
  'off',
  'full_access',
  'not_determined',
  'denied',
  'restricted',
  'write_only',
  'unknown',
  'error',
] as const;
export const eventkitStateSchema = z.enum(EVENTKIT_STATES);
export type EventkitState = z.infer<typeof eventkitStateSchema>;

/** Google Calendar through the web API (7.4). */
export const GOOGLE_CALENDAR_STATES = [
  'signed_out',
  'loading',
  'not_connected',
  'ok',
  'reconnect',
  'error',
] as const;
export const googleCalendarStateSchema = z.enum(GOOGLE_CALENDAR_STATES);
export type GoogleCalendarState = z.infer<typeof googleCalendarStateSchema>;

/** One event of the "Upcoming" list (today + tomorrow, in progress or ahead). */
export const upcomingEventSchema = z.object({
  id: eventId,
  source: z.enum(['eventkit', 'google']),
  title: z.string().max(1000),
  start: iso,
  end: iso,
  calendarTitle: z.string().max(500),
  calendarColor: z.string().max(16).nullable(),
  /** People besides me. */
  others: z.number().int().nonnegative(),
  conferenceUrl: z.string().max(2048).nullable(),
  conferenceProvider: z.enum(['zoom', 'google_meet', 'teams']).nullable(),
  /** The note already made for this event on this Mac (reopened instead of a second one). */
  documentId: z.string().nullable(),
});
export type UpcomingEvent = z.infer<typeof upcomingEventSchema>;

export const calendarSnapshotSchema = z.object({
  /** +1 per change. */
  seq: z.number().int().nonnegative(),
  eventkit: eventkitStateSchema,
  google: googleCalendarStateSchema,
  events: z.array(upcomingEventSchema).max(200),
  /** Wall clock (Unix ms) of the last refresh that read anything. */
  updatedAt: z.number().nullable(),
});
export type CalendarSnapshot = z.infer<typeof calendarSnapshotSchema>;

/** The scheduled event a meeting note was made from, when the calendar still has it (header + join link). */
export const noteCalendarEventSchema = z.object({
  title: z.string().max(1000),
  start: iso,
  end: iso,
  conferenceUrl: z.string().max(2048).nullable(),
  conferenceProvider: z.enum(['zoom', 'google_meet', 'teams']).nullable(),
});
export type NoteCalendarEvent = z.infer<typeof noteCalendarEventSchema>;

/**
 * "Start notes?" on screen: `detected` = a meeting app holds the mic (D-21, `@oat/detection` prompt);
 * `starting` = an event with attendees starts in about a minute.
 */
export const meetingPromptSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(['detected', 'starting']),
  /** Event title, or e.g. "Zoom meeting". */
  title: z.string().max(1000),
  /** The calendar event it names (null: a generic prompt). */
  eventId: eventId.nullable(),
  /** The meeting app (detected prompts only), for "Don't ask for Zoom". */
  appId: z.string().max(64).nullable(),
  appName: z.string().max(100).nullable(),
  /** Wall clock (Unix ms) it was shown. */
  at: z.number(),
});
export type MeetingPrompt = z.infer<typeof meetingPromptSchema>;

export const startNotesResultSchema = z.object({
  documentId: z.string(),
  meetingId: z.string(),
  /** False: the note for this event already existed and is reopened. */
  created: z.boolean(),
});
export type StartNotesResult = z.infer<typeof startNotesResultSchema>;

export const calendarInvokeChannels = {
  'calendar:get': { request: z.undefined(), response: calendarSnapshotSchema },
  /** Re-read every source now. */
  'calendar:refresh': { request: z.undefined(), response: calendarSnapshotSchema },
  /**
   * The user asked to connect a calendar (never called on its own: nothing prompts automatically).
   * `eventkit`: asks macOS for Calendars access when it was never asked, else opens System Settings;
   * `google`: opens the web app's integrations page in the browser.
   */
  'calendar:connect': {
    request: z.strictObject({ provider: z.enum(['eventkit', 'google']) }),
    response: calendarSnapshotSchema,
  },
  /**
   * The meeting note for an upcoming event: made from the event (title, calendar attendees, the event's id)
   * or, if this Mac already has one for the same meeting, that one. Doesn't record.
   */
  'calendar:start-notes': {
    request: z.strictObject({ eventId }),
    response: startNotesResultSchema,
  },
  'prompt:get': { request: z.undefined(), response: meetingPromptSchema.nullable() },
  /**
   * Answer the prompt: `start` makes (or reopens) the event's note and starts recording it; `dismiss` = "Not
   * now"; `silence` = don't ask for this app again. `input`/`fixture` as in `recording:start` (dev).
   */
  'prompt:respond': {
    request: z.strictObject({
      promptId: z.string().min(1).max(64),
      action: z.enum(['start', 'dismiss', 'silence']),
      input: z.enum(['sidecar', 'file']).optional(),
      fixture: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
        .optional(),
    }),
    response: z.object({ documentId: z.string().nullable() }),
  },
} as const;

export const calendarSubscribeChannels = {
  'calendar:changed': calendarSnapshotSchema,
  'prompt:changed': z.object({ prompt: meetingPromptSchema.nullable() }),
  /** Main opened a note for the user (a notification was clicked): show it. */
  'notes:open': z.object({ documentId: z.string() }),
} as const;
