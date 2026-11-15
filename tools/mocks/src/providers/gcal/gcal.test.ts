import { describe, expect, it } from 'vitest';

import { createApp } from '../../app.ts';
import { gcalProvider, type GcalProviderOptions } from './index.ts';
import { rfc3339InZone, shiftWallDays, wallToInstant } from './time.ts';
import type { GoogleCalendarListEntry, GoogleEvent } from './types.ts';

interface EventsPage {
  kind: string;
  timeZone: string;
  items: GoogleEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

function mock(options: GcalProviderOptions = { anchor: 'fixture' }) {
  const { app } = createApp({ providers: [() => gcalProvider(options)] });
  const call = (path: string, init: RequestInit & { token?: string | null } = {}) => {
    const headers = new Headers(init.headers);
    if (init.token !== null) headers.set('authorization', `Bearer ${init.token ?? 'dev'}`);
    if (init.body) headers.set('content-type', 'application/json');
    return app.request(`/gcal${path}`, { ...init, headers });
  };
  const events = async (calendar: string, query: string) => {
    const res = await call(`/calendar/v3/calendars/${calendar}/events?singleEvents=true&${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as EventsPage;
  };
  return { app, call, events };
}

const WEEK = 'timeMin=2026-11-16T00:00:00-08:00&timeMax=2026-11-21T00:00:00-08:00';

describe('gcal provider: calendarList', () => {
  it('lists the fixture calendars Google-style', async () => {
    const { call } = mock();
    const res = await call('/calendar/v3/users/me/calendarList');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; items: GoogleCalendarListEntry[] };
    expect(body.kind).toBe('calendar#calendarList');
    expect(body.items.map((c) => [c.id, c.summary, c.backgroundColor, c.primary ?? false])).toEqual(
      [
        ['cal-work', 'Work', '#3b82f6', true],
        ['cal-personal', 'Personal', '#22c55e', false],
        ['cal-birthdays', 'Birthdays', '#a855f7', false],
      ],
    );
    expect(body.items.every((c) => c.selected && c.timeZone === 'America/Los_Angeles')).toBe(true);
  });

  it('paginates', async () => {
    const { call } = mock();
    const first = (await (
      await call('/calendar/v3/users/me/calendarList?maxResults=2')
    ).json()) as {
      items: unknown[];
      nextPageToken: string;
    };
    expect(first.items).toHaveLength(2);
    const second = (await (
      await call(`/calendar/v3/users/me/calendarList?maxResults=2&pageToken=${first.nextPageToken}`)
    ).json()) as { items: unknown[]; nextPageToken?: string; nextSyncToken?: string };
    expect(second.items).toHaveLength(1);
    expect(second.nextPageToken).toBeUndefined();
    expect(second.nextSyncToken).toBeTruthy();
  });
});

describe('gcal provider: auth', () => {
  const jwt = (claims: object) =>
    `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

  it('requires a bearer token (401 Google-style)', async () => {
    const { call } = mock();
    const res = await call('/calendar/v3/users/me/calendarList', { token: null });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: { code: 401, errors: [{ reason: 'required' }], status: 'UNAUTHENTICATED' },
    });
  });

  it('refuses expired JWTs and revoked tokens, accepts any other non-empty token', async () => {
    const { call } = mock({ anchor: 'fixture', now: () => Date.parse('2026-11-16T12:00:00Z') });
    const list = '/calendar/v3/users/me/calendarList';
    expect((await call(list, { token: 'anything' })).status).toBe(200);
    expect(
      (await call(list, { token: jwt({ exp: Date.parse('2026-11-16T13:00:00Z') / 1000 }) })).status,
    ).toBe(200);
    const expired = await call(list, {
      token: jwt({ exp: Date.parse('2026-11-16T11:00:00Z') / 1000 }),
    });
    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({ error: { errors: [{ reason: 'authError' }] } });

    expect(
      (
        await call('/_mock/revoke-token', {
          method: 'POST',
          body: JSON.stringify({ token: 'anything' }),
        })
      ).status,
    ).toBe(200);
    expect((await call(list, { token: 'anything' })).status).toBe(401);
  });

  it('403s a JWT whose scope lacks calendar access', async () => {
    const { call } = mock();
    const list = '/calendar/v3/users/me/calendarList';
    const narrow = await call(list, { token: jwt({ scope: 'openid email profile' }) });
    expect(narrow.status).toBe(403);
    expect(await narrow.json()).toMatchObject({
      error: { errors: [{ reason: 'insufficientPermissions' }] },
    });
    const ok = await call(list, {
      token: jwt({ scope: 'openid https://www.googleapis.com/auth/calendar.readonly' }),
    });
    expect(ok.status).toBe(200);
  });
});

