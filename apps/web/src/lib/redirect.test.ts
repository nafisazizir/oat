import { describe, expect, it } from 'vitest';

import { safeNextPath, signInPath } from './redirect';

const BASE = 'http://oat.invalid';

describe('safeNextPath', () => {
  it('keeps same-origin paths with query and hash', () => {
    expect(safeNextPath('/d/abc')).toBe('/d/abc');
    expect(safeNextPath('/settings?tab=env#x')).toBe('/settings?tab=env#x');
    expect(safeNextPath(['/templates', '/x'])).toBe('/templates');
    expect(safeNextPath('/d/a/../b')).toBe('/d/b');
    expect(safeNextPath('/d/a%20b')).toBe('/d/a%20b');
  });

  // Reviewer payloads (1.6 review #1): these normalise to `//evil.com`.
  it.each(['/.//evil.com', '/a/..//evil.com', '/%2e//evil.com', '/%2E//evil.com'])(
    'rejects %s',
    (payload) => {
      expect(safeNextPath(payload)).toBe('/home');
    },
  );

  it.each([
    undefined,
    null,
    '',
    'home',
    'evil.com',
    'https://evil.test/',
    'HTTPS://evil.test',
    '//evil.test/x',
    '///evil.test',
    '/\\evil.test',
    '\\/evil.test',
    '/\\/evil.test',
    '/%5cevil.test',
    '/%5Cevil.test',
    '/%2f/evil.test',
    '/%2F%2Fevil.test',
    '/%252f%252fevil.test',
    '/%25252f%25252fevil.test',
    '/..%2f..%2f/evil.test',
    '/a/../..//evil.test',
    '/./../.././/evil.test',
    '/%2e%2e//evil.test',
    '/%2e%2e/%2e%2e//evil.test',
    'javascript:alert(1)',
    '/javascript:alert(1)',
    '/x?u=https://evil.test',
    '/\tevil',
    '/\n/evil.test',
    '/%0a/evil.test',
    '/%00',
    '/%E0%A4%A', // malformed encoding
    '/sign-in',
    '/sign-in?next=/home',
    '/sign-in/',
  ])('falls back to /home for %j', (payload) => {
    expect(safeNextPath(payload)).toBe('/home');
  });

  it('fuzz: whatever the input, the result stays on this origin and never starts with // or /\\', () => {
    const parts = [
      '/',
      '//',
      '\\',
      '.',
      '..',
      '%2e',
      '%2f',
      '%5c',
      '%25',
      'evil.com',
      'a',
      ':',
      '?',
      '#',
      '@',
    ];
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 5000; i++) {
      const length = 1 + Math.floor(rand() * 6);
      let input = '';
      for (let j = 0; j < length; j++) input += parts[Math.floor(rand() * parts.length)];
      const out = safeNextPath(input);
      expect(out.startsWith('/'), input).toBe(true);
      expect(out.startsWith('//') || out.startsWith('/\\'), input).toBe(false);
      expect(out.includes('\\'), input).toBe(false);
      expect(new URL(out, BASE).origin, input).toBe(BASE);
      expect(decodeURIComponent(out).startsWith('//'), input).toBe(false);
    }
  });
});

describe('signInPath', () => {
  it('adds next only when it is not the default', () => {
    expect(signInPath()).toBe('/sign-in');
    expect(signInPath('/home')).toBe('/sign-in');
    expect(signInPath('/d/abc?x=1')).toBe('/sign-in?next=%2Fd%2Fabc%3Fx%3D1');
    expect(signInPath('https://evil.test')).toBe('/sign-in');
    expect(signInPath('/.//evil.com')).toBe('/sign-in');
  });
});
