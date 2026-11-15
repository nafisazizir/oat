import { describe, expect, it } from 'vitest';

import {
  filterRange,
  FixtureCalendarSource,
  parseEventLines,
  parseEvents,
} from './fixture-source.ts';
import { eventInput } from './testing/events.ts';
import { CalendarAccessError } from './types.ts';

const range = (from: string, to: string) => ({ from: new Date(from), to: new Date(to) });

describe('FixtureCalendarSource', () => {
  const events = [
    eventInput('b', '2026-11-16T18:00:00Z'),
    eventInput('a', '2026-11-16T17:00:00Z'),
    eventInput('next-day', '2026-11-17T17:00:00Z'),
  ];

  it('serves events overlapping the range, sorted, as copies', async () => {
    const source = new FixtureCalendarSource({ events });
    const got = await source.fetchEvents(range('2026-11-16T00:00:00Z', '2026-11-17T00:00:00Z'));
    expect(got.map((e) => e.title)).toEqual(['a', 'b']);
    got[0]!.title = 'mutated';
    const again = await source.fetchEvents(range('2026-11-16T00:00:00Z', '2026-11-17T00:00:00Z'));
    expect(again[0]!.title).toBe('a');
    expect(source.fetchCount).toBe(2);
  });

  it('reports access and refuses reads without it', async () => {
    const source = new FixtureCalendarSource({ events, access: 'not_determined' });
    expect(await source.status()).toEqual({ status: 'not_determined', canRead: false });
    await expect(
      source.fetchEvents(range('2026-11-16T00:00:00Z', '2026-11-18T00:00:00Z')),
    ).rejects.toBeInstanceOf(CalendarAccessError);
    await expect(source.watch(() => {})).rejects.toBeInstanceOf(CalendarAccessError);
    source.setAccess('full_access');
    expect(await source.status()).toEqual({ status: 'full_access', canRead: true });
  });

  it('notifies watchers on setEvents until stopped', async () => {
    const source = new FixtureCalendarSource({ events });
    let changes = 0;
    const watch = await source.watch(() => changes++);
    source.setEvents([eventInput('x', '2026-11-16T17:00:00Z')]);
    expect(changes).toBe(1);
    expect(source.watcherCount).toBe(1);
    await watch.stop();
    source.setEvents([]);
    expect(changes).toBe(1);
    expect(source.watcherCount).toBe(0);
  });

  it('can fail the next fetch once', async () => {
    const source = new FixtureCalendarSource({ events });
    source.failNextFetch(new Error('boom'));
    await expect(
      source.fetchEvents(range('2026-11-16T00:00:00Z', '2026-11-18T00:00:00Z')),
    ).rejects.toThrow('boom');
    await expect(
      source.fetchEvents(range('2026-11-16T00:00:00Z', '2026-11-18T00:00:00Z')),
    ).resolves.toHaveLength(3);
  });

  it('validates events', () => {
    expect(() => new FixtureCalendarSource({ events: [{ id: 'x' } as never] })).toThrow();
  });
});

describe('filterRange', () => {
  const list = parseEvents([
    eventInput('ends-at-from', '2026-11-16T16:30:00Z'), // 16:30–17:00
    eventInput('spans-from', '2026-11-16T16:45:00Z'),
    eventInput('starts-at-to', '2026-11-16T18:00:00Z'),
    eventInput('zero-at-from', '2026-11-16T17:00:00Z', { end: '2026-11-16T17:00:00Z' }),
    eventInput('inside', '2026-11-16T17:15:00Z'),
  ]);

  it('is half-open [from, to) on overlap', () => {
    expect(
      filterRange(list, range('2026-11-16T17:00:00Z', '2026-11-16T18:00:00Z')).map((e) => e.title),
    ).toEqual(['spans-from', 'zero-at-from', 'inside']);
  });
});

describe('parseEventLines', () => {
  it('parses JSON lines and skips blank lines', () => {
    const text = `${JSON.stringify(eventInput('a', '2026-11-16T17:00:00Z'))}\n\n${JSON.stringify(eventInput('b', '2026-11-16T18:00:00Z'))}\n`;
    const got = parseEventLines(text);
    expect(got.map((e) => e.title)).toEqual(['a', 'b']);
    expect(got[0]!.start).toBeInstanceOf(Date);
    expect(parseEventLines('')).toEqual([]);
  });

  it('names the bad line', () => {
    const good = JSON.stringify(eventInput('a', '2026-11-16T17:00:00Z'));
    expect(() => parseEventLines(`${good}\n{nope`)).toThrow(/line 2/);
    expect(() => parseEventLines(`${good}\n{"id":"x"}`)).toThrow(/line 2/);
  });
});
