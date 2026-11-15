import { describe, expect, it } from 'vitest';

import { THEME_STORAGE_KEY, parsePreference, resolveTheme, themeScript } from './theme';

/** Runs the inline head script against a fake document / storage / media query. */
function runScript({ stored, systemDark }: { stored: string | null; systemDark: boolean }) {
  const classes = new Set<string>();
  const document = {
    documentElement: {
      classList: {
        toggle: (name: string, force: boolean) =>
          force ? classes.add(name) : classes.delete(name),
      },
    },
  };
  const localStorage = {
    getItem: (key: string) => (key === THEME_STORAGE_KEY ? stored : null),
  };
  const window = { matchMedia: () => ({ matches: systemDark }) };
  new Function('document', 'localStorage', 'window', themeScript)(document, localStorage, window);
  return classes.has('dark');
}

describe('theme', () => {
  it('parses stored preferences, defaulting to system', () => {
    expect(parsePreference('light')).toBe('light');
    expect(parsePreference('dark')).toBe('dark');
    expect(parsePreference('system')).toBe('system');
    expect(parsePreference(null)).toBe('system');
    expect(parsePreference('sepia')).toBe('system');
  });

  it('resolves system against the OS appearance', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('head script agrees with resolveTheme for every case', () => {
    for (const stored of ['light', 'dark', 'system', null, 'junk']) {
      for (const systemDark of [true, false]) {
        const expected = resolveTheme(parsePreference(stored), systemDark) === 'dark';
        expect(runScript({ stored, systemDark }), `${stored} / systemDark=${systemDark}`).toBe(
          expected,
        );
      }
    }
  });

  it('head script never throws (e.g. storage blocked)', () => {
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(() => new Function('localStorage', themeScript)(blocked)).not.toThrow();
  });
});
