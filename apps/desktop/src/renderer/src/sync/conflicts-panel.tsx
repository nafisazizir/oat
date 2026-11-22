import type { ConflictDetailSnapshot, ConflictSummary } from '@oat/core/bridge';
import { ConflictCompareDialog, ConflictNotice } from '@oat/workspace-ui/conflicts';
import { Button } from '@oat/ui/components/button';
import { IconCopy } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { BridgeCallError, call } from '../bridge.ts';
import { conflictOrigin } from './search-text.ts';

export function ConflictsPanel({ refreshKey }: { refreshKey: number | null }) {
  const [result, setResult] = useState<{
    key: string;
    conflicts: ConflictSummary[];
    error?: string;
  } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const key = `${refreshKey}:${version}`;
  useEffect(() => {
    let live = true;
    void call('conflicts:list').then(
      (r) => {
        if (live) setResult({ key, conflicts: r.conflicts });
      },
      () => {
        if (live)
          setResult((previous) => ({
            key,
            conflicts: previous?.conflicts ?? [],
            error: 'Couldn’t load conflicted copies.',
          }));
      },
    );
    return () => {
      live = false;
    };
  }, [key]);
  const loading = result?.key !== key;
  const conflicts = result?.conflicts ?? [];
  if (!loading && !result?.error && conflicts.length === 0) return null;
  return (
    <section className="flex flex-col gap-1" data-testid="conflicts" aria-label="Conflicted copies">
      <h2 className="flex h-8 items-center px-2.5 text-label-12 text-gray-900">
        Conflicted copies ({conflicts.length})
      </h2>
      {loading && (
        <p role="status" className="px-2.5 text-copy-14 text-gray-900">
          Loading conflicted copies…
        </p>
      )}
      {!loading && result?.error && (
        <div role="alert" className="px-2.5 text-copy-14 text-red-900">
          <p>{result.error}</p>
          <Button size="sm" variant="outline" onClick={() => setVersion((v) => v + 1)}>
            Try again
          </Button>
        </div>
      )}
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
          key={openId}
          copyId={openId}
          onClose={() => setOpenId(null)}
          onResolved={() => {
            setOpenId((current) => (current === openId ? null : current));
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
  onClose(): void;
  onResolved(): void;
}) {
  const [revision, setRevision] = useState(0);
  const key = `${copyId}:${revision}`;
  const [result, setResult] = useState<{
    key: string;
    data?: ConflictDetailSnapshot;
    error?: string;
  } | null>(null);
  const [pending, setPending] = useState<'copy' | 'original' | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void call('conflicts:get', { copyId }).then(
      (data) => {
        if (live)
          setResult(
            data
              ? { key, data }
              : { key, error: 'This copy is unavailable. It may already be resolved.' },
          );
      },
      () => {
        if (live) setResult({ key, error: 'Couldn’t load this conflicted copy.' });
      },
    );
    return () => {
      live = false;
    };
  }, [copyId, key]);
  const current = result?.key === key ? result : null;
  const detail = current?.data;
  async function keep(which: 'copy' | 'original') {
    if (!detail) return;
    setPending(which);
    setError(null);
    try {
      const { resolved } = await call('conflicts:resolve', {
        copyId,
        keep: which,
        revision: detail.revision,
      });
      if (resolved) onResolved();
      else setError('This copy changed or was resolved. Compare again before choosing a version.');
    } catch (e) {
      setError(e instanceof BridgeCallError ? e.message : 'Something went wrong.');
    } finally {
      setPending(null);
    }
  }
  return (
    <ConflictCompareDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      data={
        detail
          ? {
              original: detail.original,
              copy: detail.copy,
              canKeepCopy: detail.original !== null,
              canKeepOriginal: true,
            }
          : undefined
      }
      notice={
        detail && (
          <ConflictNotice title={conflictOrigin(detail.summary.device, detail.summary.at)}>
            {detail.original
              ? 'Both versions were kept. Choose which version to keep.'
              : 'The other version is gone. Keeping the other version will discard this copy.'}
          </ConflictNotice>
        )
      }
      loadError={current?.error}
      onRetry={() => {
        setError(null);
        setRevision((v) => v + 1);
      }}
      error={error}
      pending={pending}
      onKeep={(which) => void keep(which)}
    />
  );
}
