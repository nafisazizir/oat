/**
 * Task 2.7: `DeepgramProvider.transcribe` (pre-recorded API) against the in-process mock: WAV upload, grant
 * token, fixture ground truth on the caller's clock, and the outage switch.
 */
import { startMocks, type RunningMocks } from '@oat/mocks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DeepgramProvider } from './deepgram.ts';
import { grantTokenSource, resolveDeepgramEndpoints } from './deepgram-config.ts';
import { wordsOf } from './fake.ts';
import { groundTruth } from './test-utils.ts';

let mocks: RunningMocks;
beforeAll(async () => {
  mocks = await startMocks();
});
afterAll(() => mocks.close());

const truth = groundTruth('standup-short');

function provider(fixture?: string) {
  const endpoints = resolveDeepgramEndpoints({ MOCKS_URL: mocks.url });
  return new DeepgramProvider({
    url: endpoints.listenUrl,
    getToken: grantTokenSource({ grantUrl: endpoints.grantUrl }),
    extraQuery: ({ source, offsetMs }): Record<string, string | number> =>
      fixture ? { mock_fixture: fixture, mock_channel: source, mock_offset_ms: offsetMs ?? 0 } : {},
  });
}

describe('DeepgramProvider.transcribe ↔ mock', () => {
  it('returns the fixture’s words of the span as utterances on the given clock', async () => {
    const offsetMs = 8000;
    const pcm = new Int16Array(16 * 12_000); // 12 s; the fixture mode words don't depend on the audio
    const result = await provider('standup-short').transcribe({
      source: 'system',
      pcm,
      sampleRate: 16_000,
      offsetMs,
    });
    expect(result.durationMs).toBe(12_000);
    const expected = truth
      .filter((s) => s.source === 'system')
      .flatMap((s) => wordsOf(s))
      .filter((w) => {
        const mid = (w.startMs + w.endMs) / 2;
        return mid >= offsetMs && mid < offsetMs + 12_000;
      });
    expect(expected.length).toBeGreaterThan(3);
    const words = result.segments.flatMap((s) => s.words ?? []);
    expect(words.map((w) => w.punctuatedWord)).toEqual(expected.map((w) => w.punctuatedWord));
    for (const s of result.segments) {
      expect(s.isFinal).toBe(true);
      expect(s.source).toBe('system');
      expect(s.startMs).toBeGreaterThanOrEqual(offsetMs);
      expect(s.endMs).toBeLessThanOrEqual(offsetMs + 12_000);
    }
    // Same word timing as the ground truth (± rounding to the mock's ms resolution).
    expect(Math.abs(words[0]!.startMs - Math.max(offsetMs, expected[0]!.startMs))).toBeLessThan(5);

    const call = mocks.log
      .list({ provider: 'stt' })
      .findLast((r) => r.method === 'POST' && r.path === '/stt/v1/listen');
    expect(call?.query).toMatchObject({
      utterances: 'true',
      model: 'nova-3',
      smart_format: 'true',
    });
    expect(call?.headers.authorization).toBe('Bearer [redacted]');
    expect(call?.body).toMatch(/^<\d+ bytes audio\/wav>$/);
  });

  it('a 503 outage is a retryable connection error; back up → works again', async () => {
    const outage = (down: boolean) =>
      fetch(`${mocks.url}/stt/_mock/outage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ down }),
      });
    const req = { source: 'mic' as const, pcm: new Int16Array(1600), sampleRate: 16_000 };
    await outage(true);
    try {
      await expect(provider().transcribe(req)).rejects.toMatchObject({
        name: 'SttBatchError',
        code: 'connection',
        retryable: true,
        status: 503,
      });
    } finally {
      await outage(false);
    }
    await expect(provider().transcribe(req)).resolves.toMatchObject({
      segments: [],
      durationMs: 100,
    });
  });
});
