import { findInviteByToken, loadPermissionContext } from '@oat/auth';
import { roleIn } from '@oat/core';
import { INVITE_TOKEN } from '@oat/core/invite-link';
import type { Db } from '@oat/db';
import type { InviteLanding } from '@oat/services/dto/workspaces';

export async function loadInviteLanding(
  db: Db,
  token: string,
  user: { id: string; email: string },
): Promise<InviteLanding> {
  if (!INVITE_TOKEN.test(token)) return { state: 'invalid' };
  const invite = await findInviteByToken(db, token);
  if (!invite) return { state: 'invalid' };
  const matches = invite.email.toLowerCase() === user.email.toLowerCase();
  const member =
    matches && roleIn(await loadPermissionContext(db, user.id), invite.workspace.id) !== undefined;
  return {
    state: invite.state,
    workspace: { id: invite.workspace.id, name: invite.workspace.name },
    inviter: invite.inviter.name,
    email: invite.email,
    role: invite.role,
    viewerEmail: user.email,
    access: !matches ? 'wrong-account' : member ? 'member' : 'invited',
  };
}
