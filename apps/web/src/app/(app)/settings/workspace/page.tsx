import { WORKSPACE_RESTORE_DAYS } from '@oat/auth';
import type { Metadata } from 'next';

import { SettingsHeading } from '@/components/settings/section';
import { WorkspaceDangerZone } from '@/components/workspace/danger-zone';
import { WorkspaceGeneralForm } from '@/components/workspace/general-form';
import { WorkspaceJoinSettings } from '@/components/workspace/join-settings';
import { getWorkspaceSettings } from '@/server/workspace-settings';

export const metadata: Metadata = { title: 'Workspace settings' };

export default async function WorkspaceGeneralPage() {
  const settings = await getWorkspaceSettings();
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

      {settings.joining && (
        <div className="mt-4 border-t border-gray-alpha-300 pt-6">
          <WorkspaceJoinSettings workspaceId={workspace.id} joining={settings.joining} />
        </div>
      )}

      <section
        aria-label="Danger zone"
        data-testid="danger-zone"
        className="mt-4 border-t border-gray-alpha-300 pt-4"
      >
        <WorkspaceDangerZone
          workspace={workspace}
          canLeave={settings.canLeave}
          canDelete={settings.canDelete}
          isOwner={settings.role === 'owner'}
          lastWorkspace={settings.lastWorkspace}
          restoreDays={WORKSPACE_RESTORE_DAYS}
        />
      </section>
    </>
  );
}