describe('gcal provider: events', () => {
  it('serves expanded instances in the window, Google-shaped', async () => {
    const { events } = mock();
    const page = await events('cal-work', `${WEEK}&orderBy=startTime`);
    expect(page.kind).toBe('calendar#events');
    expect(page.timeZone).toBe('America/Los_Angeles');
    expect(page.nextSyncToken).toBeTruthy();
    const ids = page.items.map((e) => e.id);
    expect(ids).toContain('standup_20261116T173000Z');
    expect(ids).toContain('standup_20261118T173000Z');
    expect(ids).not.toContain('hiring-sync'); // cancelled = deleted: hidden without showDeleted

    const moved = page.items.find((e) => e.id === 'standup_20261118T173000Z')!;
    expect(moved).toMatchObject({
      recurringEventId: 'standup',
      summary: 'Daily standup (moved)',
      start: { dateTime: '2026-11-18T10:00:00-08:00', timeZone: 'America/Los_Angeles' },
      originalStartTime: { dateTime: '2026-11-18T09:30:00-08:00' },
      hangoutLink: 'https://meet.google.com/abc-defg-hij',
      conferenceData: { conferenceSolution: { key: { type: 'hangoutsMeet' } } },
      iCalUID: 'standup-series@oat.test',
    });

    const acme = page.items.find((e) => e.id === 'acme-call')!;
    expect(acme.start).toEqual({
      dateTime: '2026-11-17T13:00:00-05:00',
      timeZone: 'America/New_York',
    });

    const review = page.items.find((e) => e.id === 'product-review')!;
    // Organizer missing from the fixture's attendee list: Google lists them anyway.
    expect(review.attendees![0]).toMatchObject({
      email: 'priya@oat.test',
      organizer: true,
      responseStatus: 'accepted',
    });
    const interview = page.items.find((e) => e.id === 'interview')!;
    expect(interview.attendees!.find((a) => a.resource)?.email).toBe('room-4a@resource.oat.test');

    const offsite = page.items.find((e) => e.id === 'offsite')!;
    expect(offsite).toMatchObject({ start: { date: '2026-11-17' }, end: { date: '2026-11-19' } });
  });

  it('adds Google-only event types to the primary calendar', async () => {
    const { events } = mock();
    const page = await events('cal-work', WEEK);
    const typed = page.items.filter((e) => e.eventType !== 'default');
    expect(typed.map((e) => [e.eventType, e.summary, e.start.dateTime])).toEqual([
      ['workingLocation', 'Office', '2026-11-16T08:00:00-08:00'],
      ['focusTime', 'Deep work', '2026-11-19T13:00:00-08:00'],
      ['outOfOffice', 'Out of office', '2026-11-20T13:00:00-08:00'],
    ]);
  });

  it('turns EventKit-style all-day ends into exclusive dates', async () => {
    const { events } = mock();
    const page = await events('cal-birthdays', WEEK);
    expect(page.items[0]).toMatchObject({
      start: { date: '2026-11-20' },
      end: { date: '2026-11-21' },
    });
  });

  it('filters by overlap with timeMin/timeMax and shows deleted events on request', async () => {
    const { events } = mock();
    const tuesday = await events(
      'cal-work',
      'timeMin=2026-11-17T00:00:00-08:00&timeMax=2026-11-18T00:00:00-08:00',
    );
    expect(tuesday.items.map((e) => e.summary)).toEqual([
      'Team offsite',
      'Daily standup',
      'Customer call: Acme',
      'Design crit',
    ]);
    const withDeleted = await events('cal-work', `${WEEK}&showDeleted=true`);
    expect(withDeleted.items.find((e) => e.id === 'hiring-sync')?.status).toBe('cancelled');
  });

  it('paginates with tokens bound to the query', async () => {
    const { call, events } = mock();
    const first = await events('cal-work', `${WEEK}&maxResults=5`);
    expect(first.items).toHaveLength(5);
    expect(first.nextSyncToken).toBeUndefined();
    const all = [...first.items];
    let token = first.nextPageToken;
    while (token) {
      const page = await events('cal-work', `${WEEK}&maxResults=5&pageToken=${token}`);
      all.push(...page.items);
      token = page.nextPageToken;
      if (!token) expect(page.nextSyncToken).toBeTruthy();
    }
    const single = await events('cal-work', WEEK);
    expect(all.map((e) => e.id)).toEqual(single.items.map((e) => e.id));
    const wrong = await call(
      `/calendar/v3/calendars/cal-work/events?singleEvents=true&maxResults=6&pageToken=${first.nextPageToken}`,
    );
    expect(wrong.status).toBe(400);
  });

  it('returns changes since a sync token, deletions included, and 410 for stale tokens', async () => {
    const { call, events } = mock();
    const full = await events('cal-work', WEEK);
    const token = full.nextSyncToken!;
    expect((await events('cal-work', `syncToken=${token}`)).items).toEqual([]);

    expect(
      (
        await call('/calendar/v3/calendars/cal-work/events/focus', {
          method: 'PATCH',
          body: JSON.stringify({ summary: 'Deep work' }),
        })
      ).status,
    ).toBe(200);
    expect(
      (await call('/calendar/v3/calendars/cal-work/events/quick-sync', { method: 'DELETE' }))
        .status,
    ).toBe(204);
    expect(
      (await call('/calendar/v3/calendars/cal-work/events/quick-sync', { method: 'DELETE' }))
        .status,
    ).toBe(410);

    const delta = await events('cal-work', `syncToken=${token}`);
    expect(delta.items.map((e) => [e.id, e.status, e.summary])).toEqual([
      ['focus', 'confirmed', 'Deep work'],
      ['quick-sync', 'cancelled', 'Quick sync with Sam'],
    ]);
    const next = delta.nextSyncToken!;
    expect((await events('cal-work', `syncToken=${next}`)).items).toEqual([]);

    // A token from another calendar, garbage, or any token after expire-sync-tokens: 410.
    const other = (await events('cal-personal', WEEK)).nextSyncToken!;
    const gone = (t: string) =>
      call(`/calendar/v3/calendars/cal-work/events?singleEvents=true&syncToken=${t}`);
    expect((await gone(other)).status).toBe(410);
    expect((await gone('garbage')).status).toBe(410);
    await call('/_mock/expire-sync-tokens', { method: 'POST' });
    const stale = await gone(next);
    expect(stale.status).toBe(410);
    expect(await stale.json()).toMatchObject({
      error: { errors: [{ reason: 'fullSyncRequired' }] },
    });
  });

  it('validates parameters like Google', async () => {
    const { call } = mock();
    const get = (q: string) => call(`/calendar/v3/calendars/cal-work/events?${q}`);
    expect((await get('singleEvents=true&syncToken=x&timeMin=2026-11-16T00:00:00Z')).status).toBe(
      400,
    );
    expect((await get('singleEvents=true&timeMin=2026-11-16')).status).toBe(400); // no offset
    expect((await get('singleEvents=true&orderBy=title')).status).toBe(400);
    expect((await get('singleEvents=true&maxResults=0')).status).toBe(400);
    expect((await get(WEEK)).status).toBe(400); // the mock only serves singleEvents=true
    expect((await call('/calendar/v3/calendars/nope/events?singleEvents=true')).status).toBe(404);
    const primary = await call('/calendar/v3/calendars/primary/events?singleEvents=true');
    expect(primary.status).toBe(200);
  });

  it('gets, inserts and resets', async () => {
    const { app, call, events } = mock();
    const one = await call('/calendar/v3/calendars/cal-work/events/acme-call');
    expect(((await one.json()) as GoogleEvent).summary).toBe('Customer call: Acme');
    const created = await call('/calendar/v3/calendars/primary/events', {
      method: 'POST',
      body: JSON.stringify({
        summary: 'New',
        start: { dateTime: '2026-11-19T10:00:00Z' },
        end: { dateTime: '2026-11-19T11:00:00Z' },
      }),
    });
    expect(created.status).toBe(200);
    expect(((await created.json()) as GoogleEvent).iCalUID).toMatch(/@google\.com$/);
    expect((await events('cal-work', WEEK)).items.map((e) => e.summary)).toContain('New');
    await app.request('/_reset?provider=gcal', { method: 'POST' });
    expect((await events('cal-work', WEEK)).items.map((e) => e.summary)).not.toContain('New');
  });
});

