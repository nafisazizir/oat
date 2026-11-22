'use client';

import { OatApiError } from '@oat/client';
import { LeaveWorkspaceDialog as SharedDialog } from '@oat/settings-ui';
import { useWorkspaceHost } from './host';

const EXPORT_FAILED = 'Couldn’t export your notes. Nothing was downloaded — try again.';

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
  async function download() {
    if (host.exportNotes) return host.exportNotes(workspace.id);
    if (host.platform === 'desktop') throw new Error(EXPORT_FAILED);
    try {
      const response = await host.client.workspaces.export(workspace.id);
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(
          response.status === 429 && body?.error?.message ? body.error.message : EXPORT_FAILED,
        );
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
      return Number(response.headers.get('x-oat-export-count'));
    } catch (error) {
      if (error instanceof OatApiError)
        throw new Error(error.status === 429 ? error.message : EXPORT_FAILED, { cause: error });
      throw error;
    }
  }
  return (
    <SharedDialog
      workspace={workspace}
      open={open}
      onOpenChange={onOpenChange}
      blockedReason={host.workspaceExitBlockedReason}
      download={download}
      onLeave={async () => {
        try {
          await host.client.workspaces.leave(workspace.id);
          onOpenChange(false);
          host.navigate({ view: 'home' });
          host.refresh();
          return { ok: true };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : 'Couldn’t leave the workspace.',
          };
        }
      }}
    />
  );
}
