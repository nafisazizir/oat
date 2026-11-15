import { describe, expect, it, vi } from 'vitest';

import {
  batchUrlFor,
  buildBatchUrl,
  mapBatchResponse,
  transcribeDeepgram,
  type DeepgramBatchOptions,
} from './deepgram-batch.ts';
import { DeepgramProvider } from './deepgram.ts';
import { FakeSttProvider } from './fake.ts';
import { SttBatchError } from './types.ts';

const word = (w: string, start: number, end: number) => ({
  word: w.toLowerCase(),
  punctuated_word: w,
  start,
  end,
  confidence: 0.9,
});

describe('batch URL', () => {
  it('is the http(s) twin of the live socket URL, with pre-recorded params', () => {
    expect(batchUrlFor('wss://api.deepgram.com/v1/listen?model=x')).toBe(
      'https://api.deepgram.com/v1/listen',
    );
    expect(batchUrlFor('ws://localhost:14010/stt/v1/listen')).toBe(
      'http://localhost:14010/stt/v1/listen',
    );
    const url = new URL(
      buildBatchUrl(
        {
          listenUrl: 'wss://api.deepgram.com/v1/listen',
          model: 'nova-3',
          smartFormat: true,
          mipOptOut: true,
        },
        { language: 'en', keyterms: ['Oat', 'Deepgram'] },
        { mock_fixture: 'x' },
      ),
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      model: 'nova-3',
      smart_format: 'true',
      utterances: 'true',
      mip_opt_out: 'true',
      language: 'en',
      mock_fixture: 'x',
    });
    expect(url.searchParams.getAll('keyterm')).toEqual(['Oat', 'Deepgram']);
    // Never the live-only params.
    expect(url.searchParams.has('interim_results')).toBe(false);
    expect(url.searchParams.has('encoding')).toBe(false);
  });
});

describe('mapBatchResponse', () => {
  it('maps utterances to final segments on the caller’s clock', () => {
    const result = mapBatchResponse(
      {
        metadata: { duration: 12.5 },
        results: {
          channels: [{ alternatives: [{ words: [] }] }],
          utterances: [
            { start: 4, end: 5, confidence: 0.8, words: [word('Later.', 4, 5)] },
            { start: 1, end: 2.5, words: [word('Hello', 1, 1.5), word('there.', 1.6, 2.5)] },
            { start: 9, end: 9.5, words: [] },
          ],
        },
      },
      'system',
      60_000,
    );
    expect(result.durationMs).toBe(12_500);
    expect(result.segments).toEqual([
      expect.objectContaining({
        source: 'system',
        startMs: 61_000,
        endMs: 62_500,
        text: 'Hello there.',
        isFinal: true,
      }),
      expect.objectContaining({ startMs: 64_000, endMs: 65_000, text: 'Later.', confidence: 0.8 }),
    ]);
    expect(result.segments[0]!.words![1]).toEqual({
      word: 'there.',
      punctuatedWord: 'there.',
      startMs: 61_600,
      endMs: 62_500,
      confidence: 0.9,
    });
  });

  it('without utterances, groups channel words at pauses', () => {
    const result = mapBatchResponse(
      {
        results: {
          channels: [
            {
              alternatives: [
                { words: [word('a', 0, 0.2), word('b', 0.3, 0.5), word('c', 1.4, 1.6)] },
              ],
            },
          ],
        },
      },
      'mic',
      0,
    );
    expect(result.segments.map((s) => s.text)).toEqual(['a b', 'c']);
    expect(result.durationMs).toBe(0);
  });

  it('refuses a response without results', () => {
    expect(() => mapBatchResponse({ err_code: 'x' }, 'mic', 0)).toThrow(SttBatchError);
  });
});

