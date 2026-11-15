'use client';

import { Button } from '@oat/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@oat/ui/components/dialog';
import { Input } from '@oat/ui/components/input';
import { Label } from '@oat/ui/components/label';
import { Loader2Icon } from 'lucide-react';
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
    <div className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col gap-0.5">
        <div className="font-medium">{title}</div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
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
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setError(null);
          setConfirm('');
        }
        onOpenChange(next);
      }}
    >
      <DialogContent data-testid="delete-workspace-dialog">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            startTransition(async () => {
              const result = await deleteWorkspace({
                workspaceId: workspace.id,
                confirmName: confirm,
              });
              if (!result.ok) setError(result.error);
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>Delete {workspace.name}?</DialogTitle>
            <DialogDescription>
              It disappears for every member right away, with all of its notes. It can be restored
              for {restoreDays} days.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="delete-confirm">
              Type <span className="font-semibold">{workspace.name}</span> to confirm
            </Label>
            <Input
              id="delete-confirm"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              autoComplete="off"
              disabled={pending}
              aria-invalid={error ? true : undefined}
            />
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={!matches || pending}>
              {pending && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
              Delete workspace
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
    <div className="flex flex-col divide-y">
      <Row
        title="Leave workspace"
        description={
          canLeave
            ? 'You’ll lose access to its shared notes.'
            : 'You’re the only owner. Make someone else an owner before you leave.'
        }
      >
        <Button
          variant="outline"
          disabled={!canLeave}
          onClick={() => setLeaveOpen(true)}
          className="shrink-0"
        >
          Leave workspace
        </Button>
      </Row>
      {canDelete && (
        <Row
          title="Delete workspace"
          description={`Removes it for everyone. Restorable for ${restoreDays} days.`}
        >
          <Button variant="destructive" onClick={() => setDeleteOpen(true)} className="shrink-0">
            Delete workspace
          </Button>
        </Row>
      )}
      <LeaveWorkspaceDialog workspace={workspace} open={leaveOpen} onOpenChange={setLeaveOpen} />
      <DeleteWorkspaceDialog
        workspace={workspace}
        restoreDays={restoreDays}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />
    </div>
  );
}
