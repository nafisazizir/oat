'use client';

import { Button } from '@oat/ui/components/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@oat/ui/components/empty';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useEffect, useSyncExternalStore } from 'react';

import { Wordmark } from '@/components/wordmark';
import { DARK_QUERY, THEME_STORAGE_KEY, parsePreference, resolveTheme } from '@/lib/theme';

import './globals.css';

/**
 * Last-resort boundary: errors thrown by the root or `(app)` layouts (session and shell loading,
 * 1.6/3.3) land here, where no layout is rendered, so it brings its own <html>, <body>, styles and
 * theme. It is rendered on the client, where React won't run a <script>, so the theme class comes
 * from a store read instead of the head script. Kept dependency-light: no providers.
 */
function subscribe(onChange: () => void) {
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function themeClass(): string {
  try {
    const preference = parsePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
    return resolveTheme(preference, window.matchMedia(DARK_QUERY).matches);
  } catch {
    return 'light';
  }
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const theme = useSyncExternalStore(subscribe, themeClass, () => undefined);
  // Same hydration marker as the root `Providers`, which aren't rendered here (e2e/fixtures.ts).
  useEffect(() => {
    document.documentElement.dataset.hydrated = '';
  }, []);
  return (
    <html lang="en" className={theme} suppressHydrationWarning>
      <head>
        <title>Something went wrong · Oat</title>
      </head>
      <body>
        <main className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background-100 px-6 text-center text-gray-1000">
          <Wordmark size="lg" />
          <Empty
            role="alert"
            className="max-w-md flex-none rounded-xl border border-gray-alpha-400 p-10"
          >
            <EmptyHeader>
              <EmptyMedia variant="icon" className="bg-red-100 text-red-900">
                <IconAlertTriangle />
              </EmptyMedia>
              <EmptyTitle>
                <h1 className="text-display-20">Oat couldn’t load</h1>
              </EmptyTitle>
              <EmptyDescription>
                Something went wrong on our side. Try again, or reload the app.
              </EmptyDescription>
              {error.digest && (
                <p className="text-label-12-mono text-gray-900">Reference {error.digest}</p>
              )}
            </EmptyHeader>
            <EmptyContent className="flex-row justify-center">
              <Button onClick={() => reset()}>Try again</Button>
              <Button variant="ghost" role="link" nativeButton={false} render={<a href="/home" />}>
                Go home
              </Button>
            </EmptyContent>
          </Empty>
        </main>
      </body>
    </html>
  );
}
