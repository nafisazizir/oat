import { WORKSPACE_RESTORE_DAYS } from '@oat/auth';
import type { Metadata } from 'next';

import { SettingsHeading } from '@/components/settings/section';
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
      <SettingsHeading>General</SettingsHeading>
      {/* `key`: a rename elsewhere (or a switch) resets the form to the saved values. */}
      <WorkspaceGeneralForm
        key={`${workspace.id}:${workspace.name}:${workspace.icon ?? ''}`}
        workspace={workspace}
        canEdit={settings.canManage}
      />

      <section
        aria-label="Danger zone"
        data-testid="danger-zone"
        className="mt-4 border-t border-gray-alpha-300 pt-4"
      >
        <WorkspaceDangerZone
          workspace={workspace}
          canLeave={settings.canLeave}
          canDelete={settings.canDelete}
          restoreDays={WORKSPACE_RESTORE_DAYS}
        />
      </section>
    </>
  );
}
