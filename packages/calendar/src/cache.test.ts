import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CalendarAccess, CalendarEvent } from '@oat/core';

import { CalendarCache } from './cache.ts';
import { FixtureCalendarSource, parseEvents } from './fixture-source.ts';
import { eventInput } from './testing/events.ts';
import type { CalendarRange, CalendarSource, CalendarWatch } from './types.ts';

const NOW = new Date('2026-11-16T16:59:30Z');
const HOUR = 3_600_000;
const now = () => NOW;

const standup = eventInput('standup', '2026-11-16T17:00:00Z');
const review = eventInput('review', '2026-11-16T19:00:00Z');

const caches: CalendarCache[] = [];
function cache(
  source: CalendarSource,
  options: ConstructorParameters<typeof CalendarCache>[1] = {},
) {
  const c = new CalendarCache(source, { now, refreshIntervalMs: 0, ...options });
  caches.push(c);
  const changes: (readonly CalendarEvent[])[] = [];
  const errors: Error[] = [];
  const access: CalendarAccess[] = [];
  c.onChange((e) => changes.push(e));
  c.onError((e) => errors.push(e));
  c.onAccess((a) => access.push(a));
  return { c, changes, errors, access };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(caches.splice(0).map((c) => c.stop()));
});

const flush = () => new Promise((r) => setImmediate(r));

describe('CalendarCache', () => {
  it('loads the −24 h … +14 d window on start and watches', async () => {
    const source = new FixtureCalendarSource({ events: [review, standup] });
    const spy = vi.spyOn(source, 'fetchEvents');
    const { c, changes, access } = cache(source);
    await c.start();
    expect(spy).toHaveBeenCalledWith({
      from: new Date(NOW.getTime() - 24 * HOUR),
      to: new Date(NOW.getTime() + 14 * 24 * HOUR),
    } satisfies CalendarRange);
    expect(c.events.map((e) => e.title)).toEqual(['standup', 'review']);
    expect(changes).toHaveLength(1);
    expect(access).toEqual([{ status: 'full_access', canRead: true }]);
    expect(c.access?.canRead).toBe(true);
    expect(c.lastRefreshedAt).toEqual(NOW);
    await flush();
    expect(source.watcherCount).toBe(1);
  });

  it('refreshes on a change notification and only emits real changes', async () => {
    const source = new FixtureCalendarSource({ events: [standup] });
    const { c, changes } = cache(source);
    await c.start();
    await flush();
    source.setEvents([standup]); // same content
    await vi.waitFor(() => expect(source.fetchCount).toBe(2));
    await c.refresh();
    expect(changes).toHaveLength(1);
    source.setEvents([standup, review]);
    await vi.waitFor(() => expect(changes).toHaveLength(2));
    expect(c.events.map((e) => e.title)).toEqual(['standup', 'review']);
  });

  it('coalesces overlapping refreshes into one follow-up', async () => {
    const source = new FixtureCalendarSource({ events: [standup] });
    const { c } = cache(source);
    await Promise.all([c.refresh(), c.refresh(), c.refresh(), c.refresh()]);
    expect(source.fetchCount).toBe(2);
  });

  it('without access: no events, no watch, no prompt; picks up a later grant', async () => {
    const source = new FixtureCalendarSource({ events: [standup], access: 'not_determined' });
    const spy = vi.spyOn(source, 'fetchEvents');
    const { c, access, changes, errors } = cache(source);
    await c.start();
    expect(c.events).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    expect(source.watcherCount).toBe(0);
    expect(access).toEqual([{ status: 'not_determined', canRead: false }]);
    source.setAccess('full_access');
    await c.refresh();
    expect(c.events).toHaveLength(1);
    expect(changes).toHaveLength(1);
    await flush();
    expect(source.watcherCount).toBe(1);
    // Revoked: events cleared, watch stopped.
    source.setAccess('denied');
    await c.refresh();
    expect(c.events).toEqual([]);
    expect(source.watcherCount).toBe(0);
    expect(access.map((a) => a.status)).toEqual(['not_determined', 'full_access', 'denied']);
    expect(errors).toEqual([]);
  });

  it('keeps the last good events when a refresh fails', async () => {
    const source = new FixtureCalendarSource({ events: [standup] });
    const { c, errors } = cache(source);
    await c.start();
    source.failNextFetch(new Error('sidecar exploded'));
    await expect(c.refresh()).resolves.toBeUndefined();
    expect(errors.map((e) => e.message)).toEqual(['sidecar exploded']);
    expect(c.events).toHaveLength(1);
  });

  it('periodic refresh slides the window', async () => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    });
    vi.setSystemTime(NOW);
    const source = new FixtureCalendarSource({ events: [standup] });
    const spy = vi.spyOn(source, 'fetchEvents');
    const c = new CalendarCache(source, { refreshIntervalMs: 10 * 60_000 });
    caches.push(c);
    await c.start();
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]![0].from).toEqual(new Date(NOW.getTime() + 10 * 60_000 - 24 * HOUR));
    await c.stop();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('stop() stops the watch; cached events stay readable', async () => {
    const source = new FixtureCalendarSource({ events: [standup] });
    const { c } = cache(source);
    await c.start();
    await flush();
    await c.stop();
    expect(source.watcherCount).toBe(0);
    expect(c.running).toBe(false);
    expect(c.events).toHaveLength(1);
    source.setEvents([]);
    await flush();
    expect(source.fetchCount).toBe(1);
  });

  it('exposes the D-21 helpers over the cached events', async () => {
    const source = new FixtureCalendarSource({ events: [standup, review] });
    const { c } = cache(source);
    await c.start();
    expect(c.currentMeeting()?.title).toBe('standup'); // starts in 30 s
    expect(c.startingSoon().map((e) => e.title)).toEqual(['standup']);
    expect(c.upcoming(HOUR).map((e) => e.title)).toEqual(['standup']);
    expect(c.upcoming(3 * HOUR).map((e) => e.title)).toEqual(['standup', 'review']);
    expect(c.currentMeeting(new Date('2026-11-16T19:05:00Z'))?.title).toBe('review');
  });
});

