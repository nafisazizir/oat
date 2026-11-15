import 'server-only';

import {
  findLiveWorkspace,
  listMembers,
  listPendingInvites,
  loadPermissionContext,
} from '@oat/auth';
import {
  canChangeRole,
  canDeleteWorkspace,
  canInvite,
  canManageMembers,
  canRemoveMember,
  type MemberTarget,
  type PermissionContext,
  type Role,
  ROLES,
  roleIn,
  type WorkspaceAccess,
} from '@oat/core';
import { cache } from 'react';

import { displayName } from '@/lib/tree';
import { workspaceIcon } from '@/lib/workspace';

import { getDb } from './db';
import { requireSession } from './session';
import { getShellData } from './shell';

/*
 * Data for `/settings/workspace` (5.1): the active workspace, its members and invites, and what the viewer
 * may do with each, all decided by `@oat/core`. These flags only shape the UI; every server action
 * checks again (`assertCan`), and member changes re-check under a row lock (`@oat/auth` members.ts).
 */

export interface MemberView {
  userId: string;
  name: string;
  email: string;
  image: string | null;
  role: Role;
  isYou: boolean;
  /** Roles the viewer may change this member to (empty: no role picker). */
  assignableRoles: Role[];
  canRemove: boolean;
}

export interface InviteView {
  id: string;
  email: string;
  role: Role;
  state: 'pending' | 'expired';
  expiresAt: string;
  invitedBy: string;
  /** Resending re-checks that the viewer may invite with this role. */
  canResend: boolean;
}

export interface WorkspaceSettings {
  workspace: {
    id: string;
    name: string;
    slug: string;
    kind: 'personal' | 'team';
    icon: string | null;
  };
  role: Role;
  /** Name/icon changes and member management (team owners and admins). */
  canManage: boolean;
  /** Roles the viewer may invite with (empty: no invite button). */
  inviteRoles: Role[];
  canLeave: boolean;
  canDelete: boolean;
  members: MemberView[];
  /** Pending and expired invitations; only loaded for people who manage members. */
  invites: InviteView[];
}

/** Pure part: rows + permission context → what the settings pages show. */
export function buildWorkspaceSettings(input: {
  userId: string;
  ctx: PermissionContext;
  workspace: WorkspaceSettings['workspace'];
  members: Awaited<ReturnType<typeof listMembers>>;
  invites: Awaited<ReturnType<typeof listPendingInvites>>;
}): WorkspaceSettings {
  const { ctx, userId } = input;
  const access: WorkspaceAccess = { id: input.workspace.id, kind: input.workspace.kind };
  const role = roleIn(ctx, access.id);
  if (!role) throw new Error('not a member of the active workspace');
  const ownerCount = input.members.filter((m) => m.role === 'owner').length;
  const target = (m: { userId: string; role: Role }): MemberTarget => ({
    workspaceId: access.id,
    userId: m.userId,
    role: m.role,
    ownerCount,
  });
  const canManage = canManageMembers(ctx, access);
  return {
    workspace: input.workspace,
    role,
    canManage,
    inviteRoles: ROLES.filter((r) => canInvite(ctx, access, r)),
    canLeave: canRemoveMember(ctx, access, target({ userId, role })),
    canDelete: canDeleteWorkspace(ctx, access),
    members: input.members.map((m) => ({
      userId: m.userId,
      name: displayName(m),
      email: m.email,
      image: m.image,
      role: m.role,
      isYou: m.userId === userId,
      assignableRoles: ROLES.filter(
        (r) => r !== m.role && canChangeRole(ctx, access, target(m), r),
      ),
      canRemove: m.userId !== userId && canRemoveMember(ctx, access, target(m)),
    })),
    invites: canManage
      ? input.invites.map((i) => ({
          id: i.id,
          email: i.email,
          role: i.role,
          state: i.state,
          expiresAt: i.expiresAt.toISOString(),
          invitedBy: i.invitedBy,
          canResend: canInvite(ctx, access, i.role),
        }))
      : [],
  };
}

/** Settings for the session's active workspace (the one in the switcher). Deduped per request. */
export const getWorkspaceSettings = cache(async (): Promise<WorkspaceSettings> => {
  const { user } = await requireSession();
  const { workspace: active } = await getShellData();
  const db = getDb();
  const [row, ctx, members, invites] = await Promise.all([
    findLiveWorkspace(db, active.id),
    loadPermissionContext(db, user.id),
    listMembers(db, active.id),
    listPendingInvites(db, active.id),
  ]);
  if (!row) throw new Error('active workspace disappeared');
  return buildWorkspaceSettings({
    userId: user.id,
    ctx,
    workspace: {
      id: row.id,
      name: row.name,
      slug: row.slug,
      kind: row.kind,
      icon: workspaceIcon(row.logo),
    },
    members,
    invites,
  });
});
