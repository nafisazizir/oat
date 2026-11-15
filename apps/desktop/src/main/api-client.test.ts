import { describe, expect, it, vi } from 'vitest';

import { ApiError, createApiClient } from './api-client.ts';

const BASE = 'http://localhost:3000';

function client(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) =>
    respond(String(url), init ?? {}),
  );
  return {
    api: createApiClient({ baseUrl: BASE, fetch: fetch as typeof globalThis.fetch }),
    fetch,
  };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });

describe('exchangeDesktopCode', () => {
  it('posts code + verifier and returns the signed token from set-auth-token', async () => {
    const { api, fetch } = client(() =>
      json(
        { user: { id: 'u', email: 'a@b.c', name: null } },
        { headers: { 'set-auth-token': 'abc.def%2B%3D' } },
      ),
    );
    expect(await api.exchangeDesktopCode('c', 'v')).toEqual({
      token: 'abc.def%2B%3D',
      user: { id: 'u', email: 'a@b.c', name: null },
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`${BASE}/api/auth/desktop/token`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ code: 'c', verifier: 'v' });
    // Never follows redirects with the request (or a token) somewhere else.
    expect(init?.redirect).toBe('error');
  });

  it('refuses a missing/unsigned token or a failed exchange', async () => {
    const user = { user: { id: 'u', email: 'e', name: null } };
    for (const res of [
      json({ code: 'invalid_grant' }, { status: 400 }),
      json(user),
      json(user, { headers: { 'set-auth-token': 'unsigned' } }),
      json({ nope: 1 }, { headers: { 'set-auth-token': 'a.b' } }),
    ]) {
      const { api } = client(() => res);
      await expect(api.exchangeDesktopCode('c', 'v')).rejects.toBeInstanceOf(ApiError);
    }
  });
});

describe('me', () => {
  it('sends the bearer token and maps the session', async () => {
    const { api, fetch } = client(() =>
      json({
        user: { id: 'u', email: 'a@b.c', name: '' },
        session: { activeOrganizationId: 'w' },
      }),
    );
    expect(await api.me('tok.sig')).toEqual({
      user: { id: 'u', email: 'a@b.c', name: null },
      activeWorkspaceId: 'w',
    });
    const headers = new Headers(fetch.mock.calls[0]![1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer tok.sig');
    expect(headers.get('user-agent')).toMatch(/^Oat-Desktop/);
  });

  it('a null session is a 401; a network failure is status 0', async () => {
    await expect(client(() => json(null)).api.me('t.s')).rejects.toMatchObject({ status: 401 });
    const offline = client(() => {
      throw new TypeError('fetch failed');
    });
    await expect(offline.api.me('t.s')).rejects.toMatchObject({ status: 0 });
  });
});

describe('signOut', () => {
  it('posts to sign-out with the bearer token', async () => {
    const { api, fetch } = client(() => json({ success: true }));
    await api.signOut('tok.sig');
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`${BASE}/api/auth/sign-out`);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tok.sig');
  });
});
