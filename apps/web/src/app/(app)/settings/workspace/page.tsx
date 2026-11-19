import { WORKSPACE_RESTORE_DAYS } from '@oat/auth';
import type { Metadata } from 'next';

import { SettingsSection } from '@/components/settings/section';
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
      {/* `key`: a rename elsewhere (or a switch) resets the form to the saved values. */}
      <WorkspaceGeneralForm
        key={`${workspace.id}:${workspace.name}:${workspace.icon ?? ''}`}
        workspace={workspace}
        canEdit={settings.canManage}
      />

      <SettingsSection title="Danger zone" data-testid="danger-zone">
        <WorkspaceDangerZone
          workspace={workspace}
          canLeave={settings.canLeave}
          canDelete={settings.canDelete}
          restoreDays={WORKSPACE_RESTORE_DAYS}
        />
      </SettingsSection>
    </>
  );
}
