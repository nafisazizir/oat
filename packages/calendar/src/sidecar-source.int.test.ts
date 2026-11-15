/**
 * SidecarCalendarSource against the real `oat-audio` binary in **fixture mode only** (`--fixture`: no EventKit,
 * no permission prompt — never run `calendar events`/`watch` without it here, and never `request-access`).
 * `calendar status` without a fixture is safe (a read-only query) and is checked too. Skipped unless on macOS
 * with the binary built (`pnpm --filter @oat/audio build:sidecar`) or `OAT_AUDIO_BIN` set.
 */
import { copyFileSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { locateSidecarBinary } from '@oat/audio/node';
import {
  CALENDAR_ACCESS_STATUSES,
  currentMeetingFor,
  startingSoon,
  upcoming,
  type CalendarEvent,
} from '@oat/core';

import { CalendarCache } from './cache.ts';
import { parseEventLines } from './fixture-source.ts';
import { SidecarCalendarSource } from './sidecar-source.ts';
import { CalendarAccessError, type CalendarWatch } from './types.ts';

function findBinary(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    return locateSidecarBinary();
  } catch {
    return undefined;
  }
}
const BINARY = findBinary();
const WEEK = fileURLToPath(new URL('../../../fixtures/calendar/week.json', import.meta.url));

/** Fixture-backed source; `fixture` is mandatory so no test can reach EventKit by accident. */
function sidecar(fixture: string, debounceMs?: number) {
  return new SidecarCalendarSource({ binary: BINARY!, fixture, debounceMs });
}

/** A copy of the week fixture in a temp dir (edited by the watch tests). */
function weekCopy(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'oat-cal-int-')), 'week.json');
  copyFileSync(WEEK, file);
  return file;
}

const RANGE = { from: new Date('2026-11-16T08:00:00Z'), to: new Date('2026-11-21T08:00:00Z') }; // Mon–Fri, US Pacific
const byId = (events: CalendarEvent[], id: string) => events.find((e) => e.id === `eventkit:${id}`);

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((f) => f()));
});

