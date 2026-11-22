'use client';

import type { ReactNode } from 'react';
import { IconCopy } from '@tabler/icons-react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@oat/ui/components/alert';
import { Button } from '@oat/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@oat/ui/components/dialog';
import { Skeleton } from '@oat/ui/components/skeleton';
import { Spinner } from '@oat/ui/components/spinner';
import { cn } from '@oat/ui';

export type ConflictLine = { text: string; changed: boolean };
export type ConflictComparison = {
  original: ConflictLine[] | null;
  copy: ConflictLine[];
  originalLabel?: string;
  canKeepCopy: boolean;
  canKeepOriginal: boolean;
  permissionMessage?: string;
};
export function ConflictNotice({
  title,
  children,
  onCompare,
}: {
  title: string;
  children: ReactNode;
  onCompare?(): void;
}) {
  return (
    <Alert role="status" className="border-gray-alpha-400 bg-background-200 [&>svg]:text-amber-900">
      <IconCopy className="text-amber-900" aria-hidden />
      <AlertTitle className="text-gray-1000">{title}</AlertTitle>
      <AlertDescription className="text-gray-900">{children}</AlertDescription>
      {onCompare && (
        <AlertAction>
          <Button size="sm" variant="secondary" onClick={onCompare}>
            Compare
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
}
export function ConflictCompareDialog({
  open,
  onOpenChange,
  data,
  loadError,
  onRetry,
  error,
  pending,
  onKeep,
  notice,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  data?: ConflictComparison | null;
  loadError?: string | null;
  onRetry?(): void;
  error?: string | null;
  pending: 'copy' | 'original' | null;
  onKeep(which: 'copy' | 'original'): void;
  notice?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl" data-testid="conflict-compare">
        <DialogHeader>
          <DialogTitle>Compare versions</DialogTitle>
          <DialogDescription>
            Highlighted lines are only in one version. To merge by hand, copy what you need into the
            note, then keep the other version.
          </DialogDescription>
        </DialogHeader>
        {notice}
        {loadError ? (
          <div role="alert" className="flex flex-col items-start gap-2 text-copy-14 text-red-900">
            <p>{loadError}</p>
            {onRetry && (
              <Button variant="secondary" onClick={onRetry}>
                Try again
              </Button>
            )}
          </div>
        ) : data ? (
          <div className="grid max-h-[60vh] grid-cols-1 gap-4 overflow-auto sm:grid-cols-2">
            <ConflictSide
              label={data.originalLabel ?? 'Other version'}
              lines={data.original}
              testId="compare-original"
            />
            <ConflictSide label="This copy" lines={data.copy} testId="compare-copy" />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4" aria-busy>
            {['Other version', 'This copy'].map((label) => (
              <section key={label} className="flex min-w-0 flex-col gap-2">
                <h3 className="text-label-12 text-gray-900">{label}</h3>
                <div className="flex flex-col gap-2 rounded-md border border-gray-alpha-400 bg-background-200 p-3">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-5/6" />
                </div>
              </section>
            ))}
          </div>
        )}
        <p role="alert" className="text-copy-14 text-red-900 empty:hidden">
          {error ?? data?.permissionMessage}
        </p>
        {error && onRetry && !loadError && (
          <Button variant="secondary" onClick={onRetry}>
            Compare again
          </Button>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={!data?.canKeepOriginal || pending !== null}
            onClick={() => onKeep('original')}
          >
            {pending === 'original' && <Spinner data-icon="inline-start" />}Keep other version
          </Button>
          <Button disabled={!data?.canKeepCopy || pending !== null} onClick={() => onKeep('copy')}>
            {pending === 'copy' && <Spinner data-icon="inline-start" />}Keep this copy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
function ConflictSide({
  label,
  lines,
  testId,
}: {
  label: string;
  lines: ConflictLine[] | null;
  testId: string;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2" data-testid={testId}>
      <h3 className="text-label-13 text-gray-900">{label}</h3>
      <div
        className="rounded-md border border-gray-alpha-400 bg-background-200 p-3 text-copy-14 text-gray-1000"
        data-selectable
      >
        {lines === null ? (
          <p className="text-gray-900">The note this was copied from is gone.</p>
        ) : (
          lines.map((line, i) => (
            <p
              key={i}
              className={cn(
                'min-h-5 whitespace-pre-wrap break-words',
                i === 0 && 'text-label-14',
                line.changed && '-mx-1 rounded-sm bg-amber-200 px-1',
              )}
            >
              {line.text}
            </p>
          ))
        )}
      </div>
    </section>
  );
}
