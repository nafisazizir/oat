import { FixtureCalendarSource } from '@oat/calendar';
import type { CalendarEventInput } from '@oat/core';
import type { CalendarSnapshot } from '@oat/core/bridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CalendarService, type GoogleUpcoming, noteKeys, upcomingEnd } from './calendar-service.ts';

const NOW = new Date('2026-11-16T17:00:00.000Z');

function input(
  id: string,
  startOffsetMin: number,
  overrides: Partial<CalendarEventInput> = {},
): CalendarEventInput {
  const start = new Date(NOW.getTime() + startOffsetMin * 60_000);
  return {
    id,
    source: id.startsWith('google:') ? 'google' : 'eventkit',
    calendar: { id: 'cal-work', title: 'Work', color: '#3B82F6' },
    title: id.replace(/^\w+:/, ''),
    start: start.toISOString(),
    end: new Date(start.getTime() + 30 * 60_000).toISOString(),
    allDay: false,
    allDayStart: null,
    allDayEnd: null,
    timeZone: null,
    location: null,
    url: null,
    conferenceUrl: null,
    conferenceProvider: null,
    status: 'confirmed',
    attendees: [
      { name: 'Me', email: 'me@oat.test', status: 'accepted', isSelf: true, isOrganizer: false },
      { name: 'Sam', email: 'sam@oat.test', status: 'accepted', isSelf: false, isOrganizer: true },
    ],
    recurrenceId: null,
    icalUid: null,
    ...overrides,
  };
}

let google: GoogleUpcoming;
let googleFetch: ReturnType<typeof vi.fn>;
let user: string | null;
let notesByKey: Map<string, string>;
let snapshots: CalendarSnapshot[];
let soon: string[];
let services: CalendarService[];

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  google = { connected: false, state: null, events: [] };
  googleFetch = vi.fn(async () => google);
  user = 'u1';
  notesByKey = new Map();
  snapshots = [];
  soon = [];
  services = [];
});

afterEach(async () => {
  for (const s of services) await s.stop();
  vi.useRealTimers();
});

function service(
  local: FixtureCalendarSource | null,
  extra: { requestAccess?: () => Promise<void> } = {},
) {
  const s = new CalendarService({
    local: local ? { source: local, ...extra, openSettings: vi.fn() } : null,
    google: { fetch: googleFetch as () => Promise<GoogleUpcoming> },
    user: () => user,
    noteFor: (keys) => keys.map((k) => notesByKey.get(k)).find(Boolean) ?? null,
    onSnapshot: (snap) => snapshots.push(snap),
    onStartingSoon: (e) => soon.push(e.id),
  });
  services.push(s);
  return s;
}

describe('CalendarService', () => {
  it('lists today + tomorrow from both sources, merged (the Mac copy wins), with existing notes', async () => {
    const local = new FixtureCalendarSource({
      events: [
        input('eventkit:review', 60, { icalUid: 'review@x' }),
        input('eventkit:past', -120),
        input('eventkit:later', 3 * 24 * 60),
        input('eventkit:declined', 90, {
          attendees: [
            {
              name: 'Me',
              email: 'me@oat.test',
              status: 'declined',
              isSelf: true,
              isOrganizer: false,
            },
          ],
        }),
      ],
    });
    google = {
      connected: true,
      state: 'ok',
      events: await new FixtureCalendarSource({
        events: [
          input('google:review', 60, { icalUid: 'review@x' }),
          input('google:standup', -10, {
            conferenceUrl: 'https://meet.google.com/abc-defg-hij',
            conferenceProvider: 'google_meet',
          }),
        ],
      }).fetchEvents({ from: new Date(0), to: new Date(NOW.getTime() + 10 * 86_400_000) }),
    };
    notesByKey.set('google:standup', 'doc-standup');
    const s = service(local);
    await s.start();
    expect(s.snapshot.eventkit).toBe('full_access');
    expect(s.snapshot.google).toBe('ok');
    expect(s.snapshot.events.map((e) => [e.id, e.documentId])).toEqual([
      ['google:standup', 'doc-standup'], // in progress
      ['eventkit:review', null],
    ]);
    expect(s.snapshot.events[0]).toMatchObject({ others: 1, conferenceProvider: 'google_meet' });
    expect(s.find('google:review')?.id).toBe('google:review');
    expect(s.findByKey('ical:review@x@2026-11-16T18:00:00.000Z')?.id).toBe('eventkit:review');
    expect(s.events.map((e) => e.id)).not.toContain('google:review');

    // A note is made: the list marks the event (only on change).
    const before = snapshots.length;
    notesByKey.set('ical:review@x@2026-11-16T18:00:00.000Z', 'doc-review');
    s.notesChanged();
    expect(snapshots.length).toBe(before + 1);
    expect(s.snapshot.events[1]!.documentId).toBe('doc-review');
    s.notesChanged();
    expect(snapshots.length).toBe(before + 1);
  });

  it('never asks for access on its own; "Connect" asks once, then reads', async () => {
    const local = new FixtureCalendarSource({
      events: [input('eventkit:review', 60)],
      access: 'not_determined',
    });
    const requestAccess = vi.fn(async () => local.setAccess('full_access'));
    const s = service(local, { requestAccess });
    await s.start();
    expect(s.snapshot.eventkit).toBe('not_determined');
    expect(s.snapshot.google).toBe('not_connected');
    expect(s.snapshot.events).toEqual([]);
    expect(requestAccess).not.toHaveBeenCalled();
    const after = await s.connect('eventkit');
    expect(requestAccess).toHaveBeenCalledTimes(1);
    expect(after.eventkit).toBe('full_access');
    expect(after.events.map((e) => e.id)).toEqual(['eventkit:review']);
  });

  it('Google connect is renderer-owned and does not request native calendar access', async () => {
    const requestAccess = vi.fn();
    const s = service(null, { requestAccess });
    await s.start();
    const before = s.snapshot;
    expect(await s.connect('google')).toBe(before);
    expect(requestAccess).not.toHaveBeenCalled();
  });

  it('Google follows sign-in; errors keep the last good events', async () => {
    google = { connected: true, state: 'ok', events: [] };
    const s = service(null);
    await s.start();
    expect(s.snapshot).toMatchObject({ eventkit: 'off', google: 'ok' });
    googleFetch.mockRejectedValueOnce(new Error('offline'));
    await s.refresh();
    expect(s.snapshot.google).toBe('ok');
    google = { connected: true, state: 'reconnect', events: [] };
    await s.refresh();
    expect(s.snapshot.google).toBe('reconnect');
    user = null;
    s.authChanged();
    expect(s.snapshot.google).toBe('signed_out');
    const calls = googleFetch.mock.calls.length;
    await s.refresh();
    expect(googleFetch.mock.calls.length).toBe(calls);
  });

  it('"meeting starting" once per event with attendees, about a minute before', async () => {
    const local = new FixtureCalendarSource({
      events: [
        input('eventkit:sync', 5),
        input('eventkit:focus', 5, {
          attendees: [
            {
              name: 'Me',
              email: 'me@oat.test',
              status: 'accepted',
              isSelf: true,
              isOrganizer: true,
            },
          ],
        }),
      ],
    });
    const s = service(local);
    await s.start();
    expect(soon).toEqual([]);
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 59_000);
    expect(soon).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(soon).toEqual(['eventkit:sync']);
    await s.refresh();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(soon).toEqual(['eventkit:sync']);
  });
});

