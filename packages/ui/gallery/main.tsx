import { ThemeProvider } from 'next-themes';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { TooltipProvider } from '@oat/ui/components/tooltip';

import { App } from './App.tsx';
import './gallery.css';

// `?theme=light|dark` forces a theme (screenshots); `?static=1` pins floating overlays open.
const params = new URLSearchParams(window.location.search);
const forced = params.get('theme');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      forcedTheme={forced === 'light' || forced === 'dark' ? forced : undefined}
    >
      <TooltipProvider delay={300}>
        <App staticOverlays={params.has('static')} />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