describe.skipIf(!BINARY)('oat-audio calendar (real binary, fixture mode)', () => {
  it('status without a fixture is a read-only query that never prompts', async () => {
    const access = await new SidecarCalendarSource({ binary: BINARY! }).status();
    expect(CALENDAR_ACCESS_STATUSES).toContain(access.status);
    expect(access.canRead).toBe(access.status === 'full_access');
  });

  it('serves the fixture week, normalised and schema-valid', async () => {
    const source = sidecar(WEEK);
    expect(await source.status()).toEqual({ status: 'full_access', canRead: true });
    const events = await source.fetchEvents(RANGE);
    expect(events).toHaveLength(16);
    expect(byId(events, 'saturday-hike')).toBeUndefined();
    expect(events.map((e) => e.start.getTime())).toEqual(
      [...events].map((e) => e.start.getTime()).sort((a, b) => a - b),
    );

    // Recurring occurrences: distinct ids, one series.
    const standups = events.filter((e) => e.recurrenceId === 'eventkit:standup');
    expect(standups.map((e) => e.id)).toEqual([
      'eventkit:standup/2026-11-16T17:30:00.000Z',
      'eventkit:standup/2026-11-17T17:30:00.000Z',
      'eventkit:standup/2026-11-18T17:30:00.000Z', // detached: original occurrence time
    ]);
    expect(standups[2]!.start).toEqual(new Date('2026-11-18T18:00:00Z'));

    // Conference links from url / location / notes.
    expect(standups[0]!.conferenceProvider).toBe('google_meet');
    expect(byId(events, 'product-review')!.conferenceUrl).toBe(
      'https://us02web.zoom.us/j/81234567890?pwd=Q2FsZW5kYXI',
    );
    expect(byId(events, 'acme-call')!.conferenceProvider).toBe('teams');
    expect(byId(events, 'weekly-demo/2026-11-20T23:00:00.000Z')!.conferenceUrl).toBe(
      'https://meet.google.com/dem-oday-wkl',
    );
    expect(byId(events, 'lunch')!.conferenceUrl).toBeNull();

    // All-day events: day strings in the fixture's zone, EventKit 23:59:59 end → next midnight.
    const offsite = byId(events, 'offsite')!;
    expect(offsite).toMatchObject({
      allDay: true,
      allDayStart: '2026-11-17',
      allDayEnd: '2026-11-19',
    });
    expect(offsite.start).toEqual(new Date('2026-11-17T08:00:00Z'));
    expect(byId(events, 'birthday-sam')).toMatchObject({
      allDayStart: '2026-11-20',
      allDayEnd: '2026-11-21',
    });

    // Attendees: room dropped, emails lower-cased, organizer flagged or prepended.
    const interview = byId(events, 'interview')!;
    expect(interview.attendees.map((a) => a.email)).toEqual([
      'alex@oat.test',
      'morgan@oat.test',
      'taylor.kim@example.com',
    ]);
    const acme = byId(events, 'acme-call')!;
    // Listed organizer: flagged in place.
    expect(acme.attendees.filter((a) => a.isOrganizer).map((a) => a.email)).toEqual([
      'chris.wong@acme.example',
    ]);
    // Organizer missing from the attendee list (EventKit does this): prepended.
    expect(byId(events, 'weekly-demo/2026-11-20T23:00:00.000Z')!.attendees[0]).toMatchObject({
      email: 'alex@oat.test',
      isSelf: true,
      isOrganizer: true,
    });
    expect(acme.attendees.find((a) => a.isSelf)?.email).toBe('alex@oat.test');
    expect(byId(events, 'design-crit')!.attendees.find((a) => a.isSelf)?.status).toBe('declined');
    expect(byId(events, 'hiring-sync')!.status).toBe('cancelled');
    expect(byId(events, 'tokyo-call')).toMatchObject({ timeZone: 'Asia/Tokyo' });
    expect(byId(events, 'tokyo-call')!.start).toEqual(new Date('2026-11-20T01:00:00Z'));
  });

  it('still prints the golden output the Google normaliser is compared against', async () => {
    // fixtures/calendar/week.eventkit.jsonl ↔ google/normalize.test.ts. If this fails after a deliberate
    // normaliser change, regenerate the file with the command in that test and re-run both.
    const events = await sidecar(WEEK).fetchEvents({
      from: new Date('2026-11-15T00:00:00Z'),
      to: new Date('2026-11-23T00:00:00Z'),
    });
    const golden = parseEventLines(
      readFileSync(
        new URL('../../../fixtures/calendar/week.eventkit.jsonl', import.meta.url),
        'utf8',
      ),
    );
    expect(events).toEqual(golden);
  });

  it('the core helpers make sense on the fixture week', async () => {
    const events = await sidecar(WEEK).fetchEvents(RANGE);
    // Wed 16:35 PST: "Focus time" (solo, 16:00–17:00) overlaps "Quick sync" (16:30, with Sam).
    expect(currentMeetingFor(events, new Date('2026-11-19T00:35:00Z'))?.title).toBe(
      'Quick sync with Sam',
    );
    // Tue 14:59 PST: "Design crit" was declined — not named, not notified.
    expect(currentMeetingFor(events, new Date('2026-11-17T22:59:30Z'))).toBeNull();
    expect(startingSoon(events, new Date('2026-11-17T22:59:30Z'))).toEqual([]);
    // Mon 09:29 PST: standup starts in a minute.
    expect(startingSoon(events, new Date('2026-11-16T17:29:00Z')).map((e) => e.title)).toEqual([
      'Daily standup',
    ]);
    // Mon 11:30 PST, next 2 h: review in progress, then lunch (solo blocks are listed).
    expect(
      upcoming(events, new Date('2026-11-16T19:30:00Z'), 2 * 3_600_000).map((e) => e.title),
    ).toEqual(['Product review: onboarding flow', 'Lunch']);
  });

  it('reports no access from a fixture without throwing a prompt', async () => {
    const file = weekCopy();
    writeFileSync(file, readFileSync(file, 'utf8').replace('"full_access"', '"not_determined"'));
    const source = sidecar(file);
    expect(await source.status()).toEqual({ status: 'not_determined', canRead: false });
    await expect(source.fetchEvents(RANGE)).rejects.toBeInstanceOf(CalendarAccessError);
    await expect(
      source.watch(
        () => {},
        () => {},
      ),
    ).rejects.toBeInstanceOf(CalendarAccessError);
  });

  it('watch reports fixture edits (debounced) and stops on EOF', async () => {
    const file = weekCopy();
    let changes = 0;
    const errors: Error[] = [];
    const watch: CalendarWatch = await sidecar(file, 100).watch(
      () => changes++,
      (e) => errors.push(e),
    );
    cleanup.push(() => watch.stop());
    // Three quick edits → one debounced `changed`.
    for (let i = 0; i < 3; i++) writeFileSync(file, `${readFileSync(file, 'utf8')} `);
    await expect.poll(() => changes, { timeout: 5000 }).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 400));
    expect(changes).toBe(1);
    await watch.stop();
    expect(errors).toEqual([]);
  });

  it('CalendarCache follows fixture edits through the sidecar watch', async () => {
    const file = weekCopy();
    const cache = new CalendarCache(sidecar(file, 50), {
      now: () => new Date('2026-11-16T17:29:00Z'),
      refreshIntervalMs: 0,
    });
    cleanup.push(() => cache.stop());
    const errors: Error[] = [];
    cache.onError((e) => errors.push(e));
    await cache.start();
    expect(cache.startingSoon().map((e) => e.title)).toEqual(['Daily standup']);
    const before = cache.events.length;
    await new Promise((r) => setTimeout(r, 200)); // let the watch come up

    // Atomic replace (how editors and sync tools write): the Monday standup is cancelled.
    const json = JSON.parse(readFileSync(file, 'utf8')) as { events: Record<string, unknown>[] };
    json.events = json.events.map((e) =>
      e.id === 'standup' && e.occurrenceDate === '2026-11-16T09:30:00-08:00'
        ? { ...e, status: 'cancelled' }
        : e,
    );
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(json));
    renameSync(tmp, file);

    await expect.poll(() => cache.startingSoon().length, { timeout: 5000 }).toBe(0);
    expect(cache.events.length).toBe(before);
    expect(errors).toEqual([]);
  });
});
