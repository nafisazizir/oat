import './styles.css';

import { ThemeProvider } from '@oat/settings-ui';
import {
  DARK_QUERY,
  parsePreference,
  resolveTheme,
  THEME_STORAGE_KEY,
} from '@oat/settings-ui/theme';
import { lazy, StrictMode, Suspense, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { bridge } from './bridge.ts';
import { windowKindFromHash } from './routes.ts';

const kind = windowKindFromHash(window.location.hash);
document.documentElement.dataset.window = kind;

// Apply the stored preference before rendering, then let the shared provider track changes.
const systemDark = window.matchMedia(DARK_QUERY).matches;
try {
  const theme = resolveTheme(parsePreference(localStorage.getItem(THEME_STORAGE_KEY)), systemDark);
  document.documentElement.classList.toggle('dark', theme === 'dark');
} catch {
  document.documentElement.classList.toggle('dark', systemDark);
}

// Each window kind's UI is its own chunk; a window only loads its own.
const MainWindow = lazy(() => import('./windows/main-window.tsx'));
const WidgetWindow = lazy(() => import('./windows/widget-window.tsx'));

/** Tells main the window has rendered (cold-start measurement for the main window). */
function Rendered() {
  useEffect(() => {
    requestAnimationFrame(() => bridge().send('app:rendered', { window: kind }));
  }, []);
  return null;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <ThemeProvider>{kind === 'widget' ? <WidgetWindow /> : <MainWindow />}</ThemeProvider>
      <Rendered />
    </Suspense>
  </StrictMode>,
);
