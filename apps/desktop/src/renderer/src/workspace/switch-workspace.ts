import { OatApiError } from '@oat/client';
import { api } from '../lib/api';

export async function switchDesktopWorkspace(
  workspaceId: string,
  online: boolean,
  setActive: (workspaceId: string) => Promise<void>,
  switchActive: (workspaceId: string) => Promise<unknown> = api.workspaces.switchActive,
) {
  if (online) {
    try {
      await switchActive(workspaceId);
      return;
    } catch (error) {
      if (!(error instanceof OatApiError) || error.status !== 0) throw error;
    }
  }
  await setActive(workspaceId);
}
