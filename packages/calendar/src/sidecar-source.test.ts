/**
 * SidecarCalendarSource against a scriptable fake (`testing/fake-calendar-sidecar.ts`, run with this Node):
 * argument building, output parsing, the no-access exit code, and watch process lifecycle — on any OS.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { SidecarError } from '@oat/audio/node';

import { CalendarCache } from './cache.ts';
import { SidecarCalendarSource, type SidecarCalendarSourceOptions } from './sidecar-source.ts';
import { eventInput } from './testing/events.ts';
import type { FakeCalendarConfig } from './testing/fake-calendar-sidecar.ts';
import { CalendarAccessError, type CalendarWatch } from './types.ts';

const FAKE = fileURLToPath(new URL('./testing/fake-calendar-sidecar.ts', import.meta.url));

function fake(config: FakeCalendarConfig = {}, options: SidecarCalendarSourceOptions = {}) {
  return new SidecarCalendarSource({
    binary: { command: process.execPath, args: [FAKE] },
    env: { ...process.env, FAKE_CALENDAR: JSON.stringify(config) },
    ...options,
  });
}

const RANGE = { from: new Date('2026-11-16T00:00:00Z'), to: new Date('2026-11-21T00:00:00Z') };
const watches: CalendarWatch[] = [];
afterEach(async () => {
  await Promise.all(watches.splice(0).map((w) => w.stop()));
});

describe('SidecarCalendarSource (fake sidecar)', () => {
  it('reads status', async () => {
    expect(await fake().status()).toEqual({ status: 'full_access', canRead: true });
    expect(await fake({ access: 'denied' }).status()).toEqual({ status: 'denied', canRead: false });
  });

  it('rejects unparseable status output', async () => {
    await expect(fake({ garbageStatus: true }).status()).rejects.toBeInstanceOf(SidecarError);
    await expect(fake({ access: 'sort_of' }).status()).rejects.toThrow(/unexpected output/);
  });

  it('fetches events with ISO range and fixture arguments', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'oat-cal-')), 'args.jsonl');
    const source = fake(
      { argsLog: log, events: [eventInput('a', '2026-11-16T17:00:00Z')] },
      { fixture: '/tmp/week.json' },
    );
    expect(source.name).toBe('fixture');
    const events = await source.fetchEvents(RANGE);
    expect(events.map((e) => e.id)).toEqual(['eventkit:a']);
    expect(events[0]!.start).toEqual(new Date('2026-11-16T17:00:00Z'));
    expect(JSON.parse(readFileSync(log, 'utf8').trim())).toEqual([
      'calendar',
      'events',
      '--from',
      '2026-11-16T00:00:00.000Z',
      '--to',
      '2026-11-21T00:00:00.000Z',
      '--fixture',
      '/tmp/week.json',
    ]);
    expect(fake().name).toBe('eventkit');
  });

  it('maps exit 77 to CalendarAccessError', async () => {
    const err = await fake({ access: 'not_determined' })
      .fetchEvents(RANGE)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CalendarAccessError);
    expect((err as Error).message).toMatch(/not_determined/);
  });

  it('reports other failures and bad lines as SidecarError', async () => {
    await expect(fake({ failWith: 1 }).fetchEvents(RANGE)).rejects.toBeInstanceOf(SidecarError);
    await expect(fake({ events: ['{"id":"half"}'] }).fetchEvents(RANGE)).rejects.toThrow(/line 1/);
    await expect(fake().fetchEvents({ from: RANGE.to, to: RANGE.from })).rejects.toBeInstanceOf(
      RangeError,
    );
  });

  it('fails clearly when no binary can be found', async () => {
    const source = new SidecarCalendarSource({ env: { OAT_AUDIO_BIN: '/nonexistent/oat-audio' } });
    await expect(source.status()).rejects.toThrow(/OAT_AUDIO_BIN/);
  });

  it('watch: waits for ready, forwards changed, ignores unknown lines, stops on EOF', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'oat-cal-')), 'args.jsonl');
    const source = fake(
      { argsLog: log, watch: { changeEveryMs: 30, maxChanges: 3 } },
      { debounceMs: 250 },
    );
    let changes = 0;
    const errors: Error[] = [];
    const watch = await source.watch(
      () => changes++,
      (e) => errors.push(e),
    );
    watches.push(watch);
    await expect.poll(() => changes, { timeout: 3000 }).toBe(3);
    expect(JSON.parse(readFileSync(log, 'utf8').trim())).toEqual([
      'calendar',
      'watch',
      '--debounce-ms',
      '250',
    ]);
    await watch.stop();
    await watch.stop(); // idempotent
    expect(errors).toEqual([]);
  });

  it('watch: a crash after ready goes to onError', async () => {
    const errors: Error[] = [];
    const watch = await fake({ watch: { crashAfterMs: 50 } }).watch(
      () => {},
      (e) => errors.push(e),
    );
    watches.push(watch);
    await expect.poll(() => errors.length, { timeout: 3000 }).toBe(1);
    expect(errors[0]).toBeInstanceOf(SidecarError);
    expect(errors[0]!.message).toMatch(/exited with 3.*fake: crashing/);
  });

  it('watch: no access rejects with CalendarAccessError', async () => {
    await expect(
      fake({ access: 'denied' }).watch(
        () => {},
        () => {},
      ),
    ).rejects.toBeInstanceOf(CalendarAccessError);
  });

  it('watch: no ready line → rejects after the timeout and kills the child', async () => {
    await expect(
      fake({ watch: { noReady: true } }, { readyTimeoutMs: 200 }).watch(
        () => {},
        () => {},
      ),
    ).rejects.toThrow(/ready/);
  });

  it('watch: escalates to SIGTERM / SIGKILL when the child ignores EOF', async () => {
    const t0 = Date.now();
    const w1 = await fake({ watch: { ignoreEOF: true } }, { stopTimeoutMs: 150 }).watch(
      () => {},
      () => {},
    );
    await w1.stop();
    const w2 = await fake(
      { watch: { ignoreEOF: true, ignoreTerm: true } },
      { stopTimeoutMs: 150 },
    ).watch(
      () => {},
      () => {},
    );
    await w2.stop();
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('drives a CalendarCache end to end (watch → refresh)', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'oat-cal-')), 'args.jsonl');
    const source = fake({
      argsLog: log,
      events: [eventInput('a', '2026-11-16T17:00:00Z')],
      watch: { changeEveryMs: 50, maxChanges: 1 },
    });
    const now = () => new Date('2026-11-16T16:59:30Z');
    const cache = new CalendarCache(source, { now, refreshIntervalMs: 0 });
    const changes: number[] = [];
    cache.onChange((e) => changes.push(e.length));
    await cache.start();
    expect(cache.currentMeeting()?.id).toBe('eventkit:a');
    const eventsCalls = () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter((l) => (JSON.parse(l) as string[])[1] === 'events').length;
    // Initial fetch + one more after the `changed` line.
    await expect.poll(eventsCalls, { timeout: 3000 }).toBe(2);
    await cache.stop();
    expect(changes).toEqual([1]); // same events again: no second change event
  });
});