/** A source whose watches can be killed from the test. */
class DyingSource implements CalendarSource {
  readonly name = 'dying';
  inner = new FixtureCalendarSource({ events: [standup] });
  watches: { onError: (e: Error) => void; stopped: boolean }[] = [];
  failWatch = 0;
  failFetch = 0;
  status() {
    return this.inner.status();
  }
  fetchEvents(range: CalendarRange) {
    if (this.failFetch > 0) {
      this.failFetch--;
      this.inner.failNextFetch(new Error('fetch failed'));
    }
    return this.inner.fetchEvents(range);
  }
  async watch(_onChange: () => void, onError: (e: Error) => void): Promise<CalendarWatch> {
    if (this.failWatch > 0) {
      this.failWatch--;
      throw new Error('watch would not start');
    }
    const w = { onError, stopped: false };
    this.watches.push(w);
    return {
      stop: async () => {
        w.stopped = true;
      },
    };
  }
}

describe('CalendarCache watch recovery', () => {
  it('re-watches with exponential backoff after a watch dies, then refreshes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const source = new DyingSource();
    const { c, errors } = cache(source, { rewatchDelayMs: 1000, maxRewatchDelayMs: 3000 });
    await c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(source.watches).toHaveLength(1);

    source.failWatch = 2;
    source.watches[0]!.onError(new Error('watch crashed'));
    expect(errors.map((e) => e.message)).toEqual(['watch crashed']);
    await vi.advanceTimersByTimeAsync(999);
    expect(source.inner.fetchCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1); // 1 s: refresh + watch attempt fails
    expect(source.inner.fetchCount).toBe(2);
    expect(errors.at(-1)?.message).toBe('watch would not start');
    await vi.advanceTimersByTimeAsync(2000); // 2 s: fails again
    expect(source.inner.fetchCount).toBe(3);
    await vi.advanceTimersByTimeAsync(2999); // capped at 3 s
    expect(source.watches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(source.inner.fetchCount).toBe(4);
    expect(source.watches).toHaveLength(2);

    // An error from the replaced watch is ignored.
    source.watches[0]!.onError(new Error('stale'));
    expect(errors.map((e) => e.message)).not.toContain('stale');
  });

  it('keeps backing off when the re-watch refresh itself fails (no interval refresh)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const source = new DyingSource();
    const { c, errors } = cache(source, { rewatchDelayMs: 1000, maxRewatchDelayMs: 3000 });
    await c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(source.watches).toHaveLength(1);

    source.failFetch = 2;
    source.watches[0]!.onError(new Error('watch crashed'));
    await vi.advanceTimersByTimeAsync(1000); // refresh fails → no watch, re-armed (2 s)
    expect(source.inner.fetchCount).toBe(2);
    expect(errors.at(-1)?.message).toBe('fetch failed');
    expect(source.watches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000); // fails again → re-armed (3 s, capped)
    expect(source.inner.fetchCount).toBe(3);
    await vi.advanceTimersByTimeAsync(2999);
    expect(source.inner.fetchCount).toBe(3);
    await vi.advanceTimersByTimeAsync(1); // succeeds → watch back
    expect(source.inner.fetchCount).toBe(4);
    expect(source.watches).toHaveLength(2);
    // Recovered: nothing else scheduled.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(source.inner.fetchCount).toBe(4);
  });

  it('does not re-watch after stop', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const source = new DyingSource();
    const { c } = cache(source, { rewatchDelayMs: 1000 });
    await c.start();
    await vi.advanceTimersByTimeAsync(0);
    source.watches[0]!.onError(new Error('watch crashed'));
    await c.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(source.watches).toHaveLength(1);
    expect(source.inner.fetchCount).toBe(1);
  });

  it('parseEvents sorts input', () => {
    expect(parseEvents([review, standup]).map((e) => e.title)).toEqual(['standup', 'review']);
  });
});
