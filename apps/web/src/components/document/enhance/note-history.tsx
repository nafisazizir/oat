'use client';

import type { JSONContent } from '@oat/editor';
import { OatEditor } from '@oat/editor/react';
import { cn } from '@oat/ui';
import { Badge } from '@oat/ui/components/badge';
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
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@oat/ui/components/item';
import { Spinner } from '@oat/ui/components/spinner';
import { IconAlertCircle, IconNotes, IconPencil, IconSparkles } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import type { EnhancementDetail } from '@/lib/enhance';

import { enhanceClient } from './client';
import type { NoteVersions } from './use-note-versions';

/**
 * What the history dialog shows: one enhancement's output, a saved edited note, or my notes from before the
 * newest enhancement.
 */
export type HistorySelection =
  { kind: 'version'; id: string } | { kind: 'snapshot'; id: string } | { kind: 'original' };

const REASON = {
  regenerate: 'Saved before regenerating',
  restore: 'Saved before restoring',
} as const;

const when = (iso: string) =>
  new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));

/**
 * "Note history" (4.5, editors only): every enhancement and every saved edited note, newest first, plus the
 * notes I wrote before the newest enhancement. Selecting an entry shows it read-only; "Restore" makes it the
 * note again (`onRestore` — the caller confirms first when the current note isn't stored here yet, and the
 * server saves it before replacing). Nothing is ever deleted.
 */
