import { describe, expect, it } from 'vitest';

import {
  allowsRendererPermission,
  APP_ORIGIN,
  contentSecurityPolicy,
  isSafeExternalUrl,
  isTrustedFrame,
  navigationDecision,
  originOf,
  trustedOrigins,
} from './security.ts';

describe('renderer permissions', () => {
  it('allows sanitized clipboard writes only in the trusted main frame', () => {
    const origins = trustedOrigins(undefined);
    const top = { isMainFrame: true, requestingUrl: 'app://oat/index.html' };
    expect(allowsRendererPermission('clipboard-sanitized-write', top, origins)).toBe(true);
    expect(allowsRendererPermission('clipboard-read', top, origins)).toBe(false);
    expect(allowsRendererPermission('media', top, origins)).toBe(false);
    expect(
      allowsRendererPermission(
        'clipboard-sanitized-write',
        { ...top, isMainFrame: false },
        origins,
      ),
    ).toBe(false);
    expect(
      allowsRendererPermission(
        'clipboard-sanitized-write',
        { ...top, requestingUrl: 'https://example.com' },
        origins,
      ),
    ).toBe(false);
  });
});

describe('origins', () => {
  it('builds origins for app: URLs by hand (Node says "null")', () => {
    expect(originOf('app://oat/index.html#/main')).toBe(APP_ORIGIN);
    expect(originOf('http://localhost:5173/#/widget')).toBe('http://localhost:5173');
    expect(originOf('data:text/html,hi')).toBeNull();
    expect(originOf('file:///x')).toBeNull();
    expect(originOf('nonsense')).toBeNull();
  });

  it('trusts app://oat, plus the dev server only in dev', () => {
    expect([...trustedOrigins(undefined)]).toEqual([APP_ORIGIN]);
    expect([...trustedOrigins('http://localhost:5173/')]).toEqual([
      APP_ORIGIN,
      'http://localhost:5173',
    ]);
  });

  it('trusts only main frames on a trusted origin', () => {
    const origins = trustedOrigins(undefined);
    const top = { url: 'app://oat/index.html', parent: null };
    expect(isTrustedFrame(top, origins)).toBe(true);
    expect(isTrustedFrame({ url: 'app://oat/index.html', parent: top }, origins)).toBe(false);
    expect(isTrustedFrame({ url: 'app://evil/index.html', parent: null }, origins)).toBe(false);
    expect(isTrustedFrame({ url: 'https://oat.example', parent: null }, origins)).toBe(false);
    expect(isTrustedFrame(null, origins)).toBe(false);
  });
});

describe('navigation', () => {
  const origins = trustedOrigins(undefined);

  it('keeps in-app navigation, sends web links to the browser, blocks the rest', () => {
    expect(navigationDecision('app://oat/index.html#/widget', origins)).toBe('allow');
    expect(navigationDecision('https://example.com/a', origins)).toBe('open-external');
    expect(navigationDecision('http://localhost:3000/', origins)).toBe('open-external');
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,x',
      'oat://auth?code=x',
      'smb://host/share',
      'https://user:pw@example.com',
    ]) {
      expect(navigationDecision(url, origins), url).toBe('block');
    }
  });

  it('only http(s) links without credentials are opened externally', () => {
    expect(isSafeExternalUrl('/d/page?t=65&seg=s1')).toBe(false);
    expect(isSafeExternalUrl('https://oat.example/x')).toBe(true);
    expect(isSafeExternalUrl('mailto:a@b.c')).toBe(false);
    expect(isSafeExternalUrl('file:///Applications/Calculator.app')).toBe(false);
    expect(isSafeExternalUrl('not a url')).toBe(false);
  });
});

describe('CSP', () => {
  it('builds: no inline or eval scripts, no network, no frames', () => {
    const csp = contentSecurityPolicy({ dev: false });
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self';");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("connect-src 'self';");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    // Media only from main's meeting-audio protocol (3.7).
    expect(csp).toContain('media-src oat-audio:;');
  });

  it('dev: allows the Vite preamble and HMR socket only', () => {
    const csp = contentSecurityPolicy({ dev: true });
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain('ws://localhost:*');
    expect(csp).not.toContain('unsafe-eval');
  });
});
