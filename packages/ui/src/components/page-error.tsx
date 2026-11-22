'use client';

import { IconAlertTriangle } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { Button } from './button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from './empty';

export function errorDigest(error: unknown): string | undefined {
  return error !== null &&
    typeof error === 'object' &&
    'digest' in error &&
    typeof error.digest === 'string'
    ? error.digest
    : undefined;
}

export function PageError({
  onRetry,
  onReload,
  home,
  digest,
  children,
  compact = false,
}: {
  onRetry(): void;
  onReload?(): void;
  home?: ReactNode;
  digest?: string;
  children?: ReactNode;
  compact?: boolean;
}) {
  return (
    <Empty role="alert" className={compact ? 'gap-2 p-2' : undefined}>
      <EmptyHeader>
        {!compact && (
          <EmptyMedia variant="icon" className="bg-red-100 text-red-900">
            <IconAlertTriangle />
          </EmptyMedia>
        )}
        <EmptyTitle>
          <h1>Something went wrong</h1>
        </EmptyTitle>
        {!compact && (
          <EmptyDescription>
            This page couldn’t load. Try again, or head back home.
          </EmptyDescription>
        )}
        {!compact && children}
        {digest && <p className="text-label-12-mono text-gray-900">Reference {digest}</p>}
      </EmptyHeader>
      <EmptyContent className="flex-row justify-center">
        <Button onClick={onRetry}>Try again</Button>
        {onReload && (
          <Button variant="outline" onClick={onReload}>
            Reload
          </Button>
        )}
        {home}
      </EmptyContent>
    </Empty>
  );
}
