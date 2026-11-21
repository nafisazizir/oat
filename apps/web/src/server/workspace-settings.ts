import 'server-only';

import {
  findLiveWorkspace,
  getJoinSettings,
  type JoinSettings,
  listableDomain,
  listJoinRequests,
  listMembers,
  listPendingInvites,
  loadPermissionContext,
  type PendingJoinRequest,
} from '@oat/auth';
import {
  canAddDomain,
  canChangeRole,
  canDecideJoinRequest,
  canDeleteWorkspace,
  canEditJoinSettings,
  canInvite,
  canManageMembers,
  canRemoveMember,
  type EmailIdentity,
  isLastWorkspace,
  type JoinPolicy,
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
 * Data for `/settings/workspace` (5.1): the active workspace, its members, invites, join settings and
 * requests to join (D-36), and what the viewer may do with each, all decided by `@oat/core`. These flags only shape the UI; every server action
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

/** Someone asking to join (D-36); only loaded for people who manage members. */
export interface JoinRequestView {
  id: string;
  name: string;
  email: string;
  image: string | null;
  requestedAt: string;
}

/** The join policy and allowed domains, for the people who may change them. */
export interface JoiningView {
  policy: JoinPolicy;
  domains: string[];
  /**
   * The one domain the viewer could add — their own verified email's — and whether it is listed already;
   * or why they have none to add (`public`: a public mailbox address; `unverified`).
   */
  ownDomain:
    { domain: string; listed: boolean } | { domain: null; reason: 'public' | 'unverified' };
}

export interface WorkspaceSettings {
  workspace: {
    id: string;
    name: string;
    slug: string;
    icon: string | null;
  };
  role: Role;
  /** Name/icon changes and member management (owners and admins). */
  canManage: boolean;
  /** Roles the viewer may invite with (empty: no invite button). */
  inviteRoles: Role[];
  canLeave: boolean;
  canDelete: boolean;
  /**
   * This is the only workspace the viewer belongs to (D-36): it can't be left or deleted until they create or
   * join another one — the settings page says so instead of only disabling the buttons.
   */
  lastWorkspace: boolean;
  members: MemberView[];
  /** Pending and expired invitations; only loaded for people who manage members. */
  invites: InviteView[];
  /** Join policy + domains (D-36); `null` for people who can't edit them (they don't see them either). */
  joining: JoiningView | null;
  /** Requests to join waiting for a decision; empty for people who can't decide them. */
  joinRequests: JoinRequestView[];
  /** Roles the viewer may approve a request with (at most their own). */
  approveRoles: Role[];
}

/** Pure part: rows + permission context → what the settings pages show. */
export function buildWorkspaceSettings(input: {
  userId: string;
  ctx: PermissionContext;
  workspace: WorkspaceSettings['workspace'];
  members: Awaited<ReturnType<typeof listMembers>>;
  invites: Awaited<ReturnType<typeof listPendingInvites>>;
  /** The viewer's email as the session has it (decides which domain they could add). */
  viewer?: EmailIdentity;
  joining?: JoinSettings;
  joinRequests?: readonly PendingJoinRequest[];
}): WorkspaceSettings {
  const { ctx, userId } = input;
  const access: WorkspaceAccess = { id: input.workspace.id };
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
  const approveRoles = ROLES.filter((r) =>
    canDecideJoinRequest(ctx, access, { workspaceId: access.id, status: 'pending' }, r),
  );
  const own = input.viewer ? listableDomain(input.viewer) : null;
  const joining: JoiningView | null =
    input.joining && own && input.viewer && canEditJoinSettings(ctx, access)
      ? {
          policy: input.joining.policy,
          domains: input.joining.domains,
          ownDomain:
            own.domain === null
              ? own
              : canAddDomain(ctx, access, input.viewer, own.domain)
                ? { domain: own.domain, listed: input.joining.domains.includes(own.domain) }
                : { domain: null, reason: 'unverified' },
        }
      : null;
  return {
    workspace: input.workspace,
    role,
    canManage,
    inviteRoles: ROLES.filter((r) => canInvite(ctx, access, r)),
    canLeave: canRemoveMember(ctx, access, target({ userId, role })),
    canDelete: canDeleteWorkspace(ctx, access),
    lastWorkspace: isLastWorkspace(ctx, access.id),
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
    joining,
    joinRequests:
      approveRoles.length > 0
        ? (input.joinRequests ?? []).map((r) => ({
            id: r.id,
            name: displayName(r),
            email: r.email,
            image: r.image,
            requestedAt: r.requestedAt.toISOString(),
          }))
        : [],
    approveRoles,
  };
}

/** Settings for the session's active workspace (the one in the switcher). Deduped per request. */
export const getWorkspaceSettings = cache(async (): Promise<WorkspaceSettings> => {
  const { user } = await requireSession();
  const { workspace: active } = await getShellData();
  const db = getDb();
  const [row, ctx, members, invites, joining, joinRequests] = await Promise.all([
    findLiveWorkspace(db, active.id),
    loadPermissionContext(db, user.id),
    listMembers(db, active.id),
    listPendingInvites(db, active.id),
    getJoinSettings(db, active.id),
    listJoinRequests(db, active.id),
  ]);
  if (!row) throw new Error('active workspace disappeared');
  return buildWorkspaceSettings({
    userId: user.id,
    ctx,
    workspace: {
      id: row.id,
      name: row.name,
      slug: row.slug,
      icon: workspaceIcon(row.logo),
    },
    members,
    invites,
    viewer: { email: user.email, emailVerified: user.emailVerified },
    joining,
    joinRequests,
  });
});
