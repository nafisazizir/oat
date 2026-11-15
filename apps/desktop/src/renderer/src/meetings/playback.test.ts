import type { PlaybackPart } from '@oat/core/bridge';
import { describe, expect, it, vi } from 'vitest';

import {
  clampMs,
  isSource,
  isSpeed,
  nextSpeed,
  partAt,
  PlaybackClock,
  playbackNotice,
  scrubberSpans,
  seekTarget,
  skipGap,
} from './playback.ts';

// Two recording sessions with a 10 s hole between them (e.g. part 2 of "system" failed and part 3 resumed).
const parts: PlaybackPart[] = [
  { part: 1, startMs: 0, endMs: 20_000, sources: ['mic', 'system'], partial: false },
  { part: 3, startMs: 30_000, endMs: 50_000, sources: ['mic'], partial: true },
];
const DURATION = 50_000;

describe('seek mapping across parts and gaps', () => {
  it('a time inside a part is used as is', () => {
    expect(partAt(parts, 0)?.part).toBe(1);
    expect(partAt(parts, 19_999)?.part).toBe(1);
    expect(partAt(parts, 35_000)?.part).toBe(3);
    expect(seekTarget(parts, 12_345, DURATION)).toBe(12_345);
    expect(seekTarget(parts, 30_000, DURATION)).toBe(30_000);
  });

  it('a time in the hole lands on the next part; out of range is clamped', () => {
    expect(partAt(parts, 25_000)).toBeUndefined();
    expect(seekTarget(parts, 25_000, DURATION)).toBe(30_000);
    expect(seekTarget(parts, 20_000, DURATION)).toBe(30_000);
    expect(seekTarget(parts, -5, DURATION)).toBe(0);
    expect(seekTarget(parts, 99_000, DURATION)).toBe(DURATION);
    expect(seekTarget(parts, Number.NaN, DURATION)).toBe(0);
    expect(seekTarget([], 1234, DURATION)).toBe(1234);
  });

  it('while playing, a hole worth skipping jumps to the next part; a tiny one plays through', () => {
    expect(skipGap(parts, 10_000)).toBeNull();
    expect(skipGap(parts, 20_050)).toBe(30_000);
    expect(skipGap(parts, 29_000)).toBe(30_000);
    expect(skipGap(parts, 50_000)).toBeNull(); // the end: nothing after
    const tight: PlaybackPart[] = [
      { part: 1, startMs: 0, endMs: 1000, sources: ['mic'], partial: false },
      { part: 2, startMs: 1200, endMs: 2000, sources: ['mic'], partial: false },
    ];
    expect(skipGap(tight, 1100)).toBeNull();
  });

  it('clamps', () => {
    expect(clampMs(-1, 10)).toBe(0);
    expect(clampMs(11, 10)).toBe(10);
    expect(clampMs(Infinity, 10)).toBe(0);
  });
});

describe('scrubber', () => {
  it('draws each part and the holes, in percent of the meeting clock', () => {
    const spans = scrubberSpans(parts, DURATION);
    expect(spans.map((s) => [s.kind, s.left, s.width])).toEqual([
      ['part', 0, 40],
      ['gap', 40, 20],
      ['part', 60, 40],
    ]);
    expect(spans[2]).toMatchObject({ part: 3, partial: true });
  });

  it('a hole before the first part and after the last is drawn too; empty timeline draws nothing', () => {
    const late: PlaybackPart[] = [
      { part: 2, startMs: 5000, endMs: 8000, sources: ['system'], partial: false },
    ];
    expect(scrubberSpans(late, 10_000).map((s) => s.kind)).toEqual(['gap', 'part', 'gap']);
    expect(scrubberSpans(parts, 0)).toEqual([]);
  });
});

describe('controls', () => {
  it('speed cycles 1× → 1.25× → 1.5× → 2× → 1×', () => {
    expect([1, 1.25, 1.5, 2].map(nextSpeed)).toEqual([1.25, 1.5, 2, 1]);
    expect(nextSpeed(3)).toBe(1);
    expect(isSpeed(1.5)).toBe(true);
    expect(isSpeed(3)).toBe(false);
    expect(isSource('mix')).toBe(true);
    expect(isSource('both')).toBe(false);
  });

  it('says why there is nothing to play', () => {
    expect(playbackNotice('available')).toBeNull();
    expect(playbackNotice('deleted')?.title).toBe('Audio deleted');
    expect(playbackNotice('other-device')?.title).toBe('Audio is on another device');
    expect(playbackNotice('recording')?.title).toBe('Recording');
    expect(playbackNotice('none')?.title).toBe('No audio');
  });

  it('the clock notifies only on change', () => {
    const clock = new PlaybackClock();
    const listener = vi.fn();
    const off = clock.subscribe(listener);
    clock.set(100);
    clock.set(100);
    clock.set(200);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(clock.ms).toBe(200);
    off();
    clock.set(300);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
