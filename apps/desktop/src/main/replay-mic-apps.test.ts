import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readCalendarFixture } from './calendar-setup.ts';
import { parseReplay, ReplayMicAppsSource } from './replay-mic-apps.ts';

const ZOOM_BASIC = fileURLToPath(
  new URL('../../../../fixtures/detection/zoom-basic.json', import.meta.url),
);
const WEEK_JSONL = fileURLToPath(
  new URL('../../../../fixtures/calendar/week.eventkit.jsonl', import.meta.url),
);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oat-replay-'));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('ReplayMicAppsSource', () => {
  it('replays a detection timeline’s mic-apps steps from when the watch starts', async () => {
    vi.useFakeTimers();
    const source = ReplayMicAppsSource.fromFile(ZOOM_BASIC);
    const seen: number[][] = [];
    const watch = await source.watch((apps) => seen.push(apps.map((a) => a.pid)));
    expect(seen).toEqual([[]]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(seen).toEqual([[], [501]]);
    expect((await source.list()).map((a) => a.pid)).toEqual([501]);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(seen).toEqual([[], [501], []]);
    await watch.stop();
  });

  it('stops replaying when stopped; steps without micApps are skipped', async () => {
    vi.useFakeTimers();
    const steps = parseReplay({
      steps: [
        { at: 0, events: [] },
        { at: 500, micApps: [{ pid: 7, bundleId: 'us.zoom.xos' }] },
      ],
    });
    expect(steps).toHaveLength(1);
    const seen: number[][] = [];
    const watch = await new ReplayMicAppsSource(steps).watch((apps) =>
      seen.push(apps.map((a) => a.pid)),
    );
    await watch.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(seen).toEqual([[]]);
    expect(() => parseReplay({ steps: [] })).toThrow();
  });
});

describe('readCalendarFixture', () => {
  it('reads JSON lines, an array, or { access, events }', async () => {
    const range = { from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-12-01T00:00:00Z') };
    const week = readCalendarFixture(WEEK_JSONL);
    expect((await week.fetchEvents(range)).length).toBeGreaterThan(10);

    const events = await week.fetchEvents(range);
    const asArray = join(dir, 'events.json');
    writeFileSync(asArray, JSON.stringify(events.slice(0, 2)));
    expect((await readCalendarFixture(asArray).fetchEvents(range)).length).toBe(2);

    const noAccess = join(dir, 'no-access.json');
    writeFileSync(
      noAccess,
      JSON.stringify({ access: 'not_determined', events: events.slice(0, 1) }),
    );
    const source = readCalendarFixture(noAccess);
    expect(await source.status()).toEqual({ status: 'not_determined', canRead: false });
  });
});
