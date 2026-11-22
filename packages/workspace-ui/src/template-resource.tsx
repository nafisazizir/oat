'use client';

import { useEffect, useState } from 'react';
import { Button } from '@oat/ui/components/button';
import { PageContainer } from './page';

export function useTemplateResource<T>(initial: T | undefined, load: () => Promise<T>) {
  const [loaded, setLoaded] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (initial) return;
    let active = true;
    void load().then(
      (data) => {
        if (active) setLoaded(data);
      },
      (error: unknown) => {
        if (active) setError(error instanceof Error ? error.message : 'Couldn’t load templates.');
      },
    );
    return () => {
      active = false;
    };
  }, [initial, load, attempt]);
  return {
    data: initial ?? loaded,
    error,
    retry: () => {
      setError(null);
      setAttempt((n) => n + 1);
    },
  };
}

export function TemplateLoading({ error, retry }: { error: string | null; retry: () => void }) {
  return (
    <PageContainer>
      {error ? (
        <div role="alert" className="flex flex-col items-start gap-3 text-copy-14 text-red-900">
          <p>{error}</p>
          <Button variant="outline" onClick={retry}>
            Try again
          </Button>
        </div>
      ) : (
        <p role="status" className="text-copy-14 text-gray-900">
          Loading templates…
        </p>
      )}
    </PageContainer>
  );
}
