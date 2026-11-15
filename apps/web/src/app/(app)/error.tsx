'use client';

import { Button } from '@oat/ui/components/button';
import { TriangleAlertIcon } from 'lucide-react';
import Link from 'next/link';

import { PageContainer } from '@/components/page';

/** Error boundary for app pages: the shell (sidebar, top bar) stays usable around it. */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <PageContainer>
      <div
        role="alert"
        className="flex flex-col items-center gap-4 rounded-xl border bg-card px-6 py-12 text-center shadow-xs"
      >
        <div className="flex size-11 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <TriangleAlertIcon className="size-5" />
        </div>
        <div className="flex max-w-sm flex-col gap-1">
          <h1 className="text-lg font-medium">Something went wrong</h1>
          <p className="text-sm text-muted-foreground">
            This page couldn’t load. Try again, or head back home.
          </p>
          {error.digest && (
            <p className="font-mono text-xs text-muted-foreground">Reference {error.digest}</p>
          )}
        </div>
        <div className="flex gap-2">
          <Button onClick={() => reset()}>Try again</Button>
          <Button variant="ghost" asChild>
            <Link href="/home">Go home</Link>
          </Button>
        </div>
      </div>
    </PageContainer>
  );
}
