'use client';

import { Button } from '@oat/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@oat/ui/components/dialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@oat/ui/components/empty';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@oat/ui/components/item';
import { IconArrowBackUp, IconFileText, IconNotes, IconTrash } from '@tabler/icons-react';
import Link from 'next/link';
import { useState } from 'react';

import { formatDay } from '@/lib/format';
import { type DocumentNode, titleOf } from '@/lib/tree';

import { useShellData } from './shell-data';
import { useTreeActions } from './tree-actions';

/**
 * The trash of the active workspace: documents the user may still read (their own, plus non-private
 * ones for owners/admins), newest first. Restore puts a page back in its folder (or the root if the
 * folder was deleted); "Delete forever" asks once more inline. Both take effect immediately.
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
          <Empty className="p-8">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <IconTrash />
              </EmptyMedia>
              <EmptyTitle className="text-heading-16">The trash is empty</EmptyTitle>
              <EmptyDescription>
                Pages you delete stay here until you restore them.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup className="-mx-2 max-h-96 gap-0.5 overflow-y-auto">
            {trash.map((node) => (
              <TrashRow key={node.id} node={node} onNavigate={() => onOpenChange(false)} />
            ))}
          </ItemGroup>
        )}
      </DialogContent>
    </Dialog>
  );
}

function TrashRow({ node, onNavigate }: { node: DocumentNode; onNavigate: () => void }) {
  const { restore, deleteForever } = useTreeActions();
  const [confirming, setConfirming] = useState(false);
  const Icon = node.kind === 'meeting' ? IconNotes : IconFileText;
  const title = titleOf(node);

  return (
    <Item size="xs" className="hover:bg-gray-alpha-100" data-testid="trash-item">
      <ItemMedia variant="icon" className="text-gray-900">
        <Icon />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="w-full">
          <Link
            href={`/d/${node.id}`}
            onClick={onNavigate}
            className="truncate rounded-sm focus-visible:underline focus-visible:outline-none"
          >
            {title}
          </Link>
        </ItemTitle>
        {node.deletedAt && <ItemDescription>Deleted {formatDay(node.deletedAt)}</ItemDescription>}
      </ItemContent>
      {node.access.delete && (
        <ItemActions className="gap-1">
          <Button size="sm" variant="ghost" onClick={() => void restore(node)}>
            <IconArrowBackUp data-icon="inline-start" />
            Restore
          </Button>
          <Button
            size={confirming ? 'sm' : 'icon-sm'}
            variant={confirming ? 'destructive' : 'ghost'}
            aria-label={confirming ? undefined : `Delete ${title} forever`}
            onClick={() => (confirming ? void deleteForever(node) : setConfirming(true))}
            onBlur={() => setConfirming(false)}
          >
            {confirming ? 'Delete forever' : <IconTrash />}
          </Button>
        </ItemActions>
      )}
    </Item>
  );
}
