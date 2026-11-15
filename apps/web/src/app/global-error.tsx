'use client';

import { Button } from '@oat/ui/components/button';
import { TriangleAlertIcon } from 'lucide-react';
import { useSyncExternalStore } from 'react';

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
  return (
    <html lang="en" className={theme} suppressHydrationWarning>
      <head>
        <title>Something went wrong · Oat</title>
      </head>
      <body>
        <main className="flex min-h-svh flex-col items-center justify-center gap-6 px-6 text-center">
          <Wordmark className="text-3xl" />
          <div
            role="alert"
            className="flex w-full max-w-md flex-col items-center gap-4 rounded-xl border bg-card px-6 py-10 shadow-xs"
          >
            <div className="flex size-11 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <TriangleAlertIcon className="size-5" />
            </div>
            <div className="flex flex-col gap-1">
              <h1 className="text-lg font-medium">Oat couldn’t load</h1>
              <p className="text-sm text-muted-foreground">
                Something went wrong on our side. Try again, or reload the app.
              </p>
              {error.digest && (
                <p className="font-mono text-xs text-muted-foreground">Reference {error.digest}</p>
              )}
            </div>
            <div className="flex gap-2">
              <Button onClick={() => reset()}>Try again</Button>
              <Button variant="ghost" asChild>
                {/* A plain anchor: a full reload, not a client transition from a broken tree. */}
                <a href="/home">Go home</a>
              </Button>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
