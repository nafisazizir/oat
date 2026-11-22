'use client';

import { diffLines, documentLines } from '@oat/core/sync';
import { ConflictCompareDialog, ConflictNotice } from '@oat/workspace-ui/conflicts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { formatDay } from '@/lib/format';
import { useHydrated } from '@/lib/use-hydrated';
import type { ConflictDetail } from '@/server/sync/conflicts';

type Keep = 'copy' | 'original';

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

function when(iso: string | null, hydrated: boolean): string | null {
  if (!iso) return null;
  return hydrated
    ? new Date(iso).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : formatDay(iso);
}

export function ConflictBanner({ conflict }: { conflict: ConflictDetail }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Keep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { copy, original, canResolve } = conflict;
  const usable = original !== null && !original.deleted;
  const hydrated = useHydrated();
  const from =
    [copy.device, when(copy.at, hydrated)].filter(Boolean).join(' · ') || 'another device';
  const diff = useMemo(
    () =>
      original
        ? diffLines(
            [original.title, ...documentLines(original.contentJson)],
            [copy.title.replace(/ \(conflicted copy\)$/, ''), ...documentLines(copy.contentJson)],
          )
        : null,
    [copy, original],
  );
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
      <ConflictNotice
        title={`Conflicted copy from ${from}`}
        onCompare={usable ? () => setOpen(true) : undefined}
      >
        {usable ? (
          <>
            This text was saved while{' '}
            <Link
              className="text-gray-1000 underline underline-offset-2"
              href={`/d/${original.id}`}
            >
              the note
            </Link>{' '}
            changed elsewhere, so both versions were kept.
          </>
        ) : (
          'The note it was copied from is gone; this copy is an ordinary page now.'
        )}
      </ConflictNotice>
      {usable && diff && (
        <ConflictCompareDialog
          open={open}
          onOpenChange={setOpen}
          pending={pending}
          error={error}
          onKeep={(which) => void keep(which)}
          onRetry={() => {
            setError(null);
            router.refresh();
          }}
          data={{
            original: diff.left,
            copy: diff.right,
            originalLabel: `Other version · edited ${formatDay(original.updatedAt)}`,
            canKeepOriginal: canResolve,
            canKeepCopy: canResolve && original.editable,
            permissionMessage: !canResolve
              ? 'You can’t resolve this copy.'
              : !original.editable
                ? 'You can’t edit the note, so this copy can’t replace it.'
                : undefined,
          }}
        />
      )}
    </div>
  );
}
