// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyDesktopTheme, setDesktopTheme } from './theme.ts';

afterEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('dark');
  vi.unstubAllGlobals();
});
describe('desktop appearance', () => {
  it('persists light/dark choices and follows the OS in system mode', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    setDesktopTheme('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem('oat.theme')).toBe('light');
    setDesktopTheme('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    setDesktopTheme('system');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    applyDesktopTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
