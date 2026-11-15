import { describe, expect, it, vi } from 'vitest';

import { backoffDelay, DEFAULT_BACKOFF } from './backoff.ts';
import {
  apiKeyToken,
  buildListenUrl,
  grantTokenSource,
  resolveDeepgramEndpoints,
} from './deepgram-config.ts';

describe('resolveDeepgramEndpoints', () => {
  it('defaults to the local mock', () => {
    expect(resolveDeepgramEndpoints({})).toEqual({
      baseUrl: 'http://localhost:14010/stt',
      listenUrl: 'ws://localhost:14010/stt/v1/listen',
      grantUrl: 'http://localhost:14010/stt/v1/auth/grant',
      mock: true,
    });
  });

  it('follows MOCKS_URL when no key is set', () => {
    expect(
      resolveDeepgramEndpoints({ MOCKS_URL: 'http://127.0.0.1:5000/', DEEPGRAM_API_KEY: '' }),
    ).toMatchObject({ listenUrl: 'ws://127.0.0.1:5000/stt/v1/listen', mock: true });
  });

  it('uses real Deepgram when a key is set', () => {
    expect(resolveDeepgramEndpoints({ DEEPGRAM_API_KEY: 'k' })).toEqual({
      baseUrl: 'https://api.deepgram.com',
      listenUrl: 'wss://api.deepgram.com/v1/listen',
      grantUrl: 'https://api.deepgram.com/v1/auth/grant',
      mock: false,
    });
  });

  it('DEEPGRAM_BASE_URL overrides (http or ws form)', () => {
    expect(resolveDeepgramEndpoints({ DEEPGRAM_BASE_URL: 'wss://dg.example.test/' })).toMatchObject(
      {
        listenUrl: 'wss://dg.example.test/v1/listen',
        grantUrl: 'https://dg.example.test/v1/auth/grant',
        mock: false,
      },
    );
  });
});

describe('buildListenUrl', () => {
  it('sets Deepgram live parameters, repeated keyterms and extras', () => {
    const url = new URL(
      buildListenUrl(
        'ws://localhost:14010/stt/v1/listen',
        {
          sampleRate: 16_000,
          model: 'nova-3',
          language: 'en',
          keyterms: ['Oat', 'Priya'],
          interimResults: true,
          smartFormat: true,
          endpointingMs: 300,
          mipOptOut: true,
        },
        { mock_fixture: 'standup-short', mock_offset_ms: 1200 },
      ),
    );
    const q = url.searchParams;
    expect(url.pathname).toBe('/stt/v1/listen');
    expect(Object.fromEntries(q)).toMatchObject({
      model: 'nova-3',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      interim_results: 'true',
      smart_format: 'true',
      endpointing: '300',
      mip_opt_out: 'true',
      language: 'en',
      mock_fixture: 'standup-short',
      mock_offset_ms: '1200',
    });
    expect(q.getAll('keyterm')).toEqual(['Oat', 'Priya']);
  });

  it('can disable endpointing and omits optional params', () => {
    const q = new URL(
      buildListenUrl('wss://x.test/v1/listen', {
        sampleRate: 16_000,
        model: 'nova-3',
        interimResults: false,
        smartFormat: false,
        endpointingMs: false,
        mipOptOut: false,
      }),
    ).searchParams;
    expect(q.get('endpointing')).toBe('false');
    expect(q.has('language')).toBe(false);
    expect(q.has('mip_opt_out')).toBe(false);
  });
});

describe('token sources', () => {
  const ok = (token: string, expires = 30) =>
    new Response(JSON.stringify({ access_token: token, expires_in: expires }), { status: 200 });

  it('grantTokenSource posts to the grant URL with the key and caches until near expiry', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(ok('t1', 30));
    const get = grantTokenSource({ grantUrl: 'http://x.test/v1/auth/grant', apiKey: 'k', fetch });
    expect(await get()).toEqual({ token: 't1', scheme: 'bearer' });
    expect(await get()).toEqual({ token: 't1', scheme: 'bearer' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://x.test/v1/auth/grant');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).authorization).toBe('Token k');
  });

  it('refetches a token close to expiry and surfaces grant failures', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(ok('short', 2))
      .mockResolvedValueOnce(ok('next'))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }));
    const get = grantTokenSource({ grantUrl: 'http://x.test/g', fetch, ttlSeconds: 60 });
    expect((await get()).token).toBe('short');
    expect((await get()).token).toBe('next');
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({ ttl_seconds: 60 });
    const failing = grantTokenSource({ grantUrl: 'http://x.test/g', fetch });
    await expect(failing()).rejects.toThrow(/HTTP 401/);
  });

  it('apiKeyToken uses the Token scheme', async () => {
    expect(await apiKeyToken('key')()).toEqual({ token: 'key', scheme: 'token' });
  });
});

describe('backoffDelay', () => {
  it('grows exponentially to the cap, with bounded jitter', () => {
    const mid = () => 0.5; // no jitter
    expect([1, 2, 3, 4, 5, 6, 10].map((n) => backoffDelay(n, DEFAULT_BACKOFF, mid))).toEqual([
      500, 1000, 2000, 4000, 8000, 10_000, 10_000,
    ]);
    expect(backoffDelay(1, DEFAULT_BACKOFF, () => 0)).toBe(400);
    expect(backoffDelay(1, DEFAULT_BACKOFF, () => 1)).toBe(600);
  });
});
