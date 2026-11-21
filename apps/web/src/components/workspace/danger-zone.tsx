'use client';

import { Alert, AlertDescription } from '@oat/ui/components/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@oat/ui/components/alert-dialog';
import { Button } from '@oat/ui/components/button';
import { Field, FieldLabel } from '@oat/ui/components/field';
import { Input } from '@oat/ui/components/input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@oat/ui/components/item';
import { Spinner } from '@oat/ui/components/spinner';
import { IconAlertCircle } from '@tabler/icons-react';
import { useState, useTransition } from 'react';

import { deleteWorkspace } from '@/server/actions/members';

import { LeaveWorkspaceDialog } from './leave-workspace-dialog';

function Row({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Item className="flex-col items-stretch rounded-none border-0 px-0 py-3 sm:flex-row sm:items-center">
      <ItemContent>
        <ItemTitle>{title}</ItemTitle>
        <ItemDescription>{description}</ItemDescription>
      </ItemContent>
      <ItemActions>{children}</ItemActions>
    </Item>
  );
}

function DeleteWorkspaceDialog({
  workspace,
  restoreDays,
  open,
  onOpenChange,
}: {
  workspace: { id: string; name: string };
  restoreDays: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const matches = confirm.trim() === workspace.name.trim();

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setError(null);
          setConfirm('');
        }
        onOpenChange(next);
      }}
    >
      <AlertDialogContent data-testid="delete-workspace-dialog">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            if (!matches) return;
            startTransition(async () => {
              const result = await deleteWorkspace({
                workspaceId: workspace.id,
                confirmName: confirm,
              });
              if (!result.ok) setError(result.error);
            });
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {workspace.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It disappears for every member right away, with all of its notes. It can be restored
              for {restoreDays} days.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Field>
            <FieldLabel htmlFor="delete-confirm" className="block">
              Type <span className="text-label-14-mono">{workspace.name}</span> to confirm
            </FieldLabel>
            <Input
              id="delete-confirm"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              autoComplete="off"
              autoFocus
              spellCheck={false}
              disabled={pending}
            />
          </Field>
          {error && (
            <Alert variant="destructive">
              <IconAlertCircle />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
            <Button type="submit" variant="destructive" disabled={!matches || pending}>
              {pending && <Spinner data-icon="inline-start" />}
              Delete workspace
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Leave (anyone but the last owner) and delete (owners) for a team workspace. */
export function WorkspaceDangerZone({
  workspace,
  canLeave,
  canDelete,
  restoreDays,
}: {
  workspace: { id: string; name: string };
  canLeave: boolean;
  canDelete: boolean;
  restoreDays: number;
}) {
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <>
      <ItemGroup role="group" className="gap-0">
        <Row
          title="Leave workspace"
          description={
            canLeave
              ? 'You’ll lose access to its shared notes.'
              : 'You’re the only owner. Make someone else an owner before you leave.'
          }
        >
          <Button
            variant="ghost"
            className="text-red-900 hover:bg-red-100 hover:text-red-1000"
            disabled={!canLeave}
            onClick={() => setLeaveOpen(true)}
          >
            Leave workspace
          </Button>
        </Row>
        {canDelete && (
          <Row
            title="Delete workspace"
            description={`Removes it for everyone. Restorable for ${restoreDays} days.`}
          >
            <Button
              variant="ghost"
              className="text-red-900 hover:bg-red-100 hover:text-red-1000"
              onClick={() => setDeleteOpen(true)}
            >
              Delete workspace
            </Button>
          </Row>
        )}
      </ItemGroup>
      <LeaveWorkspaceDialog workspace={workspace} open={leaveOpen} onOpenChange={setLeaveOpen} />
      {canDelete && (
        <DeleteWorkspaceDialog
          workspace={workspace}
          restoreDays={restoreDays}
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
        />
      )}
    </>
  );
}
