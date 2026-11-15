import { describe, expect, it } from 'vitest';

import {
  type AccountTokenApi,
  googleCalendarTokenProvider,
  parseScopes,
  revokeOAuthToken,
} from './google-calendar.ts';

const google = { issuer: 'http://issuer.test/google', clientId: 'cid', clientSecret: 'secret' };

describe('parseScopes', () => {
  it('splits Better Auth (comma) and OAuth (space) scope strings', () => {
    expect(parseScopes('openid,email, https://x/calendar.readonly')).toEqual([
      'openid',
      'email',
      'https://x/calendar.readonly',
    ]);
    expect(parseScopes('openid email')).toEqual(['openid', 'email']);
    expect(parseScopes(null)).toEqual([]);
  });
});

describe('googleCalendarTokenProvider', () => {
  it('reads the stored token, or forces a refresh', async () => {
    const calls: string[] = [];
    const api: AccountTokenApi = {
      getAccessToken: async ({ body }) => {
        calls.push(`get:${body.accountId}:${body.userId}`);
        return { accessToken: 'stored' };
      },
      refreshToken: async ({ body }) => {
        calls.push(`refresh:${body.accountId}`);
        return { accessToken: 'fresh' };
      },
    };
    const provider = googleCalendarTokenProvider(api, { accountId: 'acc', userId: 'u' });
    expect(await provider({ forceRefresh: false })).toBe('stored');
    expect(await provider({ forceRefresh: true })).toBe('fresh');
    expect(calls).toEqual(['get:acc:u', 'refresh:acc']);
  });

  it('fails without a token', async () => {
    const api: AccountTokenApi = {
      getAccessToken: async () => ({ accessToken: null }),
      refreshToken: async () => ({}),
    };
    await expect(
      googleCalendarTokenProvider(api, { accountId: 'a', userId: 'u' })({ forceRefresh: false }),
    ).rejects.toThrow(/no access token/);
  });
});

describe('revokeOAuthToken', () => {
  it('posts the token to the discovered revocation endpoint with client credentials', async () => {
    const requests: { url: string; body?: string }[] = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, body: init?.body ? String(init.body) : undefined });
      if (url.endsWith('/.well-known/openid-configuration')) {
        return Response.json({ revocation_endpoint: 'http://issuer.test/google/revoke' });
      }
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    expect(await revokeOAuthToken(google, 'tok', { fetch: fakeFetch })).toBe(true);
    expect(requests[1]).toEqual({
      url: 'http://issuer.test/google/revoke',
      body: 'token=tok&client_id=cid&client_secret=secret',
    });
  });

  it('never throws: no endpoint, an error status or a network failure → false', async () => {
    const noEndpoint = (async () => Response.json({})) as unknown as typeof fetch;
    expect(await revokeOAuthToken(google, 't', { fetch: noEndpoint })).toBe(false);
    const refused = (async (input: RequestInfo | URL) =>
      String(input).includes('well-known')
        ? Response.json({ revocation_endpoint: 'http://issuer.test/revoke' })
        : new Response(null, { status: 400 })) as typeof fetch;
    expect(await revokeOAuthToken(google, 't', { fetch: refused })).toBe(false);
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await revokeOAuthToken(google, 't', { fetch: down })).toBe(false);
  });
});
