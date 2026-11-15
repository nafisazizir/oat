/**
 * GoogleCalendarSource over real HTTP against an in-process mocks server (`startMocks()`, this checkout's
 * gcal provider; never the shared container), driven by `CalendarCache` like the apps use it.
 */
import { gcalProvider, type RunningMocks, startMocks } from '@oat/mocks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CalendarCache } from '../cache.ts';
import { resolveGoogleCalendarBaseUrl } from './config.ts';
import { GoogleCalendarSource } from './source.ts';

let mocks: RunningMocks;
const NOW = new Date('2026-11-16T17:29:00Z'); // Mon 09:29 PST: standup in a minute

beforeAll(async () => {
  mocks = await startMocks({ providers: [() => gcalProvider({ anchor: 'fixture' })] });
});
afterAll(() => mocks?.close());

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${mocks.url}/gcal${path}`, {
    ...init,
    headers: { authorization: 'Bearer dev', 'content-type': 'application/json' },
  });

describe('GoogleCalendarSource over HTTP', () => {
  it('feeds CalendarCache; changes and a 410 are picked up by the polling watch', async () => {
    const baseUrl = resolveGoogleCalendarBaseUrl({ MOCKS_URL: mocks.url });
    expect(baseUrl).toBe(`${mocks.url}/gcal`);
    const source = new GoogleCalendarSource({
      clientOptions: { baseUrl, getAccessToken: async () => 'dev-token' },
      now: () => NOW,
      minSyncIntervalMs: 0,
      pollIntervalMs: 25,
    });
    const cache = new CalendarCache(source, { now: () => NOW, refreshIntervalMs: 0 });
    const errors: Error[] = [];
    cache.onError((e) => errors.push(e));
    await cache.start();
    try {
      expect(cache.access).toEqual({ status: 'full_access', canRead: true });
      expect(cache.startingSoon().map((e) => e.title)).toEqual(['Daily standup']);
      expect(cache.upcoming(3 * 3_600_000).map((e) => e.title)).toEqual([
        'Daily standup',
        'Product review: onboarding flow',
        'Lunch',
      ]);

      // The organizer deletes Monday's standup; the watch's next incremental sync removes it.
      const del = await api('/calendar/v3/calendars/cal-work/events/standup_20261116T173000Z', {
        method: 'DELETE',
      });
      expect(del.status).toBe(204);
      await expect.poll(() => cache.startingSoon().length, { timeout: 3000 }).toBe(0);

      // Every sync token goes stale and the review moves: full re-sync, same result as a fresh read.
      await fetch(`${mocks.url}/gcal/_mock/expire-sync-tokens`, { method: 'POST' });
      await api('/calendar/v3/calendars/cal-work/events/product-review', {
        method: 'PATCH',
        body: JSON.stringify({ summary: 'Product review (v2)' }),
      });
      await expect
        .poll(() => cache.events.some((e) => e.title === 'Product review (v2)'), { timeout: 3000 })
        .toBe(true);
      expect(source.stats.expiredSyncTokens).toBeGreaterThanOrEqual(3);
      expect(errors).toEqual([]);
    } finally {
      await cache.stop();
    }
  });
});
