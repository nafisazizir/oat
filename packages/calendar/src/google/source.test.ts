import { createApp, gcalProvider, type MocksApp } from '@oat/mocks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CalendarAccessError } from '../types.ts';
import {
  GoogleCalendarApiError,
  GoogleCalendarAuthError,
  GoogleCalendarClient,
  GoogleSyncTokenExpiredError,
} from './client.ts';
import { GoogleCalendarSource, isReadableCalendar } from './source.ts';

/**
 * GoogleCalendarSource against the gcal mock in-process (`app.request` as `fetch`: no sockets). The mock
 * serves the fixture week (Mon 16 – Fri 20 Nov 2026, US Pacific) at its own dates.
 */
const BASE = 'http://gcal.test/gcal';
const DAY = 86_400_000;
const WEEK = { from: new Date('2026-11-16T08:00:00Z'), to: new Date('2026-11-21T08:00:00Z') };

let mocks: MocksApp;
let clock: Date;
let tokens: string[];

beforeEach(() => {
  clock = new Date('2026-11-16T16:00:00Z'); // Mon 08:00 PST
  mocks = createApp({
    providers: [() => gcalProvider({ anchor: 'fixture', now: () => clock.getTime() })],
  });
  tokens = [];
});
afterEach(() => mocks.log.clear());

const fetchVia: typeof fetch = (input, init) =>
  Promise.resolve(mocks.app.request(String(input), init as RequestInit));

function client(
  options: { maxResults?: number; token?: (force: boolean) => string | Promise<string> } = {},
) {
  return new GoogleCalendarClient({
    baseUrl: BASE,
    fetch: fetchVia,
    maxResults: options.maxResults,
    getAccessToken: async ({ forceRefresh }) => {
      const token = await (options.token?.(forceRefresh) ?? 'dev-token');
      tokens.push(forceRefresh ? `refresh:${token}` : token);
      return token;
    },
  });
}

function source(options: ConstructorParameters<typeof GoogleCalendarSource>[0] = {}) {
  return new GoogleCalendarSource({
    client: client(),
    now: () => clock,
    minSyncIntervalMs: 0,
    ...options,
  });
}

const gcal = (path: string, init: RequestInit = {}) =>
  mocks.app.request(`/gcal/calendar/v3${path}`, {
    ...init,
    headers: { authorization: 'Bearer dev', 'content-type': 'application/json' },
  });

