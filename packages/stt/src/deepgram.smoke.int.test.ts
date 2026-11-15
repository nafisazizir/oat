/**
 * Real Deepgram smoke test. Skipped unless `DEEPGRAM_API_KEY` is set (D-11: no external calls otherwise).
 * Uses the client path of D-17: the key only mints a short-lived token at the grant endpoint, and the
 * stream authenticates with that token.
 */
import { describe, expect, it } from 'vitest';

import { DeepgramProvider } from './deepgram.ts';
import { grantTokenSource, resolveDeepgramEndpoints } from './deepgram-config.ts';
import { finalText, pipeFixture } from './test-utils.ts';

const apiKey = process.env.DEEPGRAM_API_KEY?.trim();

describe.skipIf(!apiKey)('DeepgramProvider ↔ real Deepgram (smoke)', () => {
  it('transcribes a fixture slice from both sources', async () => {
    const endpoints = resolveDeepgramEndpoints();
    const records = await pipeFixture(
      new DeepgramProvider({
        url: endpoints.listenUrl,
        getToken: grantTokenSource({ grantUrl: endpoints.grantUrl, apiKey }),
      }),
      { fixture: 'standup-short', durationMs: 12_000, speed: 2 },
    );
    expect(records.mic.errors.filter((e) => e.fatal)).toEqual([]);
    expect(finalText(records.mic)).toMatch(/morning/);
    expect(finalText(records.system)).toMatch(/review/);
  }, 60_000);
});
