/**
 * Where the Google Calendar API lives (D-11): the mock in dev/tests, `www.googleapis.com` for real Google.
 * Env only, no code changes:
 *
 * 1. `GOOGLE_CALENDAR_BASE_URL` if set (origin + optional prefix before `/calendar/v3`).
 * 2. Real Google sign-in (`OAUTH_GOOGLE_ISSUER=https://accounts.google.com`) → `https://www.googleapis.com`.
 * 3. Otherwise the mocks service: `${MOCKS_URL}/gcal` (`http://localhost:14010/gcal` by default).
 *
 * With `NODE_ENV=production` and neither 1, 2 nor `MOCKS_URL`, it throws instead of using localhost.
 */
export const GOOGLE_CALENDAR_API_URL = 'https://www.googleapis.com';
export const DEFAULT_MOCK_GOOGLE_CALENDAR_URL = 'http://localhost:14010/gcal';

export class GoogleCalendarConfigError extends Error {
  override name = 'GoogleCalendarConfigError';
}

const trimmed = (v: string | undefined) => {
  const t = v?.trim();
  return t ? t.replace(/\/+$/, '') : undefined;
};

export function resolveGoogleCalendarBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = trimmed(env.GOOGLE_CALENDAR_BASE_URL);
  if (explicit) return explicit;
  const issuer = trimmed(env.OAUTH_GOOGLE_ISSUER);
  if (issuer) {
    try {
      if (new URL(issuer).hostname === 'accounts.google.com') return GOOGLE_CALENDAR_API_URL;
    } catch {
      // not a URL: auth config validation reports it
    }
  }
  const mocks = trimmed(env.MOCKS_URL);
  if (mocks) return `${mocks}/gcal`;
  if (env.NODE_ENV === 'production') {
    throw new GoogleCalendarConfigError(
      'Google Calendar: set GOOGLE_CALENDAR_BASE_URL, a real OAUTH_GOOGLE_ISSUER or MOCKS_URL',
    );
  }
  return DEFAULT_MOCK_GOOGLE_CALENDAR_URL;
}

/** True when the base URL is Google's (for "Live" vs "Local mock" labels). */
export function isRealGoogleCalendar(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'www.googleapis.com';
  } catch {
    return false;
  }
}
