import type { CalendarEvent, MeetingParticipant } from '@oat/core';

export type CalendarSourceState =
  /** Events loaded. */
  | 'ok'
  /** Access was refused or lacks the calendar scope: connect again. */
  | 'reconnect'
  /** Google (or the network) failed; try later. */
  | 'error';

export interface CalendarSourceStatus {
  kind: 'google';
  state: CalendarSourceState;
  /** The connected Google account. */
  email: string | null;
}

export interface UpcomingMeetings {
  /** Whether any calendar is connected. */
  connected: boolean;
  sources: CalendarSourceStatus[];
  events: CalendarEvent[];
}

export type CalendarEventDto = Omit<CalendarEvent, 'start' | 'end'> & {
  start: string;
  end: string;
};
export type UpcomingMeetingsDto = Omit<UpcomingMeetings, 'events'> & { events: CalendarEventDto[] };
export type UpcomingQuery = { limit?: number; days?: number };
export type StartNotesInput = { eventId: string; workspaceId: string };
export interface StartNotesResult {
  documentId: string;
  created: boolean;
}

/** The calendar events a meeting note can be linked to (those around its time), and the one it is linked to. */
export interface NoteEventCandidates {
  /** Whether a calendar is connected at all. */
  connected: boolean;
  /** `null` when not connected. */
  state: CalendarSourceState | null;
  /** The note has a linked event (it may be outside `events`, or gone from the calendar). */
  linked: boolean;
  /** The linked event's id, when it is one of `events`. */
  linkedEventId: string | null;
  events: CalendarEvent[];
}
export type NoteEventCandidatesDto = Omit<NoteEventCandidates, 'events'> & {
  events: CalendarEventDto[];
};
export type LinkEventInput = { eventId: string };
export interface LinkEventResult {
  /** The meeting key now stored on the note (`meeting.calendar_event_id`). */
  calendarEventId: string;
  /** Every attendee of the note after the event's were added. */
  participants: MeetingParticipant[];
}