describe('transcribeDeepgram', () => {
  const ok = () =>
    new Response(
      JSON.stringify({
        metadata: { duration: 1 },
        results: { utterances: [{ start: 0.1, end: 0.4, words: [word('Hi.', 0.1, 0.4)] }] },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  const options = (fetchImpl: typeof fetch, extra: Partial<DeepgramBatchOptions> = {}) => ({
    listenUrl: 'ws://localhost:1/stt/v1/listen',
    getToken: vi.fn(async (o?: { refresh?: boolean }) => ({
      token: o?.refresh ? 'fresh' : 'cached',
      scheme: 'bearer' as const,
    })),
    model: 'nova-3',
    smartFormat: true,
    mipOptOut: true,
    fetch: fetchImpl,
    ...extra,
  });
  const request = {
    source: 'mic' as const,
    pcm: new Int16Array(16_000),
    sampleRate: 16_000,
    offsetMs: 5000,
  };

  it('POSTs a WAV with the bearer token and maps the answer', async () => {
    const fetchImpl = vi.fn(async () => ok());
    const result = await transcribeDeepgram(options(fetchImpl as unknown as typeof fetch), request);
    expect(result.segments).toEqual([
      expect.objectContaining({ startMs: 5100, endMs: 5400, text: 'Hi.' }),
    ]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/^http:\/\/localhost:1\/stt\/v1\/listen\?/);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer cached');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('audio/wav');
    const body = init.body as Uint8Array;
    expect(String.fromCharCode(...body.subarray(0, 4))).toBe('RIFF');
    expect(body.length).toBe(44 + 32_000);
  });

  it('retries a 401 once with a refreshed token, then gives up (not retryable)', async () => {
    const responses = [new Response('', { status: 401 }), ok()];
    const fetchImpl = vi.fn(async () => responses.shift()!);
    const o = options(fetchImpl as unknown as typeof fetch);
    await transcribeDeepgram(o, request);
    expect(o.getToken).toHaveBeenLastCalledWith({ refresh: true });

    const denied = vi.fn(async () => new Response('', { status: 403 }));
    await expect(
      transcribeDeepgram(options(denied as unknown as typeof fetch), request),
    ).rejects.toMatchObject({ code: 'auth', retryable: false, status: 403 });
    expect(denied).toHaveBeenCalledTimes(2);
  });

  it.each([
    [503, 'connection', true],
    [429, 'quota', true],
    [402, 'quota', false],
    [400, 'bad_request', false],
  ])('HTTP %i → %s (retryable %s)', async (status, code, retryable) => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status }));
    await expect(
      transcribeDeepgram(options(fetchImpl as unknown as typeof fetch), request),
    ).rejects.toMatchObject({ code, retryable, status });
  });

  it('network failures and token failures are retryable', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(
      transcribeDeepgram(options(down as unknown as typeof fetch), request),
    ).rejects.toMatchObject({ code: 'connection', retryable: true });
    await expect(
      transcribeDeepgram(
        options(vi.fn() as unknown as typeof fetch, {
          getToken: () => Promise.reject(new Error('offline')),
        }),
        request,
      ),
    ).rejects.toMatchObject({ code: 'token', retryable: true });
  });

  it('DeepgramProvider.transcribe passes its options and the batch extraQuery context', async () => {
    const fetchImpl = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const extraQuery = vi.fn(() => ({ mock_fixture: 'f' }));
      const provider = new DeepgramProvider({
        url: 'ws://localhost:1/stt/v1/listen',
        getToken: async () => ({ token: 'k', scheme: 'token' }),
        extraQuery,
      });
      await provider.transcribe(request);
      expect(extraQuery).toHaveBeenCalledWith({ source: 'mic', offsetMs: 5000, attempt: 0 });
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(new URL(url).searchParams.get('mock_fixture')).toBe('f');
      expect((init.headers as Record<string, string>).Authorization).toBe('Token k');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('FakeSttProvider.transcribe', () => {
  const fake = new FakeSttProvider({
    segments: [
      { source: 'mic', startMs: 1000, endMs: 2000, text: 'one two' },
      { source: 'mic', startMs: 5000, endMs: 6000, text: 'three four' },
      { source: 'system', startMs: 1000, endMs: 2000, text: 'theirs' },
    ],
  });

  it('returns the ground truth of the requested span and source', async () => {
    const result = await fake.transcribe({
      source: 'mic',
      pcm: new Int16Array(16 * 4000),
      sampleRate: 16_000,
      offsetMs: 1500,
    });
    expect(result.segments.map((s) => s.text)).toEqual(['two', 'three']);
    expect(fake.batchRequests).toEqual([{ source: 'mic', startMs: 1500, endMs: 5500 }]);
  });

  it('fails while batchFails says so', async () => {
    let down = true;
    const flaky = new FakeSttProvider({ segments: [], batchFails: () => down });
    const req = { source: 'mic' as const, pcm: new Int16Array(160), sampleRate: 16_000 };
    await expect(flaky.transcribe(req)).rejects.toMatchObject({
      code: 'connection',
      retryable: true,
    });
    down = false;
    await expect(flaky.transcribe(req)).resolves.toEqual({ segments: [], durationMs: 10 });
  });
});
