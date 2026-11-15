import type { LiveSegment } from '@oat/core/bridge';
import { transcriptBatchSchema, liveSegmentSchema } from '@oat/core/bridge';
import { describe, expect, it } from 'vitest';

import { compareSegments, formatClock, isRetraction, TranscriptStore } from './transcript.ts';

const seg = (
  id: string,
  text: string,
  isFinal: boolean,
  startMs = 0,
  source: 'mic' | 'system' = 'mic',
): LiveSegment => ({ id, source, startMs, endMs: startMs + 1000, text, isFinal });

describe('TranscriptStore (merge by id, D-19)', () => {
  it('an interim is replaced by newer interims, then by its final', () => {
    const store = new TranscriptStore();
    store.apply([seg('a', 'morning', false)]);
    store.apply([seg('a', 'morning every', false)]);
    expect(store.segments).toEqual([seg('a', 'morning every', false)]);
    store.apply([seg('a', 'Morning, everyone.', true)]);
    expect(store.segments).toEqual([seg('a', 'Morning, everyone.', true)]);
    expect(store.size).toBe(1);
  });

  it('a retraction (final with empty text) removes the interim', () => {
    const store = new TranscriptStore();
    store.apply([seg('a', 'uh', false), seg('b', 'hello', true, 2000)]);
    const retraction = seg('a', '', true);
    expect(isRetraction(retraction)).toBe(true);
    expect(store.apply([retraction])).toBe(true);
    expect(store.segments.map((s) => s.id)).toEqual(['b']);
    // Retracting something unknown changes nothing.
    expect(store.apply([seg('zzz', '', true)])).toBe(false);
  });

  it('a late interim never downgrades a final', () => {
    const store = new TranscriptStore();
    store.apply([seg('a', 'final text', true)]);
    expect(store.apply([seg('a', 'stale interim', false)])).toBe(false);
    expect(store.get('a')).toEqual(seg('a', 'final text', true));
  });

  it('keeps time order across sources, stable for ties, and reports no-op updates', () => {
    const store = new TranscriptStore();
    store.apply([
      seg('3', 'them later', true, 3000, 'system'),
      seg('2', 'them same time', true, 1000, 'system'),
      seg('1', 'me first', true, 1000, 'mic'),
    ]);
    expect(store.segments.map((s) => s.id)).toEqual(['1', '2', '3']);
    const before = store.segments;
    expect(store.apply([seg('1', 'me first', true, 1000, 'mic')])).toBe(false);
    expect(store.segments).toBe(before); // cached array, not rebuilt
    store.apply([seg('0', 'earliest', false, 0, 'system')]);
    expect(store.segments).not.toBe(before); // replaced, never mutated
    expect(before.map((s) => s.id)).toEqual(['1', '2', '3']);
    expect(store.segments.map((s) => s.id)).toEqual(['0', '1', '2', '3']);
  });

  it('applies a batch in order (interim, final and retraction of different ids in one go)', () => {
    const store = new TranscriptStore();
    store.apply([
      seg('a', 'x', false),
      seg('a', 'x y', true),
      seg('b', 'z', false),
      seg('b', '', true),
    ]);
    expect(store.segments).toEqual([seg('a', 'x y', true)]);
    store.clear();
    expect(store.segments).toEqual([]);
  });

  it('compareSegments: start, then mic before system, then id', () => {
    expect(compareSegments(seg('b', '', true, 1), seg('a', '', true, 2))).toBeLessThan(0);
    expect(
      compareSegments(seg('b', '', true, 1, 'mic'), seg('a', '', true, 1, 'system')),
    ).toBeLessThan(0);
    expect(compareSegments(seg('a', '', true, 1), seg('b', '', true, 1))).toBeLessThan(0);
  });
});

describe('formatClock', () => {
  it('m:ss under an hour, h:mm:ss after', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(65_400)).toBe('1:05');
    expect(formatClock(3_725_000)).toBe('1:02:05');
    expect(formatClock(-5)).toBe('0:00');
  });
});

describe('bridge transcript shapes', () => {
  it('validate segments and batches', () => {
    expect(liveSegmentSchema.safeParse(seg('a', 'hi', false)).success).toBe(true);
    expect(liveSegmentSchema.safeParse({ ...seg('a', 'hi', false), source: 'both' }).success).toBe(
      false,
    );
    expect(transcriptBatchSchema.safeParse({ meetingId: 'm', seq: 0, segments: [] }).success).toBe(
      false,
    );
    expect(
      transcriptBatchSchema.safeParse({ meetingId: 'm', seq: 1, segments: [seg('a', '', true)] })
        .success,
    ).toBe(true);
  });
});
