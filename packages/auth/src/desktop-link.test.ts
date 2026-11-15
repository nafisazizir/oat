import { describe, expect, it } from 'vitest';

import {
  desktopCallbackUrl,
  desktopSignInUrl,
  findDeepLinkArg,
  isDesktopAuthValue,
  parseDesktopDeepLink,
  pkceChallenge,
  randomDesktopValue,
  timingSafeEqualStrings,
} from './desktop-link.ts';

const A = 'a'.repeat(43);
const B = 'B-_'.repeat(14) + 'z';

describe('desktop sign-in values', () => {
  it('random values are 43 base64url characters and differ', () => {
    const values = new Set(Array.from({ length: 50 }, randomDesktopValue));
    expect(values.size).toBe(50);
    for (const v of values) expect(isDesktopAuthValue(v)).toBe(true);
  });

  it('PKCE S256 matches the RFC 7636 example', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('rejects anything but the exact format', () => {
    for (const bad of [
      '',
      'a'.repeat(42),
      'a'.repeat(44),
      `${'a'.repeat(42)}=`,
      `${'a'.repeat(42)}/`,
      7,
      null,
    ]) {
      expect(isDesktopAuthValue(bad)).toBe(false);
    }
  });

  it('compares strings without early exit semantics leaking into the result', () => {
    expect(timingSafeEqualStrings(A, A)).toBe(true);
    expect(timingSafeEqualStrings(A, B)).toBe(false);
    expect(timingSafeEqualStrings(A, A.slice(1))).toBe(false);
  });
});

describe('URLs', () => {
  it('builds the browser URL and the callback link', () => {
    expect(desktopSignInUrl('http://localhost:3000', A, B)).toBe(
      `http://localhost:3000/desktop/sign-in?state=${A}&challenge=${B}`,
    );
    expect(desktopCallbackUrl(A, B)).toBe(`oat://auth?code=${A}&state=${B}`);
  });

  it('round-trips a callback link', () => {
    expect(parseDesktopDeepLink(desktopCallbackUrl(A, B))).toEqual({
      kind: 'auth',
      code: A,
      state: B,
    });
    expect(parseDesktopDeepLink(`oat://auth/?state=${B}&code=${A}`)).toEqual({
      kind: 'auth',
      code: A,
      state: B,
    });
  });

  it.each([
    ['other scheme', `https://auth?code=${A}&state=${B}`],
    ['other host', `oat://evil?code=${A}&state=${B}`],
    ['a path', `oat://auth/x?code=${A}&state=${B}`],
    ['credentials', `oat://u:p@auth?code=${A}&state=${B}`],
    ['a port', `oat://auth:1?code=${A}&state=${B}`],
    ['a fragment', `oat://auth?code=${A}&state=${B}#x`],
    ['missing state', `oat://auth?code=${A}`],
    ['missing code', `oat://auth?state=${B}`],
    ['repeated code', `oat://auth?code=${A}&code=${A}&state=${B}`],
    ['malformed code', `oat://auth?code=${A}x&state=${B}`],
    ['not a URL', 'oat:auth'],
    ['too long', `oat://auth?code=${A}&state=${B}&pad=${'x'.repeat(2048)}`],
  ])('rejects a link with %s', (_label, url) => {
    expect(parseDesktopDeepLink(url)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(parseDesktopDeepLink(undefined)).toBeNull();
    expect(parseDesktopDeepLink({ url: 'oat://auth' })).toBeNull();
  });

  it('finds the deep link in a second instance’s argv', () => {
    expect(findDeepLinkArg(['/Applications/Oat.app', '--flag', 'oat://auth?code=x'])).toBe(
      'oat://auth?code=x',
    );
    expect(findDeepLinkArg(['/Applications/Oat.app', 'OAT://auth'])).toBe('OAT://auth');
    expect(findDeepLinkArg(['electron', '.'])).toBeUndefined();
  });
});
