'use client';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Alert, AlertAction, AlertTitle } from '@oat/ui/components/alert';
import { Button } from '@oat/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@oat/ui/components/popover';
import { IconDots, IconRestore, IconTrash } from '@tabler/icons-react';
import { ShareDialog } from './share-dialog';
import { useTreeActions } from './tree-actions';
import { useWorkspaceHost } from './host';
import type { DocumentNode } from './tree';

export function DocumentTrashBanner({ node }: { node: DocumentNode }) {
  const actions = useTreeActions();
  const host = useWorkspaceHost();
  return (
    <Alert role="status" data-testid="trash-banner" className="bg-background-200">
      <IconTrash />
      <AlertTitle>This page is in the trash.</AlertTitle>
      {node.access.delete && (
        <AlertAction className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!host.online}
            onClick={() => void actions.restore(node)}
          >
            <IconRestore data-icon="inline-start" />
            Restore
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={!host.online}
            onClick={() => void actions.deleteForever(node)}
          >
            Delete forever
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
}
export function DocumentRemoveAction({
  node,
  beforeRemove,
  disabled = false,
}: {
  node: DocumentNode;
  beforeRemove?(): Promise<boolean>;
  disabled?: boolean;
}) {
  const actions = useTreeActions();
  const host = useWorkspaceHost();
  const [pending, setPending] = useState(false);
  async function remove() {
    setPending(true);
    try {
      if (beforeRemove && !(await beforeRemove()))
        throw new Error('Your latest edits aren’t saved yet.');
      actions.remove(node);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t move to the trash.');
    } finally {
      setPending(false);
    }
  }
  if (!node.access.delete) return null;
  return (
    <Button
      variant="ghost"
      disabled={disabled || pending || !host.online}
      onClick={() => void remove()}
    >
      <IconTrash data-icon="inline-start" />
      Move to trash
    </Button>
  );
}
export function DocumentActions({
  node,
  children,
  secondaryActions,
  renderSecondaryActions,
  beforeRemove,
  removeDisabled,
}: {
  node: DocumentNode;
  children?: ReactNode;
  secondaryActions?: ReactNode;
  renderSecondaryActions?(lifecycle: ReactNode): ReactNode;
  beforeRemove?(): Promise<boolean>;
  removeDisabled?: boolean;
}) {
  const lifecycle = node.access.delete ? (
    <DocumentRemoveAction node={node} beforeRemove={beforeRemove} disabled={removeDisabled} />
  ) : null;
  return (
    <div
      className="flex min-w-0 items-center gap-2 text-label-12 text-gray-900"
      data-testid="document-actions"
    >
      {children}
      {renderSecondaryActions
        ? renderSecondaryActions(lifecycle)
        : (secondaryActions ?? (lifecycle && <MoreActions>{lifecycle}</MoreActions>))}
      <ShareDialog documentId={node.id} />
    </div>
  );
}
export function MoreActions({ children }: { children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="More actions"
            data-testid="document-more"
          />
        }
      >
        <IconDots />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto items-stretch">
        {children}
      </PopoverContent>
    </Popover>
  );
}
