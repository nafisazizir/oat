'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';

import {
  DARK_QUERY,
  THEME_STORAGE_KEY,
  parsePreference,
  resolveTheme,
  type ResolvedTheme,
  type ThemePreference,
} from '@/lib/theme';

type ThemeContextValue = {
  /** The stored preference. `system` during SSR and hydration. */
  theme: ThemePreference;
  /** What is on screen. `undefined` until hydrated (the server can't know). */
  resolvedTheme: ResolvedTheme | undefined;
  setTheme: (theme: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

// The preference is an external store (localStorage + other tabs), read with useSyncExternalStore.
const listeners = new Set<() => void>();
// Fallback when localStorage is blocked (private mode): the choice lasts for this page only.
let memoryPreference: ThemePreference = 'system';

function readPreference(): ThemePreference {
  try {
    return parsePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return memoryPreference;
  }
}

function subscribePreference(onChange: () => void) {
  listeners.add(onChange);
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY) onChange();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onStorage);
  };
}

function subscribeSystem(onChange: () => void) {
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

const systemDarkSnapshot = () => window.matchMedia(DARK_QUERY).matches;
const serverPreference = (): ThemePreference => 'system';
const serverSystemDark = () => undefined;

/** Swaps the `.dark` class with transitions off, so colours change in one frame instead of animating. */
function applyTheme(theme: ResolvedTheme) {
  const root = document.documentElement;
  if (root.classList.contains('dark') === (theme === 'dark')) return;
  const style = document.createElement('style');
  style.textContent = '*,*::before,*::after{transition:none!important}';
  document.head.appendChild(style);
  root.classList.toggle('dark', theme === 'dark');
  void window.getComputedStyle(root).opacity; // flush styles before transitions come back
  requestAnimationFrame(() => style.remove());
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useSyncExternalStore(subscribePreference, readPreference, serverPreference);
  const systemDark = useSyncExternalStore(subscribeSystem, systemDarkSnapshot, serverSystemDark);
  const resolvedTheme = systemDark === undefined ? undefined : resolveTheme(theme, systemDark);

  // Keep the DOM in sync with the store (setTheme, other tabs, OS appearance changes).
  useEffect(() => {
    if (resolvedTheme) applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  const setTheme = useCallback((next: ThemePreference) => {
    memoryPreference = next;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage blocked: memoryPreference carries it.
    }
    for (const listener of listeners) listener();
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within a ThemeProvider.');
  return context;
}
