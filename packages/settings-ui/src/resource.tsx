'use client';

import { Alert, AlertDescription } from '@oat/ui/components/alert';
import { Button } from '@oat/ui/components/button';
import { Spinner } from '@oat/ui/components/spinner';
import { IconAlertCircle } from '@tabler/icons-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { errorMessage } from './services';

export function useSettingsResource<T>(load: (signal: AbortSignal) => Promise<T>) {
  const [value, setValue] = useState<{ data: T } | { error: string } | null>(null);
  const active = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    active.current?.abort();
    const request = new AbortController();
    active.current = request;
    try {
      const data = await load(request.signal);
      if (!request.signal.aborted) setValue({ data });
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
  }, [load]);
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
    <p className="flex items-center gap-2 text-copy-14 text-gray-900" role="status">
      <Spinner />
      Loading settings…
    </p>
  );
}
