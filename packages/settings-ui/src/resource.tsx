'use client';

import { Alert, AlertDescription } from '@oat/ui/components/alert';
import { Button } from '@oat/ui/components/button';
import { Spinner } from '@oat/ui/components/spinner';
import { IconAlertCircle } from '@tabler/icons-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

import { errorMessage } from './services';

const Cache = createContext<Map<string, unknown> | null>(null);

/**
 * What the settings pages loaded, kept for as long as the settings are open: coming back to a page
 * shows what it had at once and checks for changes behind it, instead of starting from "Loading" again.
 */
export function SettingsResourceCache({ children }: { children: React.ReactNode }) {
  const [cache] = useState(() => new Map<string, unknown>());
  return <Cache.Provider value={cache}>{children}</Cache.Provider>;
}

/** For a page that saves a resource itself: what it saved is what the next visit starts from. */
export function useSettingsCacheWrite() {
  const cache = useContext(Cache);
  return useCallback((key: string, data: unknown) => void cache?.set(key, data), [cache]);
}

export const settingsCacheKeys = {
  profile: 'profile',
  environment: 'environment',
  calendar: 'calendar',
  workspace: (id: string) => `workspace:${id}`,
  pipeline: (id: string) => `pipeline:${id}`,
  notion: (id: string) => `notion:${id}`,
};

/**
 * Loads these resources into the cache while another page is showing, so the first visit to a page
 * has its data too. One that fails is left for its own page to load, and to report.
 */
export function useSettingsPrefetch(
  loads: Record<string, (signal: AbortSignal) => Promise<unknown>>,
) {
  const cache = useContext(Cache);
  const latest = useRef(loads);
  useEffect(() => {
    latest.current = loads;
  });
  const keys = Object.keys(loads).join(' ');
  useEffect(() => {
    if (!cache) return;
    const request = new AbortController();
    for (const [key, load] of Object.entries(latest.current)) {
      if (cache.has(key)) continue;
      void load(request.signal)
        .then((data) => {
          if (!request.signal.aborted && !cache.has(key)) cache.set(key, data);
        })
        .catch(() => {});
    }
    return () => request.abort();
  }, [cache, keys]);
}

/** `cacheKey` names the resource, including whatever it depends on (the workspace id). */
export function useSettingsResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  cacheKey?: string,
) {
  const cache = useContext(Cache);
  const [value, setValue] = useState<{ data: T } | { error: string } | null>(() =>
    cacheKey !== undefined && cache?.has(cacheKey) ? { data: cache.get(cacheKey) as T } : null,
  );
  const active = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    active.current?.abort();
    const request = new AbortController();
    active.current = request;
    try {
      const data = await load(request.signal);
      if (!request.signal.aborted) {
        if (cacheKey !== undefined) cache?.set(cacheKey, data);
        setValue({ data });
      }
    } catch (error) {
      if (!request.signal.aborted) {
        setValue((previous) =>
          previous && 'data' in previous
            ? previous
            : { error: errorMessage(error, 'Couldn’t load settings.') },
        );
        throw error;
      }
    }
  }, [load, cache, cacheKey]);
  useEffect(() => {
    void refresh().catch(() => {});
    return () => active.current?.abort();
  }, [refresh]);
  return { value, refresh };
}

export function SettingsLoadState({
  error,
  retry,
}: {
  error?: string;
  retry: () => Promise<void>;
}) {
  return error ? (
    <Alert variant="destructive">
      <IconAlertCircle />
      <AlertDescription>
        {error}
        <Button size="sm" variant="ghost" onClick={() => void retry().catch(() => {})}>
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  ) : (
    // Held back 200ms: a load that fast shows nothing in between, so the page doesn't blink.
    <p
      className="flex animate-in items-center gap-2 text-copy-14 text-gray-900 delay-200 duration-150 fill-mode-both fade-in-0"
      role="status"
    >
      <Spinner />
      Loading settings…
    </p>
  );
}
