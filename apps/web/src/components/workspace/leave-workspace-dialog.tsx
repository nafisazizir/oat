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
import { Spinner } from '@oat/ui/components/spinner';
import { IconAlertCircle } from '@tabler/icons-react';
import { useState, useTransition } from 'react';

import { leaveWorkspace } from '@/server/actions/members';

/**
 * "Leave <workspace>?" confirmation. On success the server action redirects to Home (another of the user's
 * workspaces active); a refusal (the only owner, or their only workspace) is shown in the dialog.
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
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <AlertDialogContent data-testid="leave-workspace-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Leave {workspace.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            You’ll lose access to its shared notes. Notes you created stay in the workspace. To come
            back, someone has to invite you again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <Alert variant="destructive">
            <IconAlertCircle />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
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
            {pending && <Spinner data-icon="inline-start" />}
            Leave workspace
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