describe('GoogleCalendarSource', () => {
  it('full-syncs every readable calendar and serves the range, normalised and sorted', async () => {
    const s = source();
    expect(await s.status()).toEqual({ status: 'full_access', canRead: true });
    const events = await s.fetchEvents(WEEK);
    expect(events).toHaveLength(15); // the 16 EventKit shows minus the cancelled "Hiring sync"
    expect(events.find((e) => e.title === 'Hiring sync')).toBeUndefined();
    expect(events.map((e) => e.start.getTime())).toEqual(
      events.map((e) => e.start.getTime()).sort((a, b) => a - b),
    );
    expect(new Set(events.map((e) => e.calendar.title))).toEqual(
      new Set(['Work', 'Personal', 'Birthdays']),
    );
    expect(s.stats).toEqual({
      fullSyncs: 1,
      incrementalSyncs: 0,
      expiredSyncTokens: 0,
      calendarFailures: 0,
    });
  });

  it('then syncs incrementally: changed events upserted, deleted ones removed', async () => {
    const s = source();
    await s.fetchEvents(WEEK);
    expect(
      (
        await gcal('/calendars/cal-work/events/focus', {
          method: 'PATCH',
          body: JSON.stringify({ summary: 'Deep work' }),
        })
      ).status,
    ).toBe(200);
    expect((await gcal('/calendars/cal-personal/events/lunch', { method: 'DELETE' })).status).toBe(
      204,
    );
    const inserted = await gcal('/calendars/cal-work/events', {
      method: 'POST',
      body: JSON.stringify({
        id: 'retro',
        summary: 'Retro',
        start: { dateTime: '2026-11-19T14:00:00-08:00' },
        end: { dateTime: '2026-11-19T15:00:00-08:00' },
        hangoutLink: 'https://meet.google.com/ret-roxx-abc',
      }),
    });
    expect(inserted.status).toBe(200);

    const before = mocks.log.list({ provider: 'gcal' }).length;
    const events = await s.fetchEvents(WEEK);
    expect(s.stats).toMatchObject({ fullSyncs: 1, incrementalSyncs: 1 });
    const titles = events.map((e) => e.title);
    expect(titles).toContain('Deep work');
    expect(titles).not.toContain('Focus time');
    expect(titles).not.toContain('Lunch');
    expect(events.find((e) => e.title === 'Retro')).toMatchObject({
      id: 'google:cal-work/retro',
      conferenceProvider: 'google_meet',
      timeZone: 'America/Los_Angeles',
    });
    // Incremental = 1 calendar list + one sync-token request per calendar.
    const calls = mocks.log.list({ provider: 'gcal' }).slice(before);
    expect(calls).toHaveLength(4);
    expect(calls.filter((c) => c.query.syncToken)).toHaveLength(3);
    expect(calls.some((c) => c.query.timeMin)).toBe(false);
  });

  it('re-syncs a calendar fully when its sync token is refused (410)', async () => {
    const s = source();
    await s.fetchEvents(WEEK);
    await mocks.app.request('/gcal/_mock/expire-sync-tokens', { method: 'POST' });
    await gcal('/calendars/cal-work/events/focus', {
      method: 'PATCH',
      body: JSON.stringify({ summary: 'Deep work' }),
    });
    const events = await s.fetchEvents(WEEK);
    expect(s.stats).toEqual({
      fullSyncs: 1,
      incrementalSyncs: 1,
      expiredSyncTokens: 3,
      calendarFailures: 0,
    });
    expect(events.map((e) => e.title)).toContain('Deep work');
    expect(events).toHaveLength(15);
    const gone = mocks.log.list({ provider: 'gcal' }).filter((c) => c.status === 410);
    expect(gone).toHaveLength(3);
    // …and the fresh tokens work again.
    await s.fetchEvents(WEEK);
    expect(s.stats.expiredSyncTokens).toBe(3);
  });

  it('follows pages', async () => {
    const s = source({ client: client({ maxResults: 2 }) });
    const events = await s.fetchEvents(WEEK);
    expect(events).toHaveLength(15);
    const work = mocks.log
      .list({ provider: 'gcal' })
      .filter((c) => c.path === '/gcal/calendar/v3/calendars/cal-work/events');
    expect(work.length).toBeGreaterThan(5);
    expect(work.slice(1).every((c) => c.query.pageToken)).toBe(true);
  });

  it('serves reads within minSyncIntervalMs from the cache', async () => {
    const s = source({ minSyncIntervalMs: 30_000 });
    await s.fetchEvents(WEEK);
    const after = mocks.log.list({ provider: 'gcal' }).length;
    clock = new Date(clock.getTime() + 10_000);
    await s.fetchEvents(WEEK);
    expect(mocks.log.list({ provider: 'gcal' })).toHaveLength(after);
    clock = new Date(clock.getTime() + 30_000);
    await s.fetchEvents(WEEK);
    expect(s.stats.incrementalSyncs).toBe(1);
  });

  it('shares one sync between concurrent reads', async () => {
    const s = source();
    await Promise.all([s.fetchEvents(WEEK), s.fetchEvents(WEEK), s.fetchEvents(WEEK)]);
    expect(s.stats.fullSyncs).toBe(1);
  });

  it('does a full sync again for a range outside the synced window', async () => {
    const s = source({ windowFutureMs: 2 * DAY });
    await s.fetchEvents({ from: clock, to: new Date('2026-11-17T08:00:00Z') });
    expect(s.stats.fullSyncs).toBe(1);
    // Window = to + 7 days of slack (24 Nov); 30 Nov is beyond it.
    await s.fetchEvents({ from: clock, to: new Date('2026-11-30T08:00:00Z') });
    expect(s.stats.fullSyncs).toBe(2);
    const events = await s.fetchEvents(WEEK);
    expect(s.stats.fullSyncs).toBe(2);
    expect(events.some((e) => e.title === 'Weekly demo')).toBe(true);
  });

  it('repeated reads of the widest range stay incremental and respect minSyncIntervalMs', async () => {
    // What the web app asks for at most (now − 1 d … now + 21 d, `?days=21`), and the default window's edge.
    for (const days of [21, 28]) {
      const s = source({ minSyncIntervalMs: 30_000 });
      const range = () => ({
        from: new Date(clock.getTime() - DAY),
        to: new Date(clock.getTime() + days * DAY),
      });
      const start = clock;
      for (let i = 0; i < 10; i++) {
        await s.fetchEvents(range());
        clock = new Date(clock.getTime() + 10_000); // 10 reads, 10 s apart
      }
      expect(s.stats.fullSyncs, `${days} days`).toBe(1);
      expect(s.stats.incrementalSyncs, `${days} days`).toBe(3); // at 30, 60 and 90 s
      clock = start;
    }
  });

  it('a caller joining a running sync for a narrower window still gets its wider range', async () => {
    const s = source({ windowFutureMs: 2 * DAY });
    const narrow = s.fetchEvents({ from: clock, to: new Date('2026-11-17T08:00:00Z') });
    const wide = s.fetchEvents({ from: clock, to: new Date('2026-12-07T08:00:00Z') });
    await narrow;
    const events = await wide;
    expect(s.stats.fullSyncs).toBe(2);
    expect(events.some((e) => e.title === 'Weekly demo')).toBe(true);
  });

  it('one failing calendar doesn’t hide the others, and is retried in full next time', async () => {
    let failing = true;
    const flaky: typeof fetch = (input, init) =>
      failing && String(input).includes('/calendars/cal-personal/')
        ? Promise.resolve(
            Response.json({ error: { code: 503, message: 'Backend Error' } }, { status: 503 }),
          )
        : fetchVia(input, init);
    const s = source({
      client: new GoogleCalendarClient({
        baseUrl: BASE,
        fetch: flaky,
        getAccessToken: async () => 'dev',
      }),
    });
    const first = await s.fetchEvents(WEEK);
    expect(first.some((e) => e.calendar.title === 'Personal')).toBe(false);
    expect(first.some((e) => e.title === 'Daily standup')).toBe(true);
    expect(s.stats.calendarFailures).toBe(1);
    expect((await s.status()).canRead).toBe(true);

    // Still failing on an incremental pass: the others sync, nothing is lost.
    await s.fetchEvents(WEEK);
    expect(s.stats.calendarFailures).toBe(2);

    failing = false;
    const healed = await s.fetchEvents(WEEK);
    expect(healed.filter((e) => e.calendar.title === 'Personal').map((e) => e.title)).toEqual([
      'Lunch',
    ]);
    expect(healed).toHaveLength(15);
  });

  it('a 403 `forbidden` on one shared calendar is that calendar’s problem, not a reconnect', async () => {
    const forbidden: typeof fetch = (input, init) =>
      String(input).includes('/calendars/cal-birthdays/')
        ? Promise.resolve(
            Response.json(
              { error: { code: 403, errors: [{ reason: 'forbidden' }], message: 'Forbidden' } },
              { status: 403 },
            ),
          )
        : fetchVia(input, init);
    const s = source({
      client: new GoogleCalendarClient({
        baseUrl: BASE,
        fetch: forbidden,
        getAccessToken: async () => 'dev',
      }),
    });
    const events = await s.fetchEvents(WEEK);
    expect(events).toHaveLength(14); // all but the birthday
    expect((await s.status()).canRead).toBe(true);
  });

  it('every calendar failing is an error, not an empty calendar', async () => {
    const down: typeof fetch = (input, init) =>
      String(input).includes('/events')
        ? Promise.resolve(new Response('upstream', { status: 502 }))
        : fetchVia(input, init);
    const s = source({
      client: new GoogleCalendarClient({
        baseUrl: BASE,
        fetch: down,
        getAccessToken: async () => 'dev',
      }),
    });
    await expect(s.fetchEvents(WEEK)).rejects.toMatchObject({ status: 502 });
  });

  it('refreshes the token once on a 401 and retries', async () => {
    let n = 0;
    await mocks.app.request('/gcal/_mock/revoke-token', {
      method: 'POST',
      body: JSON.stringify({ token: 'stale' }),
    });
    const s = source({ client: client({ token: (force) => (force ? `fresh-${++n}` : 'stale') }) });
    const events = await s.fetchEvents(WEEK);
    expect(events).toHaveLength(15);
    expect(tokens.slice(0, 2)).toEqual(['stale', 'refresh:fresh-1']);
  });

  it('reports denied access when the token is refused even after a refresh', async () => {
    await mocks.app.request('/gcal/_mock/revoke-token', {
      method: 'POST',
      body: JSON.stringify({ token: 'revoked' }),
    });
    const s = source({ client: client({ token: () => 'revoked' }) });
    const error = await s.fetchEvents(WEEK).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CalendarAccessError);
    expect((error as Error).cause).toBeInstanceOf(GoogleCalendarAuthError);
    expect(await s.status()).toEqual({ status: 'denied', canRead: false });
    await expect(
      s.watch(
        () => {},
        () => {},
      ),
    ).rejects.toBeInstanceOf(CalendarAccessError);
  });

  it('treats a missing calendar scope (403) and a failing token provider as auth errors', async () => {
    const header = Buffer.from('{"alg":"none"}').toString('base64url');
    const payload = Buffer.from(JSON.stringify({ scope: 'openid email' })).toString('base64url');
    const narrow = source({ client: client({ token: () => `${header}.${payload}.x` }) });
    await expect(narrow.fetchEvents(WEEK)).rejects.toBeInstanceOf(CalendarAccessError);
    expect(narrow.authError).toMatchObject({ status: 403, reason: 'insufficientPermissions' });

    const broken = source({
      client: client({
        token: () => {
          throw new Error('refresh token revoked');
        },
      }),
    });
    await expect(broken.fetchEvents(WEEK)).rejects.toBeInstanceOf(CalendarAccessError);
    expect((await broken.status()).canRead).toBe(false);
  });

  it('recovers from an auth failure on the next successful sync', async () => {
    let token = 'revoked';
    await mocks.app.request('/gcal/_mock/revoke-token', {
      method: 'POST',
      body: JSON.stringify({ token: 'revoked' }),
    });
    const s = source({ client: client({ token: () => token }) });
    await expect(s.fetchEvents(WEEK)).rejects.toBeInstanceOf(CalendarAccessError);
    token = 'good';
    await expect(s.fetchEvents(WEEK)).resolves.toHaveLength(15);
    expect((await s.status()).canRead).toBe(true);
  });

  it('watch polls and reports changes', async () => {
    const s = source({ pollIntervalMs: 10 });
    await s.fetchEvents(WEEK);
    let changes = 0;
    const watch = await s.watch(
      () => changes++,
      () => {},
    );
    await new Promise((r) => setTimeout(r, 40));
    expect(changes).toBe(0); // polls found nothing new
    await gcal('/calendars/cal-work/events/focus', {
      method: 'PATCH',
      body: JSON.stringify({ summary: 'Deep work' }),
    });
    const deadline = Date.now() + 1000;
    while (changes === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(changes).toBe(1);
    await watch.stop();
  });
});

