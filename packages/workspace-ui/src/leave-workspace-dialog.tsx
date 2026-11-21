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
import { OatApiError } from '@oat/client';
import { useState, useTransition } from 'react';

import { useWorkspaceHost } from './host';

type Exporting = { state: 'idle' | 'working' } | { state: 'done' | 'failed'; message: string };

const EXPORT_FAILED = 'Couldn’t export your notes. Nothing was downloaded — try again.';

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
  const host = useWorkspaceHost();
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<Exporting>({ state: 'idle' });
  const [pending, startTransition] = useTransition();

  // The server decides what is mine (`/api/workspaces/:id/export`). Fetched rather than linked, so the
  // dialog can tell a saved file from a refusal (signed out, too many exports, a server error).
  async function exportNotes() {
    setExporting({ state: 'working' });
    try {
      const response = await host.client.workspaces.export(workspace.id);
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setExporting({
          state: 'failed',
          message:
            response.status === 429 && body?.error?.message ? body.error.message : EXPORT_FAILED,
        });
        return;
      }
      const blob = await response.blob();
      const name =
        /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ??
        'oat-notes.zip';
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
      const count = Number(response.headers.get('x-oat-export-count'));
      setExporting({
        state: 'done',
        message:
          count === 0
            ? 'You have no notes of your own here, so the file is empty.'
            : `Saved ${count === 1 ? '1 note' : `${count} notes`} to your downloads. Check the file before you leave.`,
      });
    } catch (error) {
      setExporting({
        state: 'failed',
        message:
          error instanceof OatApiError && error.status === 429 ? error.message : EXPORT_FAILED,
      });
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setError(null);
          setExporting({ state: 'idle' });
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
        <div className="flex flex-col items-start gap-3" data-testid="leave-export">
          <p className="text-copy-14 text-gray-900">
            To keep a copy, export the notes you created here first. You get a zip of Markdown
            files.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={exporting.state === 'working'}
            onClick={() => void exportNotes()}
            data-testid="export-notes"
          >
            {exporting.state === 'working' ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <IconDownload data-icon="inline-start" />
            )}
            Export my notes
          </Button>
          {/* Says what happened, only once it is known: saved, or why not. */}
          <p role="status" className="text-copy-13 text-gray-900 empty:hidden">
            {exporting.state === 'done' ? exporting.message : null}
          </p>
          {exporting.state === 'failed' && (
            <p role="alert" className="text-copy-13 text-red-900" data-testid="export-error">
              {exporting.message}
            </p>
          )}
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
                try {
                  await host.client.workspaces.leave(workspace.id);
                  onOpenChange(false);
                  host.navigate({ view: 'home' });
                  host.refresh();
                } catch (error) {
                  setError(
                    error instanceof Error ? error.message : 'Couldn’t leave the workspace.',
                  );
                }
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
