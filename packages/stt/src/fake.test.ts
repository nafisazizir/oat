import { describe, expect, it } from 'vitest';

import { describeSttContract } from './contract.testsuite.ts';
import { FakeSttProvider, parseGroundTruth, wordsOf } from './fake.ts';
import { finals, finalText, groundTruth, interims, pipeFixture, truthText } from './test-utils.ts';

const truth = groundTruth('standup-short');

describeSttContract('FakeSttProvider', {
  provider: ({ fixture }) => new FakeSttProvider({ segments: groundTruth(fixture) }),
});

describe('FakeSttProvider', () => {
  it('emits an interim at each segment midpoint and the final at its end, with ground-truth times', async () => {
    const records = await pipeFixture(new FakeSttProvider({ segments: truth }), {
      fixture: 'standup-short',
    });
    const mic = records.mic;
    const micTruth = truth.filter((t) => t.source === 'mic');
    expect(finals(mic).map((s) => [s.startMs, s.endMs, s.text])).toEqual(
      micTruth.map((t) => [t.startMs, t.endMs, t.text]),
    );
    expect(interims(mic)).toHaveLength(micTruth.length);
    const first = interims(mic)[0]!;
    expect(first.endMs).toBe(Math.round((micTruth[0]!.startMs + micTruth[0]!.endMs) / 2));
    expect(micTruth[0]!.text.startsWith(first.text)).toBe(true);
    expect(first.text.length).toBeLessThan(micTruth[0]!.text.length);
  });

  it('injected latency delays segments', async () => {
    const records = await pipeFixture(new FakeSttProvider({ segments: truth, latencyMs: 150 }), {
      fixture: 'standup-short',
      speed: 4,
      durationMs: 6_000,
    });
    const mic = records.mic;
    const seg = mic.segments[0]!;
    const writeAt = mic.writes.find((w) => w.endUs / 1000 >= seg.endMs)!.at;
    expect(mic.arrivals[0]! - writeAt).toBeGreaterThanOrEqual(140);
  });

  it('a simulated disconnect reconnects without losing or duplicating segments', async () => {
    const records = await pipeFixture(
      new FakeSttProvider({ segments: truth, disconnectAtMs: 10_000, reconnectDelayMs: 30 }),
      { fixture: 'standup-short' },
    );
    for (const source of ['mic', 'system'] as const) {
      const rec = records[source];
      expect(rec.statuses).toEqual(['connecting', 'open', 'reconnecting', 'open', 'closed']);
      expect(rec.errors).toMatchObject([{ code: 'connection', fatal: false }]);
      expect(finalText(rec)).toBe(truthText(truth, source));
    }
  });

  it('an injected fatal error stops the stream with status error', async () => {
    const records = await pipeFixture(
      new FakeSttProvider({ segments: truth, errorAtMs: 9_000, errorCode: 'protocol' }),
      { fixture: 'standup-short' },
    );
    const mic = records.mic;
    expect(mic.statuses.at(-1)).toBe('error');
    expect(mic.errors).toMatchObject([{ code: 'protocol', fatal: true }]);
    expect(finals(mic).every((s) => s.endMs <= 9_000)).toBe(true);
  });

  it('failOpen surfaces a fatal error without opening', async () => {
    const provider = new FakeSttProvider({ segments: truth, failOpen: 'auth' });
    const records = await pipeFixture(provider, { fixture: 'standup-short', durationMs: 2_000 });
    expect(records.mic.statuses).toEqual(['connecting', 'error']);
    expect(records.mic.errors).toMatchObject([{ code: 'auth', fatal: true }]);
    expect(records.mic.segments).toEqual([]);
  });

  it('finish() finalizes a segment the audio only partly covered', async () => {
    // standup-short mic segment 2 runs 4685–8184; stop at 6000.
    const records = await pipeFixture(new FakeSttProvider({ segments: truth }), {
      fixture: 'standup-short',
      durationMs: 6_000,
    });
    const last = finals(records.mic).at(-1)!;
    expect(last.startMs).toBe(4685);
    expect(last.endMs).toBe(6000);
    expect(last.text.startsWith('Yesterday')).toBe(true);
  });
});

describe('ground truth helpers', () => {
  it('parseGroundTruth validates', () => {
    expect(() => parseGroundTruth({})).toThrow();
    expect(() => parseGroundTruth([{ source: 'x', startMs: 0, endMs: 1, text: '' }])).toThrow();
    expect(() => parseGroundTruth([{ source: 'mic', startMs: 5, endMs: 1, text: '' }])).toThrow();
    expect(parseGroundTruth(truth)).toEqual(truth);
  });

  it('wordsOf spreads words over the segment', () => {
    const words = wordsOf({ source: 'mic', startMs: 1000, endMs: 2000, text: 'Hi there, you.' });
    expect(words.map((w) => w.word)).toEqual(['hi', 'there', 'you']);
    expect(words.map((w) => w.punctuatedWord)).toEqual(['Hi', 'there,', 'you.']);
    expect(words[0]!.startMs).toBe(1000);
    expect(words.at(-1)!.endMs).toBe(2000);
  });
});
