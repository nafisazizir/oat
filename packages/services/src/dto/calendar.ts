import type { CalendarEvent } from '@oat/core';

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
