import { describe, expect, it } from 'vitest';

import {
  clampWidth,
  formatClock,
  formatDuration,
  initials,
  isNearBottom,
  isPlausibleEmail,
  meetingWhen,
  mergeTranscripts,
  shortWhen,
  speakerOf,
  startsGroup,
  type TranscriptItem,
} from './format.ts';

const seg = (
  id: string,
  source: 'mic' | 'system',
  startMs: number,
  extra = {},
): TranscriptItem => ({
  id,
  source,
  startMs,
  endMs: startMs + 1000,
  text: id,
  ...extra,
});

describe('format', () => {
  it('formats clocks and durations', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(65_400)).toBe('1:05');
    expect(formatClock(3_723_000)).toBe('1:02:03');
    expect(formatClock(-5)).toBe('0:00');
    expect(formatDuration(30_000)).toBe('under a minute');
    expect(formatDuration(12 * 60_000 + 59_000)).toBe('12 min');
    expect(formatDuration(60 * 60_000)).toBe('1 h');
    expect(formatDuration(65 * 60_000)).toBe('1 h 5 min');
  });

  it('labels speakers and groups lines by speaker and pauses', () => {
    expect(speakerOf({ source: 'mic' })).toBe('Me');
    expect(speakerOf({ source: 'system' })).toBe('Them');
    expect(speakerOf({ source: 'system', speaker: ' Dana ' })).toBe('Dana');
    const a = seg('a', 'system', 0);
    expect(startsGroup(a, undefined)).toBe(true);
    expect(startsGroup(seg('b', 'system', 2000), a)).toBe(false);
    expect(startsGroup(seg('b', 'mic', 2000), a)).toBe(true);
    expect(startsGroup(seg('b', 'system', 2000, { speaker: 'Dana' }), a)).toBe(true);
    expect(startsGroup(seg('b', 'system', 40_000), a)).toBe(true);
  });

  it('knows when a scroller is at the bottom', () => {
    expect(isNearBottom({ scrollTop: 952, scrollHeight: 1500, clientHeight: 500 })).toBe(true);
    expect(isNearBottom({ scrollTop: 900, scrollHeight: 1500, clientHeight: 500 })).toBe(false);
  });

  it('merges stored and live transcripts: live wins per id, time order', () => {
    const stored = [seg('s1', 'mic', 0), seg('s2', 'system', 5000)];
    const live = [seg('s2', 'system', 5000, { text: 'newer' }), seg('l1', 'mic', 3000)];
    expect(mergeTranscripts(stored, live).map((s) => [s.id, s.text])).toEqual([
      ['s1', 's1'],
      ['l1', 'l1'],
      ['s2', 'newer'],
    ]);
    expect(mergeTranscripts(stored, [])).toEqual(stored);
    expect(mergeTranscripts([], live)).toEqual(live);
    // Same start: me first, then by id.
    expect(
      mergeTranscripts([seg('b', 'system', 0)], [seg('a', 'system', 0), seg('c', 'mic', 0)]).map(
        (s) => s.id,
      ),
    ).toEqual(['c', 'a', 'b']);
  });

  it('makes initials', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('Grace Brewster Murray Hopper')).toBe('GH');
    expect(initials('ada@example.com')).toBe('A');
    expect(initials('')).toBe('?');
  });

  it('describes when a meeting happened', () => {
    const start = '2026-11-14T15:04:00.000Z';
    const end = '2026-11-14T15:16:30.000Z';
    expect(meetingWhen(start, end, Date.parse(end) + 1000, 'UTC')).toEqual({
      label: 'Sat, Nov 14 · 3:04 PM UTC',
      duration: '12 min',
      inProgress: false,
    });
    // No end yet: in progress for a while, then just a date (a recording that never ended).
    const live = meetingWhen(start, null, Date.parse(start) + 5 * 60_000, 'UTC');
    expect(live).toMatchObject({ inProgress: true, duration: '5 min' });
    expect(meetingWhen(start, null, Date.parse(start) + 7 * 3_600_000, 'UTC')).toMatchObject({
      inProgress: false,
      duration: null,
    });
    expect(meetingWhen(null, null, 0)).toEqual({ label: null, duration: null, inProgress: false });
    expect(meetingWhen('garbage', null, 0).label).toBeNull();
    // Local zone: no zone name.
    expect(meetingWhen(start, end, Date.parse(end)).label).not.toContain('UTC');
  });

  it('writes short list dates', () => {
    const now = new Date(2026, 10, 14, 18, 0).getTime();
    expect(shortWhen(new Date(2026, 10, 14, 15, 4).toISOString(), now)).toBe('3:04 PM');
    expect(shortWhen(new Date(2026, 10, 2, 9, 0).toISOString(), now)).toBe('Nov 2');
    expect(shortWhen(new Date(2025, 0, 5).toISOString(), now)).toBe('Jan 5, 2025');
    expect(shortWhen(null, now)).toBe('');
  });

  it('clamps panel widths and checks emails', () => {
    expect(clampWidth(100, 260, 640, 360)).toBe(260);
    expect(clampWidth(900, 260, 640, 360)).toBe(640);
    expect(clampWidth(Number.NaN, 260, 640, 360)).toBe(360);
    expect(clampWidth(300.4, 260, 640, 360)).toBe(300);
    expect(isPlausibleEmail('a@b.co')).toBe(true);
    expect(isPlausibleEmail('a@b')).toBe(false);
    expect(isPlausibleEmail('a b@c.de')).toBe(false);
  });
});
