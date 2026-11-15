import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type CalendarEvent, CalendarEventSchema, type CalendarEventInput } from '@oat/core';
import type { MeetingPrompt } from '@oat/core/bridge';
import { FixtureMicAppsSource } from '@oat/detection';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DetectionService,
  DetectionServiceError,
  type NotifyRequest,
} from './detection-service.ts';

const NOW = new Date('2026-11-16T17:00:00.000Z');
const ZOOM = { pid: 501, bundleId: 'us.zoom.xos' };

function event(overrides: Partial<CalendarEventInput> = {}): CalendarEvent {
  return CalendarEventSchema.parse({
    id: 'eventkit:review',
    source: 'eventkit',
    calendar: { id: 'cal-work', title: 'Work', color: null },
    title: 'Design review',
    start: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
    end: new Date(NOW.getTime() + 25 * 60_000).toISOString(),
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
  } satisfies CalendarEventInput);
}

let dir: string;
let mic: FixtureMicAppsSource;
let events: CalendarEvent[];
let prompts: (MeetingPrompt | null)[];
let shown: (NotifyRequest & { closed: boolean })[];
let startNotes: ReturnType<typeof vi.fn>;
let opened: (string | null)[];
let service: DetectionService;

let ended: unknown[];
let calls: boolean[];
let apps: string[];

