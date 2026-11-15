'use client';

import { Button } from '@oat/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@oat/ui/components/dialog';
import { FileTextIcon, NotebookPenIcon, RotateCcwIcon, Trash2Icon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { EmptyState } from '@/components/page';
import { formatDay } from '@/lib/format';
import { type DocumentNode, titleOf } from '@/lib/tree';

import { useShellData } from './shell-data';
import { useTreeActions } from './tree-actions';

/**
 * The trash of the active workspace: documents the user may still read (their own, plus non-private
 * ones for owners/admins), newest first. Restore puts a page back in its folder (or the root if the
 * folder was deleted); "Delete forever" asks once more inline.
 */
export function TrashDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { trash } = useShellData();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="trash-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Trash</DialogTitle>
          <DialogDescription>Restore pages you deleted, or delete them for good.</DialogDescription>
        </DialogHeader>
        {trash.length === 0 ? (
          <EmptyState
            icon={Trash2Icon}
            title="The trash is empty"
            description="Pages you delete land here until you restore them or delete them forever."
            className="py-8"
          />
        ) : (
          <ul className="-mx-2 flex max-h-96 flex-col overflow-y-auto">
            {trash.map((node) => (
              <TrashRow key={node.id} node={node} onNavigate={() => onOpenChange(false)} />
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

function TrashRow({ node, onNavigate }: { node: DocumentNode; onNavigate: () => void }) {
  const { restore, deleteForever } = useTreeActions();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const Icon = node.kind === 'meeting' ? NotebookPenIcon : FileTextIcon;
  const run = async (action: () => Promise<void>) => {
    setPending(true);
    try {
      await action();
    } finally {
      setPending(false);
      setConfirming(false);
    }
  };

  return (
    <li
      className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-accent"
      data-testid="trash-item"
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <Link
        href={`/d/${node.id}`}
        onClick={onNavigate}
        className="min-w-0 flex-1 truncate text-sm focus-visible:underline focus-visible:outline-none"
      >
        {titleOf(node)}
      </Link>
      {node.deletedAt && (
        <span className="shrink-0 text-xs text-muted-foreground">{formatDay(node.deletedAt)}</span>
      )}
      {node.access.delete && (
        <>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => void run(() => restore(node))}
          >
            <RotateCcwIcon data-icon="inline-start" />
            Restore
          </Button>
          <Button
            size="sm"
            variant={confirming ? 'destructive' : 'ghost'}
            disabled={pending}
            aria-label={confirming ? undefined : `Delete ${titleOf(node)} forever`}
            onClick={() => (confirming ? void run(() => deleteForever(node)) : setConfirming(true))}
            onBlur={() => setConfirming(false)}
          >
            {confirming ? 'Delete forever' : <Trash2Icon />}
          </Button>
        </>
      )}
    </li>
  );
}
