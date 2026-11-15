import { readdirSync } from 'node:fs';

import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

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

  it('redirects requests without a session cookie to /sign-in, keeping the target', () => {
    const res = proxy(new NextRequest('http://localhost:3000/d/abc?x=1'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/sign-in?next=%2Fd%2Fabc%3Fx%3D1',
    );
    const home = proxy(new NextRequest('http://localhost:3000/home'));
    expect(home.headers.get('location')).toBe('http://localhost:3000/sign-in');
    const nested = proxy(new NextRequest('http://localhost:3000/settings/integrations'));
    expect(nested.headers.get('location')).toBe(
      'http://localhost:3000/sign-in?next=%2Fsettings%2Fintegrations',
    );
  });

  it('lets requests with a session cookie through (the layout validates it)', () => {
    for (const name of ['better-auth.session_token', '__Secure-better-auth.session_token']) {
      const res = proxy(
        new NextRequest('http://localhost:3000/home', { headers: { cookie: `${name}=t.sig` } }),
      );
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('x-middleware-next')).toBe('1');
    }
  });

  it('invite pages: public (no redirect), with no-referrer and no-store headers', () => {
    const res = proxy(new NextRequest('http://localhost:3000/invite/abc123'));
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(INVITE_HEADERS['Referrer-Policy']).toBe('no-referrer');
    expect(config.matcher).toContain('/invite/:path*');
  });
});