export function NoteHistoryDialog({
  open,
  onOpenChange,
  versions,
  selection,
  onSelect,
  onRestore,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  versions: NoteVersions;
  selection: HistorySelection;
  onSelect: (selection: HistorySelection) => void;
  /** Make the selected entry the note body. */
  onRestore: (selection: HistorySelection) => void;
}) {
  const runs = versions.list?.versions ?? [];
  const snapshots = versions.list?.snapshots ?? [];
  const latest = runs[0];
  // Versions and saved notes interleaved, newest first.
  const entries = [
    ...runs.map((run) => ({ kind: 'version' as const, at: run.completedAt ?? run.startedAt, run })),
    ...snapshots.map((snapshot) => ({
      kind: 'snapshot' as const,
      at: snapshot.createdAt,
      snapshot,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  // The original notes are those of the newest run.
  const detailId = selection.kind === 'original' ? latest?.id : selection.id;
  // The loaded entry, keyed by run id (a stale answer for another entry is ignored).
  const [loaded, setLoaded] = useState<{
    id: string;
    detail: EnhancementDetail | null;
    failed: boolean;
  } | null>(null);

  useEffect(() => {
    if (!open || !detailId) return;
    let cancelled = false;
    enhanceClient.version(detailId).then(
      (detail) => !cancelled && setLoaded({ id: detailId, detail, failed: false }),
      () => !cancelled && setLoaded({ id: detailId, detail: null, failed: true }),
    );
    return () => {
      cancelled = true;
    };
  }, [open, detailId]);

  const current = loaded && loaded.id === detailId ? loaded : null;
  const failed = current?.failed ?? false;
  const detail = current?.detail ?? null;
  const shown: JSONContent | null = detail
    ? selection.kind === 'original'
      ? detail.kind === 'version'
        ? detail.notes
        : null
      : detail.doc
    : null;
  const selected =
    selection.kind === 'version'
      ? runs.find((r) => r.id === selection.id)
      : selection.kind === 'snapshot'
        ? snapshots.find((x) => x.id === selection.id)
        : null;
  const isCurrent = selection.kind !== 'original' && Boolean(selected?.current);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(44rem,calc(100dvh-4rem))] flex-col sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Note history</DialogTitle>
          <DialogDescription>
            Every enhanced version of this note, your edited notes, and what you wrote before.
            Restoring replaces the current note and keeps it here; nothing is ever deleted.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 gap-4 sm:grid-cols-[15rem_1fr]">
          <nav aria-label="Versions" className="flex min-h-0 flex-col">
            <ul
              className="-mx-1 flex max-h-48 flex-col gap-0.5 overflow-y-auto px-1 sm:max-h-none"
              data-testid="history-list"
            >
              {entries.map((entry) =>
                entry.kind === 'snapshot' ? (
                  <li key={entry.snapshot.id}>
                    <HistoryItem
                      active={selection.kind === 'snapshot' && selection.id === entry.snapshot.id}
                      onClick={() => onSelect({ kind: 'snapshot', id: entry.snapshot.id })}
                      icon={IconPencil}
                      title="Your edited note"
                      meta={`${REASON[entry.snapshot.reason]} · ${when(entry.at)}`}
                      badge={
                        entry.snapshot.current ? <Badge variant="secondary">Current</Badge> : null
                      }
                      testId="history-snapshot"
                    />
                  </li>
                ) : (
                  <li key={entry.run.id}>
                    <HistoryItem
                      active={selection.kind === 'version' && selection.id === entry.run.id}
                      onClick={() => onSelect({ kind: 'version', id: entry.run.id })}
                      icon={IconSparkles}
                      title={`Version ${entry.run.number}`}
                      meta={`${entry.run.templateName ?? 'Template removed'} · ${when(entry.at)}`}
                      badge={
                        entry.run.current ? (
                          <Badge variant="secondary">Current</Badge>
                        ) : entry.run.applied === false ? (
                          <Badge variant="outline">Not applied</Badge>
                        ) : null
                      }
                      testId="history-version"
                    />
                  </li>
                ),
              )}
              {latest && (
                <li className="mt-1 border-t border-gray-alpha-400 pt-1">
                  <HistoryItem
                    active={selection.kind === 'original'}
                    onClick={() => onSelect({ kind: 'original' })}
                    icon={IconNotes}
                    title="My original notes"
                    meta={`Before version ${latest.number}`}
                    testId="history-original"
                  />
                </li>
              )}
            </ul>
          </nav>

          <section
            aria-label="Preview"
            aria-busy={!shown && !failed}
            data-testid="history-preview"
            className="min-h-48 overflow-y-auto rounded-lg border border-gray-alpha-400 bg-background-100 px-5 py-4 sm:min-h-80"
          >
            {failed ? (
              <p role="alert" className="flex items-center gap-2 text-copy-14 text-gray-900">
                <IconAlertCircle className="size-4 text-red-900" />
                Couldn’t load this version.
              </p>
            ) : !entries.length ? (
              <p className="text-copy-14 text-gray-900">
                No enhanced versions yet. Enhance the note to start its history.
              </p>
            ) : shown ? (
              // `key`: a fresh read-only editor per entry (no stale selection or scroll).
              <OatEditor
                key={`${detailId}:${selection.kind}`}
                value={shown}
                editable={false}
                aria-label="Version preview"
              />
            ) : (
              <div className="flex flex-col gap-3" aria-hidden>
                <Skeleton className="h-6 w-40" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            )}
          </section>
        </div>

        <DialogFooter className="items-center">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {entries.length > 0 && (
            <Button
              data-testid="history-restore"
              disabled={
                versions.restoring ||
                versions.checking ||
                isCurrent ||
                (selection.kind === 'original' ? !latest : !selected)
              }
              onClick={() => onRestore(selection)}
            >
              {(versions.restoring || versions.checking) && <Spinner data-icon="inline-start" />}
              {isCurrent
                ? 'This is the current note'
                : selection.kind === 'original'
                  ? 'Restore my notes'
                  : selection.kind === 'snapshot'
                    ? 'Restore this note'
                    : 'Restore this version'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function HistoryItem({
  active,
  onClick,
  icon: Icon,
  title,
  meta,
  badge,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  meta: string;
  badge?: React.ReactNode;
  testId: string;
}) {
  return (
    <Item
      size="xs"
      render={<button type="button" />}
      aria-current={active || undefined}
      data-testid={testId}
      onClick={onClick}
      className={cn(
        'flex-nowrap text-start hover:bg-gray-alpha-100 active:bg-gray-alpha-200',
        active && 'bg-gray-alpha-200 hover:bg-gray-alpha-200',
      )}
    >
      <ItemMedia variant="icon">
        <Icon className={active ? 'text-gray-1000' : 'text-gray-900'} />
      </ItemMedia>
      <ItemContent className="min-w-0 gap-0.5">
        <ItemTitle>
          {title}
          {badge}
        </ItemTitle>
        <ItemDescription className="truncate text-label-12">{meta}</ItemDescription>
      </ItemContent>
    </Item>
  );
}
