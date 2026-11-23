import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LiveSegment } from '@oat/core/bridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MeetingEndGrace, type PendingEnd } from './meeting-end-grace.ts';
import type { TranscriptPersistence } from './recording-service.ts';

const T0 = Date.parse('2026-11-16T17:30:00Z');

let calls: string[];
let user: string | null;
let changes: (PendingEnd | null)[];
let inner: TranscriptPersistence;

function grace(graceMs = 60_000) {
  return new MeetingEndGrace({
    inner,
    graceMs,
    userId: () => user,
    onChange: (p) => changes.push(p && { ...p }),
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  calls = [];
  user = 'u1';
  changes = [];
  inner = {
    prepareMeeting: async (id) => (at) => void calls.push(`begin ${id} ${at - T0}`),
    saveSegment: (id, s) => void calls.push(`segment ${id} ${s.id}`),
    meetingEndMs: () => 42,
    endMeeting: (id, at) => void calls.push(`end ${id} ${at - T0}`),
  };
});
afterEach(() => vi.useRealTimers());

describe('MeetingEndGrace (7.5)', () => {
  it('writes the end (with the stop time) only when the grace period runs out', async () => {
    const g = grace();
    const begin = await g.prepareMeeting('m1', T0);
    begin(T0);
    g.endMeeting('m1', T0 + 1000);
    expect(calls).toEqual(['begin m1 0']);
    expect(g.pending).toMatchObject({ meetingId: 'm1', endedAt: T0 + 1000, dueAt: T0 + 60_000 });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(calls).toEqual(['begin m1 0']);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(['begin m1 0', 'end m1 1000']);
    expect(g.pending).toBeNull();
    expect(changes.map((c) => c?.meetingId ?? null)).toEqual(['m1', null]);
  });

  it('"Continue recording" within the grace period: the end is never written', async () => {
    const g = grace();
    g.endMeeting('m1', T0);
    await vi.advanceTimersByTimeAsync(59_000);
    const resume = await g.prepareMeeting('m1', T0 + 59_000);
    expect(g.pending?.meetingId).toBe('m1');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(g.flush('m1')).toBe(false); // A stale "Finish now" click cannot end the resuming meeting.
    expect(calls).toEqual([]);
    resume(T0 + 61_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toEqual(['begin m1 61000']);
    // Stopped again: a fresh grace period from the new stop.
    g.endMeeting('m1', T0 + 181_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual(['begin m1 61000', 'end m1 181000']);
  });

  it.each([500, 2000])(
    'a canceled restart keeps the original end after waiting %i ms',
    async (wait) => {
      const g = grace();
      g.endMeeting('m1', T0);
      await vi.advanceTimersByTimeAsync(59_000);
      await g.prepareMeeting('m1', T0 + 59_000);
      await vi.advanceTimersByTimeAsync(wait);
      expect(calls).toEqual([]);
      g.cancelMeetingStart('m1');
      if (wait < 1000) {
        expect(calls).toEqual([]);
        await vi.advanceTimersByTimeAsync(1000 - wait);
      }
      expect(calls).toEqual(['end m1 0']);
    },
  );

  it('another meeting starting, "Finish now" and quit end it at once', async () => {
    const g = grace();
    g.endMeeting('m1', T0);
    const begin = await g.prepareMeeting('m2', T0 + 5000);
    begin(T0 + 5000);
    expect(calls).toEqual(['end m1 0', 'begin m2 5000']);
    g.endMeeting('m2', T0 + 9000);
    g.flush('other');
    expect(g.pending?.meetingId).toBe('m2');
    g.flush('m2');
    g.flush();
    expect(calls).toEqual(['end m1 0', 'begin m2 5000', 'end m2 9000']);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toHaveLength(3);
  });

  it('never writes into another account’s database', () => {
    const g = grace();
    g.endMeeting('m1', T0);
    user = 'u2';
    g.flush();
    user = null;
    g.endMeeting('m2', T0);
    user = 'u1';
    g.flush();
    expect(calls).toEqual([]);
  });

  it('grace 0 writes at once; segments and the transcript end pass through', () => {
    const g = grace(0);
    g.saveSegment('m1', { id: 's1' } as LiveSegment);
    expect(g.meetingEndMs('m1')).toBe(42);
    g.endMeeting('m1', T0);
    expect(calls).toEqual(['segment m1 s1', 'end m1 0']);
    expect(g.pending).toBeNull();
  });
});

describe('MeetingEndGrace — durable (7.5 review)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oat-grace-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const durable = () =>
    new MeetingEndGrace({ inner, graceMs: 60_000, userId: () => user, file: join(dir, 'g.json') });

  it('a crash inside the period: the next launch ends the meeting once its account’s database opens', async () => {
    const first = durable();
    first.endMeeting('m1', T0 + 1000);
    expect(existsSync(join(dir, 'g.json'))).toBe(true);
    await first.prepareMeeting('m1', T0 + 2000);
    first.dispose(); // the process dies: nothing written
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(calls).toEqual([]);

    user = null; // relaunch: no database open yet
    const second = durable();
    expect(second.parked).toMatchObject([{ meetingId: 'm1', endedAt: T0 + 1000, userId: 'u1' }]);
    second.accountOpened('u2'); // someone else's database: untouched
    expect(calls).toEqual([]);
    user = 'u1';
    second.accountOpened('u1');
    expect(calls).toEqual(['end m1 1000']);
    expect(second.parked).toEqual([]);
    expect(existsSync(join(dir, 'g.json'))).toBe(false);
  });

  it('a relaunch inside the period re-arms the rest of it (and "Continue recording" still cancels)', async () => {
    const first = durable();
    first.endMeeting('m1', T0);
    first.dispose();
    await vi.advanceTimersByTimeAsync(20_000);
    const second = durable();
    second.accountOpened('u1');
    expect(second.pending).toMatchObject({ meetingId: 'm1', dueAt: T0 + 60_000 });
    await vi.advanceTimersByTimeAsync(39_999);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(['end m1 0']);

    const third = durable();
    third.endMeeting('m2', T0 + 60_000);
    third.dispose();
    const fourth = durable();
    const resume = await fourth.prepareMeeting('m2', T0 + 70_000);
    resume(T0 + 70_000); // continued after the relaunch, before the database event
    fourth.accountOpened('u1');
    expect(calls).toEqual(['end m1 0', 'begin m2 70000']);
    expect(existsSync(join(dir, 'g.json'))).toBe(false);
  });

  it('due while another account’s database is open: parked, ended when it opens again', async () => {
    const g = durable();
    g.endMeeting('m1', T0);
    user = 'u2';
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual([]);
    expect(durable().parked).toHaveLength(1); // on disk
    user = 'u1';
    g.accountOpened('u1');
    expect(calls).toEqual(['end m1 0']);
  });

  it('a corrupt file is ignored', () => {
    writeFileSync(join(dir, 'g.json'), '{"ends": [{"meetingId": 4}]}');
    expect(durable().parked).toEqual([]);
  });
});
