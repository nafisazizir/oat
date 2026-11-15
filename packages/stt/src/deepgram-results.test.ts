import { describe, expect, it } from 'vitest';

import { isDeepgramResults, mapDeepgramResults, type DeepgramResults } from './deepgram-results.ts';

function results(
  start: number,
  duration: number,
  words: [string, number, number][],
  extra: Partial<DeepgramResults> = {},
): DeepgramResults {
  return {
    type: 'Results',
    start,
    duration,
    is_final: true,
    speech_final: true,
    channel: {
      alternatives: [
        {
          transcript: words.map((w) => w[0]).join(' '),
          confidence: 0.9,
          words: words.map(([w, s, e]) => ({
            word: w.toLowerCase().replace(/[^a-z]/g, ''),
            punctuated_word: w,
            start: s,
            end: e,
            confidence: 0.8,
          })),
        },
      ],
    },
    ...extra,
  };
}

/** Socket 0 = recording 10 s. */
const offset10s = (s: number) => 10_000 + s * 1000;

describe('mapDeepgramResults', () => {
  it('maps socket times onto the recording clock', () => {
    const { segment, chunkEndMs } = mapDeepgramResults(
      results(0, 2, [
        ['Hello', 0.5, 0.9],
        ['world.', 1.0, 1.4],
      ]),
      { source: 'system', toRecordingMs: offset10s, committedMs: undefined },
    );
    expect(chunkEndMs).toBe(12_000);
    expect(segment).toEqual({
      source: 'system',
      startMs: 10_500,
      endMs: 11_400,
      text: 'Hello world.',
      isFinal: true,
      speechFinal: true,
      confidence: 0.9,
      words: [
        { word: 'hello', punctuatedWord: 'Hello', startMs: 10_500, endMs: 10_900, confidence: 0.8 },
        {
          word: 'world',
          punctuatedWord: 'world.',
          startMs: 11_000,
          endMs: 11_400,
          confidence: 0.8,
        },
      ],
    });
  });

  it('interims carry no speechFinal', () => {
    const { segment } = mapDeepgramResults(
      results(0, 1, [['Hi', 0.1, 0.3]], { is_final: false, speech_final: false }),
      { source: 'mic', toRecordingMs: offset10s, committedMs: undefined },
    );
    expect(segment).toMatchObject({ isFinal: false, text: 'Hi' });
    expect(segment).not.toHaveProperty('speechFinal');
  });

  it('drops results entirely before the watermark (replayed duplicates)', () => {
    const { segment } = mapDeepgramResults(results(0, 2, [['Old', 0.5, 0.9]]), {
      source: 'mic',
      toRecordingMs: offset10s,
      committedMs: 12_000,
    });
    expect(segment).toBeNull();
  });

  it('trims words before the watermark from a straddling result', () => {
    const { segment } = mapDeepgramResults(
      results(0, 3, [
        ['Already', 0.2, 0.6],
        ['sent,', 0.7, 1.05],
        ['new', 1.1, 1.5],
        ['words.', 1.6, 2.0],
      ]),
      { source: 'mic', toRecordingMs: offset10s, committedMs: 11_000 },
    );
    // "sent," has its midpoint (10 875) before 11 000 → dropped; "new" starts after.
    expect(segment).toMatchObject({ text: 'new words.', startMs: 11_100, endMs: 12_000 });
  });

  it('clamps a kept word that starts before the watermark', () => {
    const { segment } = mapDeepgramResults(results(0, 2, [['word', 0.9, 1.3]]), {
      source: 'mic',
      toRecordingMs: offset10s,
      committedMs: 11_000,
    });
    expect(segment).toMatchObject({ startMs: 11_000, endMs: 11_300 });
    expect(segment!.words![0]!.startMs).toBe(11_000);
  });

  it('without words, keeps a straddling result only if most of it is new', () => {
    const noWords = (start: number, duration: number) =>
      ({
        type: 'Results',
        start,
        duration,
        is_final: true,
        channel: { alternatives: [{ transcript: 'text' }] },
      }) satisfies DeepgramResults;
    const ctx = { source: 'mic' as const, toRecordingMs: offset10s, committedMs: 11_000 };
    expect(mapDeepgramResults(noWords(0, 1.5), ctx).segment).toBeNull();
    expect(mapDeepgramResults(noWords(0.8, 1), ctx).segment).toMatchObject({
      startMs: 11_000,
      endMs: 11_800,
      text: 'text',
    });
  });

  it('returns no segment for an empty transcript but still reports the chunk end', () => {
    expect(
      mapDeepgramResults(results(3, 3, []), {
        source: 'mic',
        toRecordingMs: (s) => s * 1000,
        committedMs: undefined,
      }),
    ).toEqual({ segment: null, chunkEndMs: 6_000 });
  });
});

describe('isDeepgramResults', () => {
  it('recognises Results messages only', () => {
    expect(isDeepgramResults(results(0, 1, []))).toBe(true);
    expect(isDeepgramResults({ type: 'Metadata' })).toBe(false);
    expect(isDeepgramResults({ type: 'Results', start: 0 })).toBe(false);
    expect(isDeepgramResults(null)).toBe(false);
  });
});
