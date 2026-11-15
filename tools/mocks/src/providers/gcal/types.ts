/** The subset of Google Calendar API v3 resources the mock serves (field names as in the real API). */

export interface GoogleDateTime {
  /** All-day events: `YYYY-MM-DD`. */
  date?: string;
  /** Timed events: RFC 3339 with offset. */
  dateTime?: string;
  timeZone?: string;
}

export interface GoogleAttendee {
  email?: string;
  displayName?: string;
  organizer?: boolean;
  self?: boolean;
  resource?: boolean;
  optional?: boolean;
  responseStatus: 'needsAction' | 'declined' | 'tentative' | 'accepted';
}

export interface GooglePerson {
  email?: string;
  displayName?: string;
  self?: boolean;
}

export interface GoogleEvent {
  kind: 'calendar#event';
  etag: string;
  id: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  created?: string;
  updated: string;
  summary?: string;
  description?: string;
  location?: string;
  creator?: GooglePerson;
  organizer?: GooglePerson;
  start: GoogleDateTime;
  end: GoogleDateTime;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: GoogleDateTime;
  iCalUID: string;
  sequence: number;
  attendees?: GoogleAttendee[];
  hangoutLink?: string;
  conferenceData?: {
    entryPoints: {
      entryPointType: 'video' | 'phone' | 'sip' | 'more';
      uri: string;
      label?: string;
    }[];
    conferenceSolution: { key: { type: string }; name: string };
    conferenceId: string;
  };
  source?: { title: string; url: string };
  eventType: string;
}

export interface GoogleCalendarListEntry {
  kind: 'calendar#calendarListEntry';
  etag: string;
  id: string;
  summary: string;
  summaryOverride?: string;
  timeZone: string;
  colorId: string;
  backgroundColor: string;
  foregroundColor: string;
  selected?: boolean;
  hidden?: boolean;
  primary?: boolean;
  accessRole: 'freeBusyReader' | 'reader' | 'writer' | 'owner';
  defaultReminders: unknown[];
}
