/**
 * Light / dark / system theme, without a flash and without next-themes.
 *
 * Why not next-themes: on React 19 its provider renders a `<script>` from a component, which React logs
 * as an error on client renders (1.3 design notes). Instead the root layout (a server component) puts
 * `themeScript` in `<head>`, where it runs before first paint, and `ThemeProvider` keeps the `.dark` class
 * in sync afterwards. The preference lives in localStorage; "system" follows `prefers-color-scheme`.
 */

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'oat-theme';
export const DARK_QUERY = '(prefers-color-scheme: dark)';
export const themePreferences: readonly ThemePreference[] = ['light', 'dark', 'system'];

export function parsePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return preference;
}

/**
 * Inline `<head>` script: applies the stored preference before first paint. Self-contained (it can't
 * import anything), so it duplicates `parsePreference` + `resolveTheme`; `theme.test.ts` runs it.
 */
export const themeScript = `(function(){try{var p=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(p!=="light"&&p!=="dark")p="system";var d=p==="dark"||(p==="system"&&window.matchMedia(${JSON.stringify(
  DARK_QUERY,
)}).matches);document.documentElement.classList.toggle("dark",d)}catch(e){}})()`;
