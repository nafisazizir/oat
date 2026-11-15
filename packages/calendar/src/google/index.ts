/**
 * `@oat/calendar/google`: Google Calendar as a `CalendarSource` (server-side; fetch only). Tokens come from
 * the caller (`@oat/auth` stores them on the `google-calendar` account and refreshes them).
 */
export {
  GOOGLE_CALENDAR_READONLY_SCOPE,
  type GoogleAttendee,
  type GoogleCalendarListEntry,
  type GoogleDateTime,
  type GoogleEvent,
} from './api.ts';
export {
  type EventList,
  type GoogleAccessTokenProvider,
  GoogleCalendarApiError,
  GoogleCalendarAuthError,
  GoogleCalendarClient,
  type GoogleCalendarClientOptions,
  GoogleSyncTokenExpiredError,
  type ListEventsParams,
} from './client.ts';
export {
  DEFAULT_MOCK_GOOGLE_CALENDAR_URL,
  GOOGLE_CALENDAR_API_URL,
  GoogleCalendarConfigError,
  isRealGoogleCalendar,
  resolveGoogleCalendarBaseUrl,
} from './config.ts';
export {
  calendarInfoFromListEntry,
  type GoogleCalendarInfo,
  googleAttendeeStatus,
  NON_MEETING_EVENT_TYPES,
  normalizeGoogleEvent,
} from './normalize.ts';
export {
  GoogleCalendarSource,
  type GoogleCalendarSourceOptions,
  type GoogleSyncStats,
  isReadableCalendar,
} from './source.ts';
