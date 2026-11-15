import { describe, expect, it, vi } from 'vitest';

import {
  capKeyterms,
  createSttTokenRoute,
  KEYTERM_LIMITS,
  STT_TOKEN_TTL_SECONDS,
  type SttTokenDeps,
} from './stt-token';

const BASE = 'http://localhost:3000';
const signedIn = async () => ({ user: { id: 'u1' } });

function grantResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function route(overrides: Partial<SttTokenDeps> = {}) {
  const fetch = vi.fn(async () => grantResponse({ access_token: 'tok-1', expires_in: 60 }));
  const onError = vi.fn();
  const handler = createSttTokenRoute({
    getSession: signedIn,
    allowedOrigins: () => [BASE],
    env: () => ({ MOCKS_URL: 'http://localhost:14010' }),
    fetch: fetch as unknown as typeof globalThis.fetch,
    onError,
    ...overrides,
  });
  return { handler, fetch, onError };
}

const bearerRequest = (headers: Record<string, string> = {}) =>
  new Request(`${BASE}/api/stt/token`, {
    method: 'POST',
    headers: { authorization: 'Bearer abc.def', ...headers },
  });

describe('POST /api/stt/token', () => {
  it('returns a fresh short-lived token from the mock grant endpoint (no key) and its listen URL', async () => {
    const { handler, fetch } = route();
    const res = await handler(bearerRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      accessToken: 'tok-1',
      expiresIn: 60,
      listenUrl: 'ws://localhost:14010/stt/v1/listen',
      keyterms: [],
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:14010/stt/v1/auth/grant');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ ttl_seconds: STT_TOKEN_TTL_SECONDS });
    expect(new Headers(init.headers).has('authorization')).toBe(false);
  });

  it('adds the session user’s profile vocabulary as keyterms; a lookup failure only drops them', async () => {
    const keyterms = vi.fn(async (userId: string) => (userId === 'u1' ? ['Brightsmile'] : []));
    const ok = await route({ keyterms }).handler(bearerRequest());
    expect(((await ok.json()) as { keyterms: string[] }).keyterms).toEqual(['Brightsmile']);
    expect(keyterms).toHaveBeenCalledWith('u1');

    const { handler, onError } = route({ keyterms: () => Promise.reject(new Error('db down')) });
    const res = await handler(bearerRequest());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { keyterms: string[] }).keyterms).toEqual([]);
    expect(onError).toHaveBeenCalled();
  });

  it('caps keyterms to a safe budget (count, length, query size)', () => {
    expect(capKeyterms(['Brightsmile', ' brightsmile ', '', 'x'.repeat(41), 'Mei  Lin'])).toEqual([
      'Brightsmile',
      'Mei Lin',
    ]);
    const many = Array.from({ length: 100 }, (_, i) => `term${i}`);
    expect(capKeyterms(many)).toHaveLength(KEYTERM_LIMITS.terms);
    const long = Array.from({ length: 50 }, (_, i) => `${'ü'.repeat(38)}${i}`);
    const capped = capKeyterms(long);
    const bytes = capped.map((t) => `&keyterm=${encodeURIComponent(t)}`).join('').length;
    expect(capped.length).toBeLessThan(50);
    expect(bytes).toBeLessThanOrEqual(KEYTERM_LIMITS.queryBytes);
  });

  it('uses real Deepgram with the server-side key when DEEPGRAM_API_KEY is set', async () => {
    const { handler, fetch } = route({ env: () => ({ DEEPGRAM_API_KEY: 'dg-secret' }) });
    const res = await handler(bearerRequest());
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.listenUrl).toBe('wss://api.deepgram.com/v1/listen');
    expect(JSON.stringify(body)).not.toContain('dg-secret');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.deepgram.com/v1/auth/grant');
    expect(new Headers(init.headers).get('authorization')).toBe('Token dg-secret');
  });

  it('asks the provider every time (tokens are never shared between calls or users)', async () => {
    const { handler, fetch } = route();
    await handler(bearerRequest());
    await handler(bearerRequest());
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('401 without a session, and the provider is not called', async () => {
    const { handler, fetch } = route({ getSession: async () => null });
    const res = await handler(bearerRequest());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'unauthorized' } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('403 for a cookie request from another origin (CSRF)', async () => {
    const getSession = vi.fn(signedIn);
    const { handler, fetch } = route({ getSession });
    const res = await handler(
      new Request(`${BASE}/api/stt/token`, {
        method: 'POST',
        headers: { cookie: 'better-auth.session_token=x', origin: 'https://evil.example' },
      }),
    );
    expect(res.status).toBe(403);
    expect(getSession).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts a same-origin cookie request', async () => {
    const { handler } = route();
    const res = await handler(
      new Request(`${BASE}/api/stt/token`, {
        method: 'POST',
        headers: { cookie: 'better-auth.session_token=x', origin: BASE },
      }),
    );
    expect(res.status).toBe(200);
  });

  it.each([
    ['the grant endpoint is unreachable', () => Promise.reject(new TypeError('fetch failed'))],
    ['the grant is refused', async () => grantResponse({ err_code: 'INVALID_AUTH' }, 401)],
    ['the grant has no token', async () => grantResponse({ expires_in: 30 })],
    ['the grant is not JSON', async () => new Response('<html>', { status: 200 })],
  ])('503 stt_unavailable when %s (details only in the log)', async (_name, impl) => {
    const { handler, onError } = route({ fetch: vi.fn(impl) as never });
    const res = await handler(bearerRequest());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({
      error: { code: 'stt_unavailable', message: expect.any(String) },
    });
    expect(onError).toHaveBeenCalled();
  });

  it('refuses to hand out a non-local mock in production', async () => {
    const { handler, fetch } = route({
      env: () => ({ NODE_ENV: 'production', MOCKS_URL: 'https://mocks.example.com' }),
    });
    const res = await handler(bearerRequest());
    expect(res.status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('allows the local mock in a production build on loopback (pnpm dev:app)', async () => {
    const { handler } = route({
      env: () => ({ NODE_ENV: 'production', MOCKS_URL: 'http://localhost:14010' }),
    });
    expect((await handler(bearerRequest())).status).toBe(200);
  });
});
