import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@oat/ui/components/card';
import { ChevronLeftIcon, LockIcon } from 'lucide-react';
import Link from 'next/link';

import { PageContainer, PageHeader } from '@/components/page';
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
        <Link
          href="/settings"
          className="-ml-1 flex w-fit items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <ChevronLeftIcon className="size-3.5" />
          Settings
        </Link>
        <div className="flex items-center gap-4">
          <WorkspaceAvatar workspace={workspace} size="lg" className="size-12" />
          <PageHeader
            title={workspace.name}
            description={
              personal
                ? 'Personal workspace'
                : `Team workspace · ${members.length === 1 ? '1 member' : `${members.length} members`} · you’re ${ROLE_INFO[role].label.toLowerCase()}`
            }
          />
        </div>
        {!personal && <WorkspaceSettingsNav />}
      </div>

      {personal ? (
        <Card data-testid="personal-workspace-note">
          <CardHeader>
            <CardTitle>
              <h2 className="flex items-center gap-2">
                <LockIcon className="size-4 text-muted-foreground" />
                Just for you
              </h2>
            </CardTitle>
            <CardDescription>
              Your personal workspace has exactly one member: you. It can’t be shared, left or
              deleted, and nobody can be invited to it. To work with others, create a team workspace
              and invite them there. You can switch between workspaces at the top of the sidebar.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CreateTeamButton />
          </CardContent>
        </Card>
      ) : (
        children
      )}
    </PageContainer>
  );
}
