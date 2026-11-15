import { WORKSPACE_RESTORE_DAYS } from '@oat/auth';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@oat/ui/components/card';
import type { Metadata } from 'next';

import { WorkspaceDangerZone } from '@/components/workspace/danger-zone';
import { WorkspaceGeneralForm } from '@/components/workspace/general-form';
import { getWorkspaceSettings } from '@/server/workspace-settings';

export const metadata: Metadata = { title: 'Workspace settings' };

export default async function WorkspaceGeneralPage() {
  const settings = await getWorkspaceSettings();
  // The layout shows the personal-workspace note instead of this page.
  if (settings.workspace.kind === 'personal') return null;
  const { workspace } = settings;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>General</h2>
          </CardTitle>
          <CardDescription>How the workspace appears to its members.</CardDescription>
        </CardHeader>
        <CardContent>
          {/* `key`: a rename elsewhere (or a switch) resets the form to the saved values. */}
          <WorkspaceGeneralForm
            key={`${workspace.id}:${workspace.name}:${workspace.icon ?? ''}`}
            workspace={workspace}
            canEdit={settings.canManage}
          />
        </CardContent>
      </Card>

      <Card className="ring-destructive/30" data-testid="danger-zone">
        <CardHeader>
          <CardTitle>
            <h2>Danger zone</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <WorkspaceDangerZone
            workspace={workspace}
            canLeave={settings.canLeave}
            canDelete={settings.canDelete}
            restoreDays={WORKSPACE_RESTORE_DAYS}
          />
        </CardContent>
      </Card>
    </>
  );
}