describe('gcal provider: dates', () => {
  it('`next-week` shifts the fixture so its Monday is the first one after now (wall clock kept)', async () => {
    // Wed 2 Dec 2026, PST → the fixture's week becomes Mon 7 – Fri 11 Dec.
    const { events } = mock({ anchor: 'next-week', now: () => Date.parse('2026-12-02T20:00:00Z') });
    const page = await events(
      'cal-work',
      'timeMin=2026-12-07T00:00:00-08:00&timeMax=2026-12-12T00:00:00-08:00',
    );
    const standup = page.items.find((e) => e.recurringEventId === 'standup')!;
    expect(standup.start.dateTime).toBe('2026-12-07T09:30:00-08:00');
    expect(standup.id).toBe('standup_20261207T173000Z');
    expect(page.items.find((e) => e.id === 'offsite')?.start).toEqual({ date: '2026-12-08' });
  });

  it('`next-week` before the fixture week keeps its dates', async () => {
    const { events } = mock({ anchor: 'next-week', now: () => Date.parse('2026-11-14T12:00:00Z') });
    const page = await events('cal-work', WEEK);
    expect(page.items.some((e) => e.id === 'standup_20261116T173000Z')).toBe(true);
  });

  it('switches weeks while running (and old sync tokens get a 410)', async () => {
    let now = Date.parse('2026-11-14T12:00:00Z');
    const { call, events } = mock({ anchor: 'next-week', now: () => now });
    const token = (await events('cal-work', WEEK)).nextSyncToken!;
    now = Date.parse('2026-11-16T12:00:00Z'); // past the fixture Monday: next week's copy
    const res = await call(
      `/calendar/v3/calendars/cal-work/events?singleEvents=true&syncToken=${token}`,
    );
    expect(res.status).toBe(410);
  });

  it('time helpers keep wall-clock time across DST', () => {
    const tz = 'America/Los_Angeles';
    const nov = Date.parse('2026-11-16T09:30:00-08:00');
    // 16 Nov PST → 15 Jun PDT, still 09:30 local.
    expect(rfc3339InZone(shiftWallDays(nov, tz, 7 * 30), tz)).toBe('2027-06-14T09:30:00-07:00');
    expect(rfc3339InZone(Date.parse('2026-11-17T13:00:00Z'), 'Asia/Tokyo')).toBe(
      '2026-11-17T22:00:00+09:00',
    );
    expect(
      new Date(
        wallToInstant({ year: 2026, month: 3, day: 8, hour: 12, minute: 0, second: 0 }, tz),
      ).toISOString(),
    ).toBe('2026-03-08T19:00:00.000Z');
  });
});
