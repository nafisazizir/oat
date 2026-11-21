import {
  ensureFirstWorkspace,
  getJoinChoices,
  hasJoinChoices,
  listUserWorkspaces,
} from '@oat/auth';
import {
  AuthContent,
  AuthDescription,
  AuthHeader,
  AuthPanel,
  AuthTitle,
} from '@oat/ui/components/auth-layout';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { JoinChoiceList } from '@/components/workspace/join-choices';
import { ROLE_INFO, workspaceIcon } from '@/lib/workspace';
import { getDb } from '@/server/db';
import { requireSession } from '@/server/session';

export const metadata: Metadata = {
  title: 'Join a workspace',
  robots: { index: false, follow: false },
};

const members = (n: number) => (n === 1 ? '1 member' : `${n} members`);

/**
 * Where a signed-in user without a workspace chooses one (D-36; D-35: one calm column, not a wizard):
 * invitations to their address and workspaces that are open to the domain of their verified email, with
 * "Create my own workspace" as the alternative. With nothing to choose from they never see it — they go
 * straight into a workspace made for them.
 *
 * Someone who already has a workspace reaches it from the workspace menu ("Join a workspace", shown only
 * while there is something to join): the same list, with a way back instead of "Create my own workspace".
 * With nothing to choose from they go Home.
 */
export default async function JoinPage() {
  const { user } = await requireSession();
  const db = getDb();
  const member = (await listUserWorkspaces(db, user.id)).length > 0;
  const choices = await getJoinChoices(db, user.id);
  if (!hasJoinChoices(choices)) {
    if (!member) await ensureFirstWorkspace(db, user.id);
    redirect('/home');
  }

  return (
    <AuthPanel data-testid="join-screen">
      <AuthHeader>
        <AuthTitle>
          <h1>Join a workspace</h1>
        </AuthTitle>
        <AuthDescription>
          You’re signed in as <span className="text-gray-1000">{user.email}</span>.
        </AuthDescription>
      </AuthHeader>
      <AuthContent className="gap-6">
        <JoinChoiceList
          member={member}
          choices={[
            ...choices.invites.map((invite) => ({
              kind: 'invite' as const,
              key: `invite:${invite.token}`,
              token: invite.token,
              workspace: {
                name: invite.workspace.name,
                icon: workspaceIcon(invite.workspace.logo),
              },
              detail: `${invite.invitedBy} invited you as ${
                invite.role === 'admin' || invite.role === 'owner' ? 'an' : 'a'
              } ${ROLE_INFO[invite.role].label.toLowerCase()}`,
            })),
            ...choices.workspaces.map((workspace) => ({
              kind: workspace.option,
              key: `workspace:${workspace.id}`,
              workspaceId: workspace.id,
              workspace: { name: workspace.name, icon: workspaceIcon(workspace.logo) },
              detail:
                workspace.option === 'join'
                  ? `${members(workspace.memberCount)} · open to your domain`
                  : workspace.option === 'request'
                    ? `${members(workspace.memberCount)} · needs approval`
                    : 'Waiting for approval',
            })),
          ]}
        />
      </AuthContent>
    </AuthPanel>
  );
}
