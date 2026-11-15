import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AutoStopNoticeSnapshot, RecordingSnapshot } from '@oat/core/bridge';
import { type MeetingEndedAction, timelineEvent } from '@oat/detection';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AutoStopService, AutoStopServiceError } from './auto-stop-service.ts';
import type { NotifyRequest } from './detection-service.ts';

const T0 = Date.parse('2026-11-16T17:00:00Z');
const MIN = 60_000;
const WEEKLY = timelineEvent({
  id: 'weekly',
  title: 'Weekly sync',
  start: '2026-11-16T17:00:00Z',
  end: '2026-11-16T17:30:00Z',
});

let dir: string;
let notices: (AutoStopNoticeSnapshot | null)[];
let shown: (NotifyRequest & { closed: boolean })[];
let stop: ReturnType<typeof vi.fn>;
let opened: number;
let service: AutoStopService;

function create() {
  return new AutoStopService({
    settingsFile: join(dir, 'auto-stop.json'),
    // The 30 s confirmation is the reducer's (fixtures); here decisions come at the end itself.
    config: { confirmMs: 0 },
    stop: stop as never,
    eventOf: (meetingId) => (meetingId === 'm-weekly' ? WEEKLY.id : null),
    notify: (request) => {
      const entry = { ...request, closed: false };
      shown.push(entry);
      return { close: () => void (entry.closed = true) };
    },
    onNotice: (n) => notices.push(n),
    onOpen: () => void (opened += 1),
  });
}

const loud = { rmsDb: -20, peakDb: -10 };
const snap = (
  status: RecordingSnapshot['status'],
  meetingId: string | null = 'm-weekly',
  levels: RecordingSnapshot['levels'] = { mic: loud, system: null },
) => ({ status, meetingId, levels });

const ended = (endedAt: number, extra: Partial<MeetingEndedAction> = {}): MeetingEndedAction => ({
  type: 'meetingEnded',
  at: new Date(endedAt + 2000),
  startedAt: new Date(T0),
  endedAt: new Date(endedAt),
  appIds: ['zoom'],
  recording: true,
  recordingStartedDuringMeeting: true,
  prompted: true,
  eventId: null,
  ...extra,
});

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  dir = mkdtempSync(join(tmpdir(), 'oat-autostop-'));
  notices = [];
  shown = [];
  opened = 0;
  stop = vi.fn(async () => ({}));
  service = create();
  service.setEvents([WEEKLY]);
});

afterEach(() => {
  service.dispose();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const current = () => notices.at(-1) ?? null;

describe('AutoStopService (7.5)', () => {
  it('call over at the event’s end → toast + notification → stops after the undo window', async () => {
    service.recordingState(snap('starting'));
    service.recordingState(snap('recording'));
    await vi.advanceTimersByTimeAsync(29 * MIN);
    service.meetingEnded(ended(T0 + 29 * MIN));
    expect(current()).toMatchObject({
      kind: 'stopping',
      reason: 'meeting_ended',
      stopAt: T0 + 29 * MIN + 10_000,
    });
    expect(shown.map((s) => s.title)).toEqual(['Stopping the recording']);
    shown[0]!.onClick();
    expect(opened).toBe(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(current()).toBeNull();
    expect(shown[0]!.closed).toBe(true);
  });

  it('"Keep recording" undoes it; stale answers are refused', async () => {
    service.recordingState(snap('recording'));
    await vi.advanceTimersByTimeAsync(29 * MIN);
    service.meetingEnded(ended(T0 + 29 * MIN));
    const id = current()!.id;
    await expect(service.respond('nope', 'keep')).rejects.toBeInstanceOf(AutoStopServiceError);
    await service.respond(id, 'keep');
    expect(current()).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stop).not.toHaveBeenCalled();
    await expect(service.respond(id, 'keep')).rejects.toThrow(/no longer on screen/);
  });

  it('"Meeting over?" → "Stop recording" stops now; the stop ends the notice', async () => {
    service.recordingState(snap('recording', 'other'));
    await vi.advanceTimersByTimeAsync(10 * MIN);
    service.meetingEnded(ended(T0 + 10 * MIN));
    expect(current()).toMatchObject({ kind: 'ask', reason: 'meeting_ended', stopAt: null });
    expect(shown.at(-1)?.title).toBe('Meeting over?');
    await service.respond(current()!.id, 'stop');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(current()).toBeNull();
    service.recordingState(snap('stopping', 'other'));
    service.recordingState(snap('idle', null));
    expect(notices.filter((n) => n === null)).toHaveLength(1);
  });

  it('silence: levels only matter when they cross the threshold; paused time doesn’t count', async () => {
    const quiet = { mic: { rmsDb: -90, peakDb: -80 }, system: null };
    service.recordingState(snap('recording', null, quiet));
    await vi.advanceTimersByTimeAsync(5 * MIN);
    service.recordingState(snap('paused', null, quiet));
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(current()).toBeNull();
    service.recordingState(snap('recording', null, quiet));
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(current()).toMatchObject({ kind: 'ask', reason: 'silence' });
    service.recordingState(snap('recording', null, { mic: loud, system: null }));
    expect(current()).toBeNull();
  });

  it('settings: on by default, saved per Mac, read back; a bad file means defaults', () => {
    expect(service.settings).toEqual({ enabled: true, inPerson: false });
    expect(service.setSettings({ inPerson: true })).toEqual({ enabled: true, inPerson: true });
    expect(JSON.parse(readFileSync(join(dir, 'auto-stop.json'), 'utf8'))).toEqual({
      enabled: true,
      inPerson: true,
    });
    expect(create().settings).toEqual({ enabled: true, inPerson: true });
    writeFileSync(join(dir, 'auto-stop.json'), '{"enabled":"yes"}');
    expect(create().settings).toEqual({ enabled: true, inPerson: false });
  });

  it('switched off: a clearly-over call is asked about instead', async () => {
    service.setSettings({ enabled: false });
    service.recordingState(snap('recording'));
    await vi.advanceTimersByTimeAsync(29 * MIN);
    service.meetingEnded(ended(T0 + 29 * MIN));
    expect(current()).toMatchObject({ kind: 'ask' });
  });

  it('the call’s app coming back takes the toast away (the other side talking: asked instead)', async () => {
    service.recordingState(snap('recording'));
    service.appsChanged(['zoom']);
    await vi.advanceTimersByTimeAsync(29 * MIN);
    service.appsChanged([]);
    service.meetingEnded(ended(T0 + 29 * MIN));
    expect(current()).toMatchObject({ kind: 'stopping' });
    service.appsChanged(['zoom']);
    expect(current()).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stop).not.toHaveBeenCalled();
    // Zoom lets go again while the other side is still audible: a question, not a stop.
    service.recordingState(snap('recording', 'm-weekly', { mic: loud, system: loud }));
    service.appsChanged([]);
    await vi.advanceTimersByTimeAsync(5_000);
    service.meetingEnded(
      ended(T0 + 30 * MIN, { recordingStartedDuringMeeting: false, prompted: false }),
    );
    expect(current()).toMatchObject({ kind: 'ask', reason: 'meeting_ended' });
  });
});
