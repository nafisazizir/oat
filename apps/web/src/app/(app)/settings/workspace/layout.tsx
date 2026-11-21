import { SettingsHeading } from '@/components/settings/section';
import { CreateTeamButton } from '@/components/workspace/create-team-button';
import { getWorkspaceSettings } from '@/server/workspace-settings';

export default async function WorkspaceSettingsLayout({ children }: { children: React.ReactNode }) {
  const { workspace } = await getWorkspaceSettings();
  if (workspace.kind !== 'personal') return children;
  return (
    <>
      <SettingsHeading>Personal workspace</SettingsHeading>
      <div
        className="flex items-center justify-between gap-6"
        data-testid="personal-workspace-note"
      >
        <div className="flex flex-col gap-1">
          <h2 className="text-label-14 text-gray-1000">Just for you</h2>
          <p className="text-copy-14 text-gray-900">
            Your personal workspace can’t be shared, left or deleted.
          </p>
        </div>
        <CreateTeamButton />
      </div>
    </>
  );
}
