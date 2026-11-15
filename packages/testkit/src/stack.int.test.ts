import { connect } from 'node:net';
import { describe, expect, it } from 'vitest';
import { oauthGoogleIssuer } from './env.ts';
import { uniqueAddress } from './mailpit.ts';

// Smoke tests for the compose services that have no testkit helper yet (oauth, redis).

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const payload = jwt.split('.')[1];
  if (!payload) throw new Error('not a JWT');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('oauth (mock Google OIDC)', () => {
  const issuer = oauthGoogleIssuer();

  it('serves OIDC discovery for the google issuer', async () => {
    const res = await fetch(`${issuer}/.well-known/openid-configuration`);
    expect(res.status).toBe(200);
    const config = (await res.json()) as Record<string, string>;
    expect(config.issuer).toBe(issuer);
    expect(config.authorization_endpoint).toBe(`${issuer}/authorize`);
    expect(config.token_endpoint).toBe(`${issuer}/token`);
  });

  it('logs in non-interactively and issues an id_token with Google-style profile claims', async () => {
    const email = uniqueAddress('oauth');
    const redirectUri = 'http://localhost:3000/api/auth/callback/google';
    const authorize = new URL(`${issuer}/authorize`);
    authorize.search = new URLSearchParams({
      client_id: 'oat-dev',
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: 'openid email profile',
      state: 'state-1',
      nonce: 'nonce-1',
    }).toString();

    // What the login form posts: username (→ sub + email) and optional extra claims.
    const login = await fetch(authorize, {
      method: 'POST',
      redirect: 'manual',
      body: new URLSearchParams({
        username: email,
        claims: JSON.stringify({ name: 'Test User', picture: 'http://localhost/avatar.png' }),
      }),
    });
    expect(login.status).toBe(302);
    const callback = new URL(login.headers.get('location') ?? '');
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get('state')).toBe('state-1');
    const code = callback.searchParams.get('code');
    expect(code).toBeTruthy();

    const token = await fetch(`${issuer}/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from('oat-dev:oat-dev-secret').toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code ?? '',
        redirect_uri: redirectUri,
      }),
    });
    expect(token.status).toBe(200);
    const { id_token } = (await token.json()) as { id_token: string };
    expect(decodeJwtPayload(id_token)).toMatchObject({
      iss: issuer,
      aud: 'oat-dev',
      sub: email,
      email,
      email_verified: true,
      name: 'Test User',
      picture: 'http://localhost/avatar.png',
      nonce: 'nonce-1',
    });
  });

  it('does not let login-form claims override the verified email', async () => {
    const email = uniqueAddress('oauth');
    const authorize = `${issuer}/authorize?client_id=oat-dev&response_type=code&scope=openid&redirect_uri=${encodeURIComponent('http://localhost/cb')}`;
    const login = await fetch(authorize, {
      method: 'POST',
      redirect: 'manual',
      body: new URLSearchParams({ username: email, claims: '{"email":"someone@else.test"}' }),
    });
    const code = new URL(login.headers.get('location') ?? '').searchParams.get('code') ?? '';
    const token = await fetch(`${issuer}/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: 'oat-dev',
        client_secret: 'x',
        redirect_uri: 'http://localhost/cb',
      }),
    });
    const { id_token } = (await token.json()) as { id_token: string };
    expect(decodeJwtPayload(id_token).email).toBe(email);
  });
});

describe('redis', () => {
  it('answers PING', async () => {
    const url = new URL(process.env.REDIS_URL || 'redis://localhost:63790');
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(url.port || 6379), url.hostname, () =>
        socket.write('PING\r\n'),
      );
      socket.setTimeout(3_000, () => socket.destroy(new Error('redis timeout')));
      socket.once('data', (data) => {
        resolve(data.toString());
        socket.end();
      });
      socket.once('error', reject);
    });
    expect(reply).toBe('+PONG\r\n');
  });
});
