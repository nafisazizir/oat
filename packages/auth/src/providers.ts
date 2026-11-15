/** Provider id of Google sign-in (also the callback path: `/api/auth/callback/google`). */
export const GOOGLE_PROVIDER_ID = 'google';

/**
 * Provider id of the link-only Google Calendar grant (7.4; callback `/api/auth/callback/google-calendar`).
 * See `google-calendar.ts`.
 */
export const GOOGLE_CALENDAR_PROVIDER_ID = 'google-calendar';
export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
/** Everything the calendar grant asks for (OIDC scopes so the id_token identifies the Google account). */
export const GOOGLE_CALENDAR_SCOPES = ['openid', 'email', 'profile', GOOGLE_CALENDAR_SCOPE];
