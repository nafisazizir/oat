import type { ConflictDetailSnapshot, ConflictSummary } from '@oat/core/bridge';
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
import { IconCopy } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import { BridgeCallError, call } from '../bridge.ts';
import { conflictOrigin } from './search-text.ts';

/**
 * Conflicted copies on this Mac (3.5, D-19): listed in the sidebar while there are any; each opens a
 * side-by-side compare with "Keep this copy" (its text replaces the note) and "Keep other version" (the
 * copy is deleted). Merging by hand = edit the note, then keep the other version. Resolutions are local
 * edits that sync like any other (offline too). Re-reads after every sync (`refreshKey`).
 */
export function ConflictsPanel({ refreshKey }: { refreshKey: number | null }) {
  const [conflicts, setConflicts] = useState<ConflictSummary[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    void call('conflicts:list')
      .then((r) => live && setConflicts(r.conflicts))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [refreshKey, version]);

  if (conflicts.length === 0) return null;
  return (
    <section className="flex flex-col gap-1" data-testid="conflicts" aria-label="Conflicted copies">
      <h2 className="flex h-8 items-center px-2.5 text-label-12 text-gray-900">
        Conflicted copies ({conflicts.length})
      </h2>
      <ul className="flex flex-col gap-0.5">
        {conflicts.map((c) => (
          <li key={c.copyId}>
            <button
              type="button"
              className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-1.5 text-start transition-colors outline-none hover:bg-gray-alpha-100 focus-visible:ring-3 focus-visible:ring-gray-600/50 active:bg-gray-alpha-200"
              onClick={() => setOpenId(c.copyId)}
            >
              <IconCopy aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-900" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-label-14 text-gray-1000">
                  {c.originalTitle ?? c.title}
                </span>
                <span className="truncate text-label-12 text-gray-900">
                  {conflictOrigin(c.device, c.at)}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {openId && (
        <CompareDialog
          copyId={openId}
          onClose={() => setOpenId(null)}
          onResolved={() => {
            setOpenId(null);
            setVersion((v) => v + 1);
          }}
        />
      )}
    </section>
  );
}

function CompareDialog({
  copyId,
  onClose,
  onResolved,
}: {
  copyId: string;
  onClose: () => void;
  onResolved: () => void;
}) {
  const [detail, setDetail] = useState<ConflictDetailSnapshot | null | undefined>(undefined);
  const [pending, setPending] = useState<'copy' | 'original' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void call('conflicts:get', { copyId })
      .then(setDetail)
      .catch(() => setDetail(null));
  }, [copyId]);

  async function keep(which: 'copy' | 'original') {
    setPending(which);
    setError(null);
    try {
      const { resolved } = await call('conflicts:resolve', { copyId, keep: which });
      if (resolved) onResolved();
      else setError('This copy can’t be resolved any more (it may already be resolved).');
    } catch (e) {
      setError(e instanceof BridgeCallError ? e.message : 'Something went wrong.');
    } finally {
      setPending(null);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl" data-testid="conflict-compare">
        <DialogHeader>
          <DialogTitle>Compare versions</DialogTitle>
          <DialogDescription>
            {detail
              ? `${conflictOrigin(detail.summary.device, detail.summary.at)}. Highlighted lines are only in one version.`
              : 'Loading…'}
          </DialogDescription>
        </DialogHeader>
        {detail ? (
          <div className="grid max-h-[55vh] grid-cols-2 gap-4 overflow-auto">
            <Side
              label="Other version"
              lines={detail.original}
              testId="compare-original"
              empty="The note this was copied from is gone."
            />
            <Side label="This copy" lines={detail.copy} testId="compare-copy" />
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
          {error}
        </p>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={!detail || pending !== null}
            onClick={() => void keep('original')}
          >
            {pending === 'original' && <Spinner data-icon="inline-start" />}
            Keep other version
          </Button>
          <Button
            disabled={!detail?.original || pending !== null}
            onClick={() => void keep('copy')}
          >
            {pending === 'copy' && <Spinner data-icon="inline-start" />}
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
  empty,
}: {
  label: string;
  lines: { text: string; changed: boolean }[] | null;
  testId: string;
  empty?: string;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2" data-testid={testId}>
      <h3 className="text-label-12 text-gray-900">{label}</h3>
      <div
        className="rounded-md border border-gray-alpha-400 bg-background-200 p-3 text-copy-14 text-gray-1000"
        data-selectable
      >
        {lines === null ? (
          <p className="text-gray-900">{empty}</p>
        ) : (
          lines.map((line, i) => (
            <p
              key={i}
              className={`min-h-5 whitespace-pre-wrap break-words ${i === 0 ? 'text-heading-14' : ''} ${
                line.changed ? '-mx-1 rounded-sm bg-amber-200 px-1' : ''
              }`}
            >
              {line.text}
            </p>
          ))
        )}
      </div>
    </section>
  );
}
