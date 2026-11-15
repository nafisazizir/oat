import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';

import { createMemoryRateLimiter } from '@oat/auth/rate-limit';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import {
  clientIp,
  guardShareRequest,
  SHARE_RATE_LIMIT,
  SHARE_TOKEN_RATE_LIMIT,
  shareContentSecurityPolicy,
  trustProxyHeadersFromEnv,
} from './lib/share-guard';
import { themeScript } from './lib/theme';
import { config, INVITE_HEADERS, proxy } from './proxy';

const appRoutes = readdirSync(new URL('./app/(app)/', import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

describe('proxy', () => {
  it('matches every route in the (app) group', () => {
    expect(appRoutes.length).toBeGreaterThan(0);
    for (const route of appRoutes) {
      const covered = config.matcher.some((m) => m === `/${route}` || m === `/${route}/:path*`);
      expect(covered, `/${route} is not in proxy matcher`).toBe(true);
    }
  });

  it('redirects requests without a session cookie to /sign-in, keeping the target', async () => {
    const res = await proxy(new NextRequest('http://localhost:3000/d/abc?x=1'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/sign-in?next=%2Fd%2Fabc%3Fx%3D1',
    );
    const home = await proxy(new NextRequest('http://localhost:3000/home'));
    expect(home.headers.get('location')).toBe('http://localhost:3000/sign-in');
    const nested = await proxy(new NextRequest('http://localhost:3000/settings/integrations'));
    expect(nested.headers.get('location')).toBe(
      'http://localhost:3000/sign-in?next=%2Fsettings%2Fintegrations',
    );
  });

  it('lets requests with a session cookie through (the layout validates it)', async () => {
    for (const name of ['better-auth.session_token', '__Secure-better-auth.session_token']) {
      const res = await proxy(
        new NextRequest('http://localhost:3000/home', { headers: { cookie: `${name}=t.sig` } }),
      );
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('x-middleware-next')).toBe('1');
    }
  });

  it('invite pages: public (no redirect), with no-referrer and no-store headers', async () => {
    const res = await proxy(new NextRequest('http://localhost:3000/invite/abc123'));
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(INVITE_HEADERS['Referrer-Policy']).toBe('no-referrer');
    expect(config.matcher).toContain('/invite/:path*');
  });

  it('serves /share/* without a session (no sign-in redirect)', async () => {
    expect(config.matcher).toContain('/share/:path*');
    const res = await proxy(
      new NextRequest('http://localhost:3000/share/abcdefghijklmnopqrstuvwx'),
    );
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(res.headers.get('content-security-policy')).toContain(`frame-ancestors 'none'`);
  });
});

describe('share guard', () => {
  const TOKEN = 'abcdefghijklmnopqrstuvwx';
  const shareRequest = (headers: Record<string, string> = {}, token = TOKEN) =>
    new NextRequest(`http://localhost:3000/share/${token}`, { headers });
  const untrusted = { dev: false, trustProxyHeaders: false };
  const trusted = { dev: false, trustProxyHeaders: true };

  it('sets a per-request nonce CSP and privacy headers, and strips cookies from the request', async () => {
    const limiter = createMemoryRateLimiter();
    const res = await guardShareRequest(
      shareRequest({ cookie: 'better-auth.session_token=t.sig', authorization: 'Bearer x' }),
      limiter,
      untrusted,
    );
    const csp = res.headers.get('content-security-policy')!;
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain(`'strict-dynamic'`);
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain(`object-src 'none'`);
    expect(csp).toContain(`base-uri 'none'`);
    expect(csp).not.toContain('upgrade-insecure-requests'); // plain http
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    // Request headers forwarded to the page: Next.js reads the CSP for the nonce; no credentials.
    expect(res.headers.get('x-middleware-request-content-security-policy')).toBe(csp);
    expect(res.headers.get('x-middleware-request-x-nonce')).toBe(nonce);
    expect(res.headers.get('x-middleware-request-cookie')).toBeNull();
    expect(res.headers.get('x-middleware-request-authorization')).toBeNull();
    const overridden = res.headers.get('x-middleware-override-headers')!.split(',');
    expect(overridden).not.toContain('cookie');
    expect(overridden).not.toContain('authorization');

    const again = await guardShareRequest(shareRequest(), limiter, untrusted);
    expect(again.headers.get('content-security-policy')).not.toBe(csp); // fresh nonce
  });

  it('upgrades insecure requests only over https', async () => {
    const res = await guardShareRequest(
      new NextRequest(`https://oat.example/share/${TOKEN}`),
      createMemoryRateLimiter(),
      untrusted,
    );
    expect(res.headers.get('content-security-policy')).toContain('upgrade-insecure-requests');
    const viaProxy = await guardShareRequest(
      shareRequest({ 'x-forwarded-proto': 'https' }),
      createMemoryRateLimiter(),
      trusted,
    );
    expect(viaProxy.headers.get('content-security-policy')).toContain('upgrade-insecure-requests');
  });

  it('allows the root layout’s inline theme script by hash', () => {
    const hash = createHash('sha256').update(themeScript).digest('base64');
    expect(shareContentSecurityPolicy('n', false)).toContain(`'sha256-${hash}'`);
    expect(shareContentSecurityPolicy('n', true)).toContain(`'unsafe-eval'`);
  });

  it('rate-limits per client IP with 429 + Retry-After', async () => {
    const limiter = createMemoryRateLimiter();
    const from = (ip: string) => shareRequest({ 'x-vercel-forwarded-for': ip });
    for (let i = 0; i < SHARE_RATE_LIMIT.limit; i++) {
      expect((await guardShareRequest(from('203.0.113.7'), limiter, trusted)).status).toBe(200);
    }
    const limited = await guardShareRequest(from('203.0.113.7'), limiter, trusted);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // Another client is unaffected.
    expect((await guardShareRequest(from('198.51.100.2'), limiter, trusted)).status).toBe(200);
  });

  it('rate-limits per token across IPs', async () => {
    const limiter = createMemoryRateLimiter();
    for (let i = 0; i < SHARE_TOKEN_RATE_LIMIT.limit; i++) {
      const res = await guardShareRequest(
        shareRequest({ 'x-vercel-forwarded-for': `10.0.${i >> 8}.${i & 255}` }),
        limiter,
        trusted,
      );
      expect(res.status).toBe(200);
    }
    const limited = await guardShareRequest(
      shareRequest({ 'x-vercel-forwarded-for': '192.0.2.1' }),
      limiter,
      trusted,
    );
    expect(limited.status).toBe(429);
    // Another link is unaffected.
    const other = await guardShareRequest(
      shareRequest({ 'x-vercel-forwarded-for': '192.0.2.1' }, 'B'.repeat(24)),
      limiter,
      trusted,
    );
    expect(other.status).toBe(200);
  });

  it('client IP: forwarding headers only when trusted; otherwise the hop nearest the server', () => {
    const req = (headers: Record<string, string>) =>
      new Request('http://localhost:3000/share/x', { headers });
    const spoofed = req({
      'x-forwarded-for': '6.6.6.6, 198.51.100.9',
      'x-real-ip': '7.7.7.7',
      'x-vercel-forwarded-for': '8.8.8.8',
    });
    expect(clientIp(spoofed, { trustProxyHeaders: true })).toBe('8.8.8.8');
    expect(clientIp(req({ 'x-real-ip': '7.7.7.7' }), { trustProxyHeaders: true })).toBe('7.7.7.7');
    expect(
      clientIp(req({ 'x-forwarded-for': '6.6.6.6, 1.1.1.1' }), { trustProxyHeaders: true }),
    ).toBe('6.6.6.6');
    // Untrusted: a client-chosen first hop / x-real-ip / x-vercel-* never decides the bucket.
    expect(clientIp(spoofed, { trustProxyHeaders: false })).toBe('198.51.100.9');
    expect(clientIp(req({ 'x-forwarded-for': '::1' }), { trustProxyHeaders: false })).toBe('::1');
    expect(clientIp(req({}), { trustProxyHeaders: false })).toBe('unknown');
  });

  it('TRUST_PROXY_HEADERS: explicit on/off, default on only on Vercel', () => {
    expect(trustProxyHeadersFromEnv({})).toBe(false);
    expect(trustProxyHeadersFromEnv({ VERCEL: '1' })).toBe(true);
    expect(trustProxyHeadersFromEnv({ TRUST_PROXY_HEADERS: 'true' })).toBe(true);
    expect(trustProxyHeadersFromEnv({ TRUST_PROXY_HEADERS: '1' })).toBe(true);
    expect(trustProxyHeadersFromEnv({ TRUST_PROXY_HEADERS: '0', VERCEL: '1' })).toBe(false);
    expect(trustProxyHeadersFromEnv({ TRUST_PROXY_HEADERS: 'false', VERCEL: '1' })).toBe(false);
  });
});
