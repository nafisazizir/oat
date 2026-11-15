'use client';

import { Toaster } from '@oat/ui/components/sonner';
import { TooltipProvider } from '@oat/ui/components/tooltip';

import { ThemeProvider, useTheme } from './theme-provider';

/** The @oat/ui Toaster reads next-themes by default; we pass our own theme explicitly instead. */
function ThemedToaster() {
  const { theme } = useTheme();
  return <Toaster theme={theme} position="bottom-right" />;
}

/** App-wide client providers, mounted once in the root layout. */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <TooltipProvider delayDuration={300}>
        {children}
        <ThemedToaster />
      </TooltipProvider>
    </ThemeProvider>
  );
}
