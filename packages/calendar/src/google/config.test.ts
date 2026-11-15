import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MOCK_GOOGLE_CALENDAR_URL,
  GOOGLE_CALENDAR_API_URL,
  GoogleCalendarConfigError,
  isRealGoogleCalendar,
  resolveGoogleCalendarBaseUrl,
} from './config.ts';

describe('resolveGoogleCalendarBaseUrl', () => {
  it('uses GOOGLE_CALENDAR_BASE_URL when set', () => {
    expect(
      resolveGoogleCalendarBaseUrl({
        GOOGLE_CALENDAR_BASE_URL: ' http://127.0.0.1:5000/gcal/ ',
        OAUTH_GOOGLE_ISSUER: 'https://accounts.google.com',
      }),
    ).toBe('http://127.0.0.1:5000/gcal');
  });

  it('talks to Google when sign-in is real Google', () => {
    expect(
      resolveGoogleCalendarBaseUrl({
        GOOGLE_CALENDAR_BASE_URL: '',
        OAUTH_GOOGLE_ISSUER: 'https://accounts.google.com',
        MOCKS_URL: 'http://localhost:14010',
      }),
    ).toBe(GOOGLE_CALENDAR_API_URL);
  });

  it('otherwise uses the mocks service (D-11)', () => {
    expect(
      resolveGoogleCalendarBaseUrl({
        OAUTH_GOOGLE_ISSUER: 'http://localhost:18089/google',
        MOCKS_URL: 'http://localhost:14010/',
      }),
    ).toBe('http://localhost:14010/gcal');
    expect(resolveGoogleCalendarBaseUrl({})).toBe(DEFAULT_MOCK_GOOGLE_CALENDAR_URL);
  });

  it('refuses to fall back to localhost in production', () => {
    expect(() => resolveGoogleCalendarBaseUrl({ NODE_ENV: 'production' })).toThrow(
      GoogleCalendarConfigError,
    );
  });

  it('the .env.example defaults resolve to the mock', () => {
    expect(
      resolveGoogleCalendarBaseUrl({
        OAUTH_GOOGLE_ISSUER: 'http://localhost:18089/google',
        MOCKS_URL: 'http://localhost:14010',
        GOOGLE_CALENDAR_BASE_URL: '',
      }),
    ).toBe('http://localhost:14010/gcal');
  });

  it('isRealGoogleCalendar', () => {
    expect(isRealGoogleCalendar(GOOGLE_CALENDAR_API_URL)).toBe(true);
    expect(isRealGoogleCalendar('http://localhost:14010/gcal')).toBe(false);
    expect(isRealGoogleCalendar('nope')).toBe(false);
  });
});
