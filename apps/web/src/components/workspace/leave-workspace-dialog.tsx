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
import { IconAlertCircle, IconDownload } from '@tabler/icons-react';
import { useState, useTransition } from 'react';

import { leaveWorkspace } from '@/server/actions/members';

/**
 * "Leave <workspace>?" confirmation (D-36). It says what leaving costs — access to everything in the
 * workspace, the leaver's private notes included; they stay behind, unreadable to anyone else — and offers
 * "Export my notes" first: a zip of Markdown of the notes they created there (`/api/workspaces/:id/export`,
 * which decides on the server what is theirs). On success the server action redirects to Home (another of
 * the user's workspaces active); a refusal (the only owner, or their only workspace) is shown in the dialog.
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
  const [exported, setExported] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setError(null);
          setExported(false);
        }
        onOpenChange(next);
      }}
    >
      <AlertDialogContent data-testid="leave-workspace-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Leave {workspace.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            You’ll lose access to everything in {workspace.name}, including your private notes. They
            stay behind in the workspace, where nobody else can read them, and you won’t be able to
            open them again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col items-start gap-2" data-testid="leave-export">
          <p className="text-copy-14 text-gray-900">
            To keep a copy, export the notes you created here first. You get a zip of Markdown
            files.
          </p>
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            role="link"
            render={
              // A plain download: the server decides what is mine and streams the archive.
              <a
                href={`/api/workspaces/${encodeURIComponent(workspace.id)}/export`}
                download
                data-testid="export-notes"
              />
            }
            onClick={() => setExported(true)}
          >
            <IconDownload data-icon="inline-start" />
            Export my notes
          </Button>
          <p role="status" className="text-copy-13 text-gray-900 empty:hidden">
            {exported ? 'Your download has started. Check it before you leave.' : null}
          </p>
        </div>
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
