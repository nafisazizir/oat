'use client';

import { diffLines, documentLines } from '@oat/core/sync';
import { Button } from '@oat/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@oat/ui/components/dialog';
import { cn } from '@oat/ui';
import { CopyIcon, Loader2Icon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { formatDay } from '@/lib/format';
import { useHydrated } from '@/lib/use-hydrated';
import type { ConflictDetail } from '@/server/sync/conflicts';

type Keep = 'copy' | 'original';

/** `POST /api/sync/conflicts/:id` (same-origin, session cookie). */
async function resolve(copyId: string, keep: Keep, baseVersion?: number): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/sync/conflicts/${encodeURIComponent(copyId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ keep, ...(baseVersion !== undefined ? { baseVersion } : {}) }),
    });
  } catch {
    throw new Error('You’re offline or the server can’t be reached.');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => undefined)) as
      { error?: { message?: string } } | undefined;
    throw new Error(body?.error?.message ?? `Couldn’t resolve the conflict (${res.status}).`);
  }
}

/** The local date and time once hydrated (the server renders the day only: no locale mismatch). */
function when(iso: string | null, hydrated: boolean): string | null {
  if (!iso) return null;
  if (!hydrated) return formatDay(iso);
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Shown on a conflicted copy (3.5, D-19): whose edit lost and when, a side-by-side compare, and the
 * three ways out — keep this copy's text (it replaces the original), keep the other version, or merge by
 * hand (edit either note, then keep one). Resolving moves the copy to the trash.
 */
export function ConflictBanner({ conflict }: { conflict: ConflictDetail }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Keep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { copy, original } = conflict;
  const usable = original !== null && !original.deleted;
  const hydrated = useHydrated();
  const from =
    [copy.device, when(copy.at, hydrated)].filter(Boolean).join(' · ') || 'another device';

  async function keep(which: Keep) {
    setPending(which);
    setError(null);
    try {
      await resolve(copy.id, which, which === 'copy' ? original?.version : undefined);
      setOpen(false);
      router.push(original ? `/d/${original.id}` : '/home');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t resolve the conflict.');
      setPending(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-content px-6 pt-6 sm:px-8" data-testid="conflict-banner">
      <div
        role="status"
        className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm sm:flex-row sm:items-center"
      >
        <CopyIcon className="size-4 shrink-0 text-warning" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="font-medium">Conflicted copy from {from}</p>
          <p className="text-muted-foreground">
            {usable ? (
              <>
                This text was saved while{' '}
                <Link className="underline underline-offset-2" href={`/d/${original.id}`}>
                  the note
                </Link>{' '}
                changed elsewhere, so both versions were kept.
              </>
            ) : (
              'The note it was copied from is gone; this copy is an ordinary page now.'
            )}
          </p>
        </div>
        {usable && (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Compare
          </Button>
        )}
      </div>
      {usable && (
        <CompareDialog
          open={open}
          onOpenChange={setOpen}
          conflict={conflict}
          pending={pending}
          error={error}
          onKeep={keep}
        />
      )}
    </div>
  );
}

function CompareDialog({
  open,
  onOpenChange,
  conflict,
  pending,
  error,
  onKeep,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conflict: ConflictDetail;
  pending: Keep | null;
  error: string | null;
  onKeep: (which: Keep) => void;
}) {
  const { copy, original, canResolve } = conflict;
  const diff = useMemo(
    () =>
      diffLines(
        [original!.title, ...documentLines(original!.contentJson)],
        [copy.title.replace(/ \(conflicted copy\)$/, ''), ...documentLines(copy.contentJson)],
      ),
    [copy, original],
  );
  const canKeepCopy = canResolve && original!.editable;
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
        <div className="grid max-h-[60vh] grid-cols-1 gap-4 overflow-auto sm:grid-cols-2">
          <Side
            label={`Other version · edited ${formatDay(original!.updatedAt)}`}
            lines={diff.left}
            testId="compare-original"
          />
          <Side label="This copy" lines={diff.right} testId="compare-copy" />
        </div>
        <p role="alert" className="text-sm text-destructive empty:hidden">
          {error ??
            (!canResolve
              ? 'You can’t resolve this copy.'
              : !original!.editable
                ? 'You can’t edit the note, so this copy can’t replace it.'
                : '')}
        </p>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={!canResolve || pending !== null}
            onClick={() => onKeep('original')}
          >
            {pending === 'original' && (
              <Loader2Icon className="animate-spin" data-icon="inline-start" />
            )}
            Keep other version
          </Button>
          <Button disabled={!canKeepCopy || pending !== null} onClick={() => onKeep('copy')}>
            {pending === 'copy' && (
              <Loader2Icon className="animate-spin" data-icon="inline-start" />
            )}
            Keep this copy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Side({
  label,
  lines,
  testId,
}: {
  label: string;
  lines: { text: string; changed: boolean }[];
  testId: string;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2" data-testid={testId}>
      <h3 className="text-xs font-medium text-muted-foreground">{label}</h3>
      <div className="rounded-md border bg-muted/30 p-3 text-sm leading-relaxed">
        {lines.map((line, i) => (
          <p
            key={i}
            className={cn(
              'min-h-5 whitespace-pre-wrap break-words',
              i === 0 && 'font-medium',
              line.changed && '-mx-1 rounded-sm bg-warning/20 px-1',
            )}
          >
            {line.text}
          </p>
        ))}
      </div>
    </section>
  );
}
