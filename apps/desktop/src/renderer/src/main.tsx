import './styles.css';

import { lazy, StrictMode, Suspense, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { bridge } from './bridge.ts';
import { windowKindFromHash } from './routes.ts';

const kind = windowKindFromHash(window.location.hash);
document.documentElement.dataset.window = kind;

// Follow the OS appearance (tokens.css has light + `.dark`).
const dark = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => document.documentElement.classList.toggle('dark', dark.matches);
applyTheme();
dark.addEventListener('change', applyTheme);

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
      {kind === 'widget' ? <WidgetWindow /> : <MainWindow />}
      <Rendered />
    </Suspense>
  </StrictMode>,
);