describe('GoogleCalendarClient', () => {
  it('maps API errors', async () => {
    const c = client();
    await expect(c.listEvents('nope', { timeMin: WEEK.from })).rejects.toMatchObject({
      status: 404,
      reason: 'notFound',
    });
    await expect(c.listEvents('cal-work', { syncToken: 'garbage' })).rejects.toBeInstanceOf(
      GoogleSyncTokenExpiredError,
    );
    const err = await c.listEvents('nope', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleCalendarApiError);
    expect(err).not.toBeInstanceOf(GoogleCalendarAuthError);
  });

  it('sends the bearer token and singleEvents=true', async () => {
    await client().listEvents('primary', { timeMin: WEEK.from, timeMax: WEEK.to });
    const [call] = mocks.log.list({ provider: 'gcal' });
    expect(call!.headers.authorization).toBe('Bearer [redacted]');
    expect(call!.query).toMatchObject({
      singleEvents: 'true',
      timeMin: '2026-11-16T08:00:00.000Z',
      timeMax: '2026-11-21T08:00:00.000Z',
    });
  });
});

describe('isReadableCalendar', () => {
  it('reads primary and shown calendars, never hidden, deleted or free/busy-only ones', () => {
    expect(isReadableCalendar({ id: 'a', primary: true })).toBe(true);
    expect(isReadableCalendar({ id: 'b', selected: true, accessRole: 'reader' })).toBe(true);
    expect(isReadableCalendar({ id: 'c' })).toBe(false);
    expect(isReadableCalendar({ id: 'd', selected: true, hidden: true })).toBe(false);
    expect(isReadableCalendar({ id: 'e', selected: true, accessRole: 'freeBusyReader' })).toBe(
      false,
    );
    expect(isReadableCalendar({ id: 'f', primary: true, deleted: true })).toBe(false);
  });
});
