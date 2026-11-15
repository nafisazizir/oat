'use client';

import { Toaster } from '@oat/ui/components/sonner';
import { TooltipProvider } from '@oat/ui/components/tooltip';
import { useEffect } from 'react';

import { ThemeProvider, useTheme } from './theme-provider';

/** The @oat/ui Toaster reads next-themes by default; we pass our own theme explicitly instead. */
function ThemedToaster() {
  const { theme } = useTheme();
  return <Toaster theme={theme} position="bottom-right" />;
}

/** App-wide client providers, mounted once in the root layout. */
export function Providers({ children }: { children: React.ReactNode }) {
  // `<html data-hydrated>` once React has hydrated the page: until then client-only controls (menus,
  // fetch-on-click buttons) don't respond. e2e waits for it after every full page load (e2e/fixtures.ts).
  useEffect(() => {
    document.documentElement.dataset.hydrated = '';
  }, []);
  return (
    <ThemeProvider>
      <TooltipProvider delayDuration={300}>
        {children}
        <ThemedToaster />
      </TooltipProvider>
    </ThemeProvider>
  );
}
