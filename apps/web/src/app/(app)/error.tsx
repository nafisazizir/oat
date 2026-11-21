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
      <Empty role="alert">
        <EmptyHeader>
          <EmptyMedia variant="icon" className="bg-red-100 text-red-900">
            <IconAlertTriangle />
          </EmptyMedia>
          <EmptyTitle>
            <h1 className="text-display-20">Something went wrong</h1>
          </EmptyTitle>
          <EmptyDescription>
            This page couldn’t load. Try again, or head back home.
          </EmptyDescription>
          {error.digest && (
            <p className="text-label-12-mono text-gray-900">Reference {error.digest}</p>
          )}
        </EmptyHeader>
        <EmptyContent className="flex-row justify-center">
          <Button onClick={() => reset()}>Try again</Button>
          <Button variant="ghost" role="link" nativeButton={false} render={<Link href="/home" />}>
            Go home
          </Button>
        </EmptyContent>
      </Empty>
    </PageContainer>
  );
}