function create(source: FixtureMicAppsSource | null = mic) {
  return new DetectionService({
    onMeetingEnded: (action) => ended.push(action),
    onCallChanged: (open) => calls.push(open),
    onAppsChanged: (ids) => apps.push(ids.join() || '-'),
    source,
    dir,
    calendar: {
      get events() {
        return events;
      },
      find: (id) => events.find((e) => e.id === id) ?? null,
    },
    startNotes: startNotes as never,
    notify: (request) => {
      const entry = { ...request, closed: false };
      shown.push(entry);
      return { close: () => void (entry.closed = true) };
    },
    onPrompt: (p) => prompts.push(p),
    onOpened: (id) => opened.push(id),
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  dir = mkdtempSync(join(tmpdir(), 'oat-detection-'));
  mic = new FixtureMicAppsSource();
  events = [event()];
  prompts = [];
  shown = [];
  opened = [];
  ended = [];
  calls = [];
  apps = [];
  startNotes = vi.fn(async () => ({ documentId: 'doc-1' }));
  service = create();
});

afterEach(async () => {
  await service.stop();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const current = () => prompts.at(-1) ?? null;

describe('DetectionService', () => {
  it('7.5: passes calls opening/closing and ending on to auto-stop; sign-out closes an open call', async () => {
    await service.start('u1');
    mic.setApps([ZOOM]);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(calls).toEqual([true]);
    service.setRecording(true);
    mic.setApps([]);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(calls).toEqual([true, false]);
    expect(ended).toEqual([
      expect.objectContaining({ type: 'meetingEnded', recording: true, prompted: true }),
    ]);
    mic.setApps([ZOOM]);
    await vi.advanceTimersByTimeAsync(2_100);
    await service.stop();
    expect(calls).toEqual([true, false, true, false]);
    // The raw apps change at once (no eligibility, no debounce): a returning app is seen immediately.
    expect(apps).toEqual(['zoom', '-', 'zoom', '-']);
  });

  it('Zoom takes the mic during an event → "Start notes for <event>?" → start records into the event’s note', async () => {
    await service.start('u1');
    mic.setApps([ZOOM]);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(current()).toMatchObject({
      kind: 'detected',
      title: 'Design review',
      eventId: 'eventkit:review',
      appId: 'zoom',
      appName: 'Zoom',
    });
    expect(shown).toHaveLength(1);
    expect(shown[0]!.title).toBe('Start notes for Design review?');

    const result = await service.respond(current()!.id, 'start', { input: 'file', fixture: 'x' });
    expect(result).toEqual({ documentId: 'doc-1' });
    expect(startNotes).toHaveBeenCalledWith({ event: events[0], input: 'file', fixture: 'x' });
    expect(current()).toBeNull();
    expect(shown[0]!.closed).toBe(true);
    // Recording now: no more prompts (D-21).
    service.setRecording(true);
    mic.setApps([]);
    await vi.advanceTimersByTimeAsync(5_000);
    mic.setApps([ZOOM]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(current()).toBeNull();
  });

  it('without an event: a generic prompt; a notification click starts notes and opens them', async () => {
    events = [];
    await service.start('u1');
    mic.setApps([ZOOM]);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(current()).toMatchObject({ title: 'Zoom meeting', eventId: null });
    shown[0]!.onClick();
    await vi.waitFor(() => expect(opened).toEqual(['doc-1']));
    expect(startNotes).toHaveBeenCalledWith({ event: null });
    expect(current()).toBeNull();
  });

  it('"Not now" closes it; the app leaving dismisses it; stale prompt ids are refused', async () => {
    await service.start('u1');
    mic.setApps([ZOOM]);
    await vi.advanceTimersByTimeAsync(2_100);
    const first = current()!;
    await service.respond(first.id, 'dismiss');
    expect(current()).toBeNull();
    await expect(service.respond(first.id, 'start')).rejects.toThrow(DetectionServiceError);
    expect(startNotes).not.toHaveBeenCalled();
  });

  it('"Don’t ask for Zoom" is kept across restarts, per account', async () => {
    events = [];
    await service.start('u1');
    mic.setApps([ZOOM]);
    await vi.advanceTimersByTimeAsync(2_100);
    await service.respond(current()!.id, 'silence');
    expect(current()).toBeNull();
    expect(JSON.parse(readFileSync(join(dir, 'detection-u1.json'), 'utf8'))).toEqual({
      silenced: ['zoom'],
    });
    await service.stop();
    const again = create(new FixtureMicAppsSource());
    expect(again.silenced).toEqual([]); // nobody signed in yet
    await again.start('u1');
    expect(again.silenced).toEqual(['zoom']);

    // Another account on this Mac: its own (empty) list, and Zoom prompts for it.
    await again.stop();
    const mic2 = new FixtureMicAppsSource();
    const other = create(mic2);
    await other.start('u2');
    expect(other.silenced).toEqual([]);
    mic2.setApps([ZOOM]);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(current()).toMatchObject({ appId: 'zoom' });
    // Switching straight back to u1 restarts with u1's list.
    await other.start('u1');
    expect(other.silenced).toEqual(['zoom']);
    await other.stop();
  });

  it('"meeting starting": one prompt, not while recording or another prompt is up, gone after 2 min', async () => {
    await service.start('u1');
    service.startingSoon(event({ id: 'eventkit:sync', title: 'Weekly sync' }));
    expect(current()).toMatchObject({ kind: 'starting', title: 'Weekly sync', appId: null });
    expect(shown.at(-1)!.title).toBe('Weekly sync is starting');
    service.startingSoon(event({ id: 'eventkit:other', title: 'Other' }));
    expect(current()!.title).toBe('Weekly sync');
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(current()).toBeNull();

    service.setRecording(true);
    service.startingSoon(event({ id: 'eventkit:third', title: 'Third' }));
    expect(current()).toBeNull();
  });

  it('a detected call replaces a "starting" prompt; stop clears everything; off = no detector', async () => {
    await service.start('u1');
    service.startingSoon(event({ id: 'eventkit:sync', title: 'Weekly sync' }));
    mic.setApps([ZOOM]);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(current()).toMatchObject({ kind: 'detected' });
    expect(shown[0]!.closed).toBe(true);
    await service.stop();
    expect(current()).toBeNull();

    const off = create(null);
    await off.start('u1');
    expect(off.running).toBe(true);
    expect(off.prompt).toBeNull();
    await off.stop();
  });

  it('a mic-apps watch that dies is restarted', async () => {
    let fail: ((error: Error) => void) | undefined;
    let watches = 0;
    const flaky = {
      name: 'flaky',
      list: async () => [],
      watch: async (_onApps: unknown, onError: (error: Error) => void) => {
        watches++;
        fail = onError;
        return { stop: async () => {} };
      },
    };
    await service.stop();
    service = create(flaky as unknown as FixtureMicAppsSource);
    await service.start('u1');
    expect(watches).toBe(1);
    fail!(new Error('sidecar exited'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(watches).toBe(2);
  });
});