describe('CalendarService across accounts and at quit', () => {
  it('a Google read for the previous account is dropped; the new account gets its own', async () => {
    google = { connected: true, state: 'ok', events: [] };
    const s = service(null);
    await s.start();
    let releaseA: (value: GoogleUpcoming) => void = () => {};
    googleFetch.mockImplementationOnce(
      () => new Promise<GoogleUpcoming>((resolve) => (releaseA = resolve)),
    );
    const forA = s.refresh();
    user = 'u2';
    google = { connected: false, state: null, events: [] };
    s.authChanged(); // u2's own read
    await vi.waitFor(() => expect(s.snapshot.google).toBe('not_connected'));
    const [aEvent] = await new FixtureCalendarSource({
      events: [input('google:secret', 30)],
    }).fetchEvents({ from: new Date(0), to: new Date(NOW.getTime() + 86_400_000) });
    releaseA({ connected: true, state: 'ok', events: [aEvent!] });
    await forA;
    expect(s.snapshot.google).toBe('not_connected');
    expect(s.events).toEqual([]);
  });

  it('no Google read after stop', async () => {
    google = { connected: true, state: 'ok', events: [] };
    const s = service(null);
    await s.start();
    await s.stop();
    const calls = googleFetch.mock.calls.length;
    user = 'u2';
    s.authChanged();
    await s.refresh();
    expect(googleFetch.mock.calls.length).toBe(calls);
  });

  it('a read finishing after stop touches nothing; a failing note lookup is "no note"', async () => {
    let release: (value: GoogleUpcoming) => void = () => {};
    google = { connected: true, state: 'ok', events: [] };
    const s = service(null);
    await s.start();
    let signal: AbortSignal | undefined;
    googleFetch.mockImplementationOnce(
      (sig: AbortSignal) =>
        new Promise<GoogleUpcoming>((resolve) => {
          signal = sig;
          release = resolve;
        }),
    );
    const pending = s.refresh();
    let lookups = 0;
    const before = snapshots.length;
    notesByKey = new Map();
    const original = notesByKey.get.bind(notesByKey);
    notesByKey.get = (k: string) => {
      lookups++;
      return original(k);
    };
    await s.stop();
    expect(signal?.aborted).toBe(true);
    release({ connected: true, state: 'ok', events: [] });
    await pending;
    expect(snapshots.length).toBe(before);
    expect(lookups).toBe(0);
  });

  it('a throwing note lookup (database closing) leaves the event without a note', async () => {
    const local = new FixtureCalendarSource({ events: [input('eventkit:review', 60)] });
    const s = new CalendarService({
      local: { source: local },
      google: { fetch: async () => google },
      user: () => 'u1',
      noteFor: () => {
        throw new Error('database is not open');
      },
    });
    services.push(s);
    await s.start();
    expect(s.snapshot.events.map((e) => [e.id, e.documentId])).toEqual([['eventkit:review', null]]);
  });
});

describe('helpers', () => {
  it('upcomingEnd is the start of the day after tomorrow (local)', () => {
    const end = upcomingEnd(new Date(2026, 10, 16, 15, 30));
    expect(end).toEqual(new Date(2026, 10, 18, 0, 0));
  });

  it('noteKeys: meeting key first, then the event id', async () => {
    const [e] = await new FixtureCalendarSource({
      events: [input('eventkit:a', 0, { icalUid: 'a@x' })],
    }).fetchEvents({ from: new Date(0), to: new Date(NOW.getTime() + 86_400_000) });
    expect(noteKeys(e!)).toEqual(['ical:a@x@2026-11-16T17:00:00.000Z', 'eventkit:a']);
  });
});
