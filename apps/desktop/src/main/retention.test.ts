import { describe, expect, it } from 'vitest';

import {
  DAY_MS,
  GB,
  isProtected,
  MIN_AUDIO_AGE_MS,
  type MeetingUsage,
  planRetention,
} from './retention.ts';

const NOW = Date.UTC(2026, 10, 15, 12);
const MB = 1_000_000;

const meeting = (
  id: string,
  daysAgo: number,
  bytes: number,
  extra: Partial<MeetingUsage> = {},
) => ({
  meetingId: id,
  bytes,
  startedAt: NOW - daysAgo * DAY_MS,
  lastActivityAt: NOW - daysAgo * DAY_MS + 30 * 60_000,
  active: false,
  ...extra,
});

describe('planRetention', () => {
  const meetings = [
    meeting('m30', 30, 400 * MB),
    meeting('m10', 10, 300 * MB),
    meeting('m2', 2, 200 * MB),
    meeting('today', 0.01, 100 * MB), // ~15 min ago
  ];

  it('keep forever deletes nothing', () => {
    expect(planRetention(meetings, { kind: 'forever' }, NOW)).toEqual({
      meetingIds: [],
      bytes: 0,
      overCapAfter: false,
    });
  });

  it('age: deletes meetings whose newest audio is older than N days, oldest first', () => {
    expect(planRetention(meetings, { kind: 'age', days: 7 }, NOW)).toEqual({
      meetingIds: ['m30', 'm10'],
      bytes: 700 * MB,
      overCapAfter: false,
    });
    expect(planRetention(meetings, { kind: 'age', days: 60 }, NOW).meetingIds).toEqual([]);
    // Boundary: exactly N days old counts as older.
    const edge = [{ ...meeting('edge', 0, 1), lastActivityAt: NOW - 7 * DAY_MS }];
    expect(planRetention(edge, { kind: 'age', days: 7 }, NOW).meetingIds).toEqual(['edge']);
  });

  it('age: a meeting resumed recently is kept even if it started long ago', () => {
    const resumed = { ...meeting('resumed', 30, 50 * MB), lastActivityAt: NOW - 2 * DAY_MS };
    expect(planRetention([resumed], { kind: 'age', days: 7 }, NOW).meetingIds).toEqual([]);
  });

  it('size: deletes the oldest until the total fits under the cap', () => {
    // Total 1 GB. Cap 0.5 GB → drop m30 (400) → 600 > 500 → drop m10 (300) → 300 ≤ 500.
    expect(planRetention(meetings, { kind: 'size', gb: 0.5 }, NOW)).toEqual({
      meetingIds: ['m30', 'm10'],
      bytes: 700 * MB,
      overCapAfter: false,
    });
    expect(planRetention(meetings, { kind: 'size', gb: 0.7 }, NOW).meetingIds).toEqual(['m30']);
    expect(planRetention(meetings, { kind: 'size', gb: 1 }, NOW).meetingIds).toEqual([]);
    expect(planRetention(meetings, { kind: 'size', gb: 5 }, NOW).bytes).toBe(0);
  });

  it('size: protected meetings count towards the total but are never chosen', () => {
    const plan = planRetention(meetings, { kind: 'size', gb: 0.1 }, NOW);
    // Everything but "today" (15 min old) goes; still over the cap by today's 100 MB? 100 MB ≤ 100 MB.
    expect(plan.meetingIds).toEqual(['m30', 'm10', 'm2']);
    expect(plan.overCapAfter).toBe(false);
    const big = [meeting('old', 30, 100 * MB), meeting('live', 0, 2 * GB, { active: true })];
    expect(planRetention(big, { kind: 'size', gb: 1 }, NOW)).toEqual({
      meetingIds: ['old'],
      bytes: 100 * MB,
      overCapAfter: true,
    });
  });

  it('size: meetings with no bytes are skipped (they free nothing)', () => {
    const list = [meeting('empty', 40, 0), meeting('old', 30, 600 * MB)];
    expect(planRetention(list, { kind: 'size', gb: 0.5 }, NOW).meetingIds).toEqual(['old']);
  });

  it('ties on start time are broken deterministically', () => {
    const a = meeting('b', 10, 300 * MB);
    const b = meeting('a', 10, 300 * MB);
    expect(planRetention([a, b], { kind: 'size', gb: 0.3 }, NOW).meetingIds).toEqual(['a']);
  });
});

describe('sweeper safety', () => {
  it('never selects the active recording, under any policy', () => {
    const active = meeting('rec', 400, 5 * GB, { active: true });
    for (const policy of [
      { kind: 'age', days: 1 },
      { kind: 'size', gb: 0.1 },
    ] as const) {
      expect(planRetention([active], policy, NOW).meetingIds).toEqual([]);
    }
  });

  it('never selects audio with activity in the last hour (or in the future: clock skew)', () => {
    const recent = { ...meeting('recent', 30, GB), lastActivityAt: NOW - MIN_AUDIO_AGE_MS + 1 };
    const future = { ...meeting('future', 30, GB), lastActivityAt: NOW + DAY_MS };
    const hourOld = { ...meeting('hour', 30, GB), lastActivityAt: NOW - MIN_AUDIO_AGE_MS };
    expect(isProtected(recent, NOW)).toBe(true);
    expect(isProtected(future, NOW)).toBe(true);
    expect(isProtected(hourOld, NOW)).toBe(false);
    expect(
      planRetention([recent, future, hourOld], { kind: 'size', gb: 0.1 }, NOW).meetingIds,
    ).toEqual(['hour']);
    expect(
      planRetention([recent, future, hourOld], { kind: 'age', days: 1 }, NOW).meetingIds,
    ).toEqual([]);
  });
});
