import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@oat/ui/components/empty';
import { IconLock } from '@tabler/icons-react';

import { BackLink, PageContainer, PageHeader } from '@/components/page';
import { CreateTeamButton } from '@/components/workspace/create-team-button';
import { WorkspaceSettingsNav } from '@/components/workspace/settings-nav';
import { WorkspaceAvatar } from '@/components/workspace/workspace-avatar';
import { ROLE_INFO } from '@/lib/workspace';
import { getWorkspaceSettings } from '@/server/workspace-settings';

/**
 * `/settings/workspace/*` (5.1): settings of the active workspace. Team workspaces get General and
 * Members tabs; a personal workspace only explains what it is (it has one member and can't be shared).
 */
export default async function WorkspaceSettingsLayout({ children }: { children: React.ReactNode }) {
  const settings = await getWorkspaceSettings();
  const { workspace, members, role } = settings;
  const personal = workspace.kind === 'personal';

  return (
    <PageContainer className="gap-8">
      <div className="flex flex-col gap-6">
        <BackLink href="/settings">Settings</BackLink>
        <div className="flex items-center gap-4">
          <WorkspaceAvatar workspace={workspace} size="lg" className="size-12" />
          <PageHeader
            title={workspace.name}
            description={
              personal
                ? 'Personal workspace'
                : `${members.length === 1 ? '1 member' : `${members.length} members`} · you’re ${ROLE_INFO[role].label.toLowerCase()}`
            }
          />
        </div>
        {!personal && <WorkspaceSettingsNav />}
      </div>

      {personal ? (
        <Empty className="border border-gray-alpha-400" data-testid="personal-workspace-note">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <IconLock />
            </EmptyMedia>
            <EmptyTitle role="heading" aria-level={2}>
              Just for you
            </EmptyTitle>
            <EmptyDescription>
              Your personal workspace can’t be shared, left or deleted. To work with others, create
              a team workspace and invite them there.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <CreateTeamButton />
          </EmptyContent>
        </Empty>
      ) : (
        children
      )}
    </PageContainer>
  );
}
