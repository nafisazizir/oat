import { describe, expect, it } from 'vitest';

import {
  backfillSegmentId,
  mergeBackfill,
  mergeSpans,
  SessionCoverage,
  spanLength,
  subtractSpans,
} from './transcript-gaps.ts';

const span = (startMs: number, endMs: number) => ({ startMs, endMs });

describe('span math', () => {
  it('merges overlapping and touching spans, drops empty ones', () => {
    expect(
      mergeSpans([span(50, 60), span(0, 10), span(10, 20), span(15, 30), span(40, 40)]),
    ).toEqual([span(0, 30), span(50, 60)]);
    expect(spanLength([span(0, 10), span(5, 20), span(30, 31)])).toBe(21);
  });

  it('subtracts spans', () => {
    expect(subtractSpans(span(0, 100), [span(10, 20), span(15, 30), span(90, 200)])).toEqual([
      span(0, 10),
      span(30, 90),
    ]);
    expect(subtractSpans(span(0, 100), [span(-5, 200)])).toEqual([]);
    expect(subtractSpans(span(0, 100), [])).toEqual([span(0, 100)]);
    expect(subtractSpans(span(50, 50), [])).toEqual([]);
  });
});

describe('SessionCoverage', () => {
  it('reports lost ranges clipped to the audio, merged, at least MIN_GAP_MS long', () => {
    const c = new SessionCoverage();
    c.audio('mic', 1000, 61_000);
    c.lost('mic', 5000, 20_000);
    c.lost('mic', 19_000, 30_000); // overlaps: merged
    c.lost('mic', 59_900, 70_000); // clipped to the audio end → 1.1 s
    c.lost('mic', 40_000, 40_200); // too short
    expect(c.gaps()).toEqual([
      { source: 'mic', startMs: 5000, endMs: 30_000 },
      { source: 'mic', startMs: 59_900, endMs: 61_000 },
    ]);
  });

  it('an unfinished stream loses from its watermark, else its last final, else its first audio', () => {
    const c = new SessionCoverage();
    c.audio('mic', 0, 30_000);
    c.audio('system', 0, 30_000);
    c.final('mic', 12_000);
    c.unfinished('mic', 20_000); // watermark known (silence after the last final was finalized too)
    c.unfinished('system', undefined); // never finalized anything
    expect(c.gaps()).toEqual([
      { source: 'system', startMs: 0, endMs: 30_000 },
      { source: 'mic', startMs: 20_000, endMs: 30_000 },
    ]);
    const d = new SessionCoverage();
    d.audio('mic', 0, 30_000);
    d.final('mic', 12_000);
    d.unfinished('mic', undefined);
    expect(d.gaps()).toEqual([{ source: 'mic', startMs: 12_000, endMs: 30_000 }]);
    // A source without audio has nothing to lose.
    d.unfinished('system', undefined);
    expect(d.sources()).toEqual(['mic']);
  });
});

describe('backfillSegmentId', () => {
  it('is stable, UUID-shaped and distinct per meeting/source/start', () => {
    const a = backfillSegmentId('m1', 'mic', 1000);
    expect(a).toBe(backfillSegmentId('m1', 'mic', 1000.2));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(
      new Set([
        a,
        backfillSegmentId('m1', 'system', 1000),
        backfillSegmentId('m2', 'mic', 1000),
        backfillSegmentId('m1', 'mic', 1001),
      ]).size,
    ).toBe(4);
  });
});

describe('mergeBackfill', () => {
  const w = (word: string, startMs: number, endMs: number) => ({
    word: word.toLowerCase(),
    punctuatedWord: word,
    startMs,
    endMs,
  });
  const seg = (words: ReturnType<typeof w>[], source: 'mic' | 'system' = 'mic') => ({
    source,
    startMs: words[0]!.startMs,
    endMs: words.at(-1)!.endMs,
    text: words.map((x) => x.punctuatedWord).join(' '),
    isFinal: true,
    words,
  });

  it('drops words already transcribed or outside the range, splits utterances there', () => {
    const merged = mergeBackfill({
      meetingId: 'm1',
      source: 'mic',
      range: span(10_000, 40_000),
      existing: [span(14_000, 16_000)], // a live final
      segments: [
        seg([w('Before', 9000, 9800), w('edge', 9900, 10_400), w('one', 10_500, 11_000)]),
        seg([w('two', 12_000, 13_000), w('dup', 14_200, 15_000), w('three', 16_500, 17_000)]),
        seg([w('theirs', 20_000, 21_000)], 'system'),
        seg([w('after', 39_900, 40_500)]),
      ],
    });
    expect(merged.map((s) => [s.text, s.startMs, s.endMs])).toEqual([
      ['edge one', 9900, 11_000],
      ['two', 12_000, 13_000],
      ['three', 16_500, 17_000],
    ]);
    expect(merged.every((s) => s.source === 'mic')).toBe(true);
    expect(merged[0]!.id).toBe(backfillSegmentId('m1', 'mic', 9900));
  });

  it('is idempotent: a re-run over its own output adds nothing', () => {
    const input = {
      meetingId: 'm1',
      source: 'mic' as const,
      range: span(0, 10_000),
      segments: [
        seg([w('Hello', 1000, 1500), w('there.', 1600, 2000)]),
        seg([w('Bye.', 5000, 5400)]),
      ],
    };
    const first = mergeBackfill({ ...input, existing: [] });
    expect(first.map((s) => s.text)).toEqual(['Hello there.', 'Bye.']);
    expect(mergeBackfill({ ...input, existing: first })).toEqual([]);
  });

  it('keeps word-less segments only when they overlap nothing', () => {
    const plain = (startMs: number, endMs: number, text: string) => ({
      source: 'mic' as const,
      startMs,
      endMs,
      text,
      isFinal: true,
    });
    const merged = mergeBackfill({
      meetingId: 'm1',
      source: 'mic',
      range: span(0, 10_000),
      existing: [span(4000, 6000)],
      segments: [plain(1000, 2000, 'kept'), plain(5000, 7000, 'overlaps'), plain(8000, 9000, '  ')],
    });
    expect(merged.map((s) => s.text)).toEqual(['kept']);
  });
});
