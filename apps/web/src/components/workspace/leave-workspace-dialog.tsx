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
import { Loader2Icon } from 'lucide-react';
import { useState, useTransition } from 'react';

import { leaveWorkspace } from '@/server/actions/members';

/**
 * "Leave <workspace>?" confirmation. On success the server action redirects to Home (personal workspace
 * active); a refusal (e.g. the only owner) is shown in the dialog.
 */
export function LeaveWorkspaceDialog({
  workspace,
  open,
  onOpenChange,
}: {
  workspace: { id: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent data-testid="leave-workspace-dialog">
        <DialogHeader>
          <DialogTitle>Leave {workspace.name}?</DialogTitle>
          <DialogDescription>
            You’ll lose access to its shared notes. Notes you created stay in the workspace. To come
            back, someone has to invite you again.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await leaveWorkspace(workspace.id);
                if (!result.ok) setError(result.error);
              })
            }
          >
            {pending && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
            Leave workspace
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
