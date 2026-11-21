import {
  changeMemberRole,
  deleteWorkspace as softDeleteWorkspace,
  findInvite,
  findInviteByToken,
  findLiveWorkspace,
  inviteAlreadyHonoured,
  isNotFoundError,
  leaveWorkspace as leave,
  loadPermissionContext,
  removeMember as remove,
} from '@oat/auth';
import { assertCan, isForbiddenError, isLastWorkspace, roleIn, type Role } from '@oat/core';
import {
  WorkspaceId as Id,
  InviteMemberSchema,
  MemberRoleSchema,
  UpdateWorkspaceSchema,
} from '@oat/services/dto/workspaces';
import { z } from 'zod';

import { parseWorkspaceIcon } from '@/lib/workspace';

import type { OperationContext } from '../operation-context';

/*
 * Workspace settings, members and invitations (5.1/5.2). Every action: session → input validation →
 * `@oat/core` `assertCan` on fresh rows → the write. Invitations and settings go through Better Auth
 * (its own checks and our hooks are a second layer); role changes, removals, leaving and deleting go
 * through `@oat/auth` members.ts, which re-checks under a row lock.
 */

export type MemberActionResult = { ok: true } | { ok: false; error: string; status?: number };

const FORBIDDEN = 'You don’t have permission to do that.';
const NOT_FOUND = 'That workspace or member no longer exists.';

/** Better Auth error codes we explain in our own words. */
const AUTH_ERRORS: Record<string, string> = {
  USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION: 'They’re already a member of this workspace.',
  USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION:
    'They already have a pending invite. Resend it from the list below.',
  INVITATION_LIMIT_REACHED: 'This workspace has too many pending invites. Revoke some first.',
  INVITATION_NOT_FOUND: 'This invitation is no longer valid.',
  YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION: 'This invitation was sent to a different address.',
  EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION:
    'Verify your email address first.',
  ORGANIZATION_MEMBERSHIP_LIMIT_REACHED: 'This workspace is full.',
};

function failure(error: unknown, fallback: string, forbidden = FORBIDDEN): MemberActionResult {
  if (isForbiddenError(error)) return { ok: false, error: forbidden, status: 403 };
  if (isNotFoundError(error)) return { ok: false, error: NOT_FOUND, status: 404 };
  if (error && typeof error === 'object' && 'body' in error) {
    const body = (error as { body?: { code?: unknown; message?: unknown } }).body;
    if (typeof body?.code === 'string' && AUTH_ERRORS[body.code]) {
      return { ok: false, error: AUTH_ERRORS[body.code]! };
    }
    if (typeof body?.message === 'string' && body.message)
      return { ok: false, error: body.message };
  }
  console.error(fallback, error);
  return { ok: false, error: fallback };
}

const invalid = (error: z.ZodError): MemberActionResult => ({
  ok: false,
  error: error.issues[0]?.message ?? 'Check the form and try again.',
});

/** The live workspace + the actor's permission context, or a not-found error. */
async function load(context: OperationContext, userId: string, workspaceId: string) {
  const db = context.db;
  const [workspace, ctx] = await Promise.all([
    findLiveWorkspace(db, workspaceId),
    loadPermissionContext(db, userId),
  ]);
  if (!workspace || ctx.memberships.get(workspaceId) === undefined) return undefined;
  return { workspace, access: { id: workspace.id }, ctx };
}

// ---------------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------------

/** Renames a workspace and sets/clears its emoji icon (owners and admins). */
export async function updateWorkspace(
  context: OperationContext,
  input: {
    workspaceId: string;
    name: string;
    icon: string | null;
  },
): Promise<MemberActionResult> {
  const { user } = context;
  const parsed = UpdateWorkspaceSchema.omit({ icon: true })
    .extend({ workspaceId: Id })
    .safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  let icon: string | null;
  try {
    icon = parseWorkspaceIcon(input.icon);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  try {
    const loaded = await load(context, user.id, parsed.data.workspaceId);
    if (!loaded) return { ok: false, error: NOT_FOUND, status: 404 };
    // Workspace settings are managed by the same people who manage members (owners/admins).
    assertCan('manageMembers', loaded.ctx, loaded.access);
    await context.auth.api.updateOrganization({
      body: {
        organizationId: loaded.workspace.id,
        data: { name: parsed.data.name, logo: icon ?? '' },
      },
      headers: context.headers,
    });
  } catch (error) {
    return failure(error, 'Couldn’t save the workspace.');
  }
  return { ok: true };
}

/** Why the user's only workspace stays (D-36); `@oat/auth` enforces it, this is the wording. */
const LAST_WORKSPACE = (verb: 'leave' | 'delete') =>
  `This is your only workspace. Create or join another one before you ${verb} it.`;

/**
 * Leaves a workspace (never the user's last one); afterwards another of their workspaces is active
 * (`pickActiveWorkspace`).
 */
export async function leaveWorkspace(
  context: OperationContext,
  workspaceId: string,
): Promise<MemberActionResult> {
  const { user } = context;
  const id = Id.safeParse(workspaceId);
  if (!id.success) return { ok: false, error: NOT_FOUND, status: 404 };
  try {
    const loaded = await load(context, user.id, id.data);
    if (!loaded) return { ok: false, error: NOT_FOUND, status: 404 };
    if (isLastWorkspace(loaded.ctx, id.data)) return { ok: false, error: LAST_WORKSPACE('leave') };
    await leave(context.db, { actorId: user.id, workspaceId: id.data });
  } catch (error) {
    return failure(
      error,
      'Couldn’t leave the workspace.',
      'You’re the only owner. Make someone else an owner first, or delete the workspace.',
    );
  }
  return { ok: true };
}

/** Soft-deletes a workspace (owner only, never their last one). `confirmName` must match its name. */
export async function deleteWorkspace(
  context: OperationContext,
  input: {
    workspaceId: string;
    confirmName: string;
  },
): Promise<MemberActionResult> {
  const { user } = context;
  const id = Id.safeParse(input.workspaceId);
  if (!id.success) return { ok: false, error: NOT_FOUND, status: 404 };
  try {
    const loaded = await load(context, user.id, id.data);
    if (!loaded) return { ok: false, error: NOT_FOUND, status: 404 };
    if (input.confirmName.trim() !== loaded.workspace.name.trim()) {
      return { ok: false, error: 'Type the workspace name exactly to confirm.' };
    }
    if (roleIn(loaded.ctx, id.data) === 'owner' && isLastWorkspace(loaded.ctx, id.data)) {
      return { ok: false, error: LAST_WORKSPACE('delete') };
    }
    await softDeleteWorkspace(context.db, { actorId: user.id, workspaceId: id.data });
  } catch (error) {
    return failure(error, 'Couldn’t delete the workspace.', 'Only owners can delete a workspace.');
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------------------------------

export async function changeRole(
  context: OperationContext,
  input: {
    workspaceId: string;
    userId: string;
    role: Role;
  },
): Promise<MemberActionResult> {
  const { user } = context;
  const parsed = MemberRoleSchema.extend({ workspaceId: Id, userId: Id }).safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  try {
    await changeMemberRole(context.db, { actorId: user.id, ...parsed.data });
  } catch (error) {
    return failure(
      error,
      'Couldn’t change the role.',
      'You can’t make that change. A workspace always keeps at least one owner.',
    );
  }
  return { ok: true };
}

export async function removeMember(
  context: OperationContext,
  input: {
    workspaceId: string;
    userId: string;
  },
): Promise<MemberActionResult> {
  const { user } = context;
  const parsed = z.object({ workspaceId: Id, userId: Id }).safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  try {
    await remove(context.db, { actorId: user.id, ...parsed.data });
  } catch (error) {
    return failure(error, 'Couldn’t remove the member.');
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------------------------------

/** Invites `email` with `role` (at most the inviter's own role); sends our invitation email. */
export async function inviteMember(
  context: OperationContext,
  input: {
    workspaceId: string;
    email: string;
    role: Role;
  },
): Promise<MemberActionResult> {
  const { user } = context;
  const parsed = InviteMemberSchema.extend({ workspaceId: Id }).safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  try {
    const loaded = await load(context, user.id, parsed.data.workspaceId);
    if (!loaded) return { ok: false, error: NOT_FOUND, status: 404 };
    assertCan('invite', loaded.ctx, loaded.access, parsed.data.role);
    await context.auth.api.createInvitation({
      body: {
        email: parsed.data.email,
        role: parsed.data.role,
        organizationId: loaded.workspace.id,
      },
      headers: context.headers,
    });
  } catch (error) {
    return failure(error, 'Couldn’t send the invite.', 'You can’t invite people with that role.');
  }
  return { ok: true };
}

/**
 * Sends a pending invite again with a fresh expiry (same link). An expired one is replaced by a new
 * invitation (new link) and the old one is revoked.
 */
export async function resendInvite(
  context: OperationContext,
  inviteId: string,
): Promise<MemberActionResult> {
  const { user } = context;
  const id = Id.safeParse(inviteId);
  if (!id.success) return { ok: false, error: 'This invitation is no longer valid.' };
  try {
    const db = context.db;
    const existing = await findInvite(db, id.data);
    if (!existing || existing.status !== 'pending') {
      return { ok: false, error: 'This invitation is no longer valid.' };
    }
    const loaded = await load(context, user.id, existing.workspaceId);
    if (!loaded) return { ok: false, error: NOT_FOUND, status: 404 };
    assertCan('invite', loaded.ctx, loaded.access, existing.role);
    const requestHeaders = context.headers;
    const result = await context.auth.api.createInvitation({
      body: {
        email: existing.email,
        role: existing.role,
        organizationId: existing.workspaceId,
        resend: true,
      },
      headers: requestHeaders,
    });
    if (result && result.id !== existing.id) {
      await context.auth.api.cancelInvitation({
        body: { invitationId: existing.id },
        headers: requestHeaders,
      });
    }
  } catch (error) {
    return failure(error, 'Couldn’t resend the invite.');
  }
  return { ok: true };
}

/** Revokes a pending invite: its link stops working. */
export async function revokeInvite(
  context: OperationContext,
  inviteId: string,
): Promise<MemberActionResult> {
  const { user } = context;
  const id = Id.safeParse(inviteId);
  if (!id.success) return { ok: false, error: 'This invitation is no longer valid.' };
  try {
    const existing = await findInvite(context.db, id.data);
    if (!existing || existing.status !== 'pending') {
      return { ok: false, error: 'This invitation is no longer valid.' };
    }
    const loaded = await load(context, user.id, existing.workspaceId);
    if (!loaded) return { ok: false, error: NOT_FOUND, status: 404 };
    assertCan('manageMembers', loaded.ctx, loaded.access);
    await context.auth.api.cancelInvitation({
      body: { invitationId: existing.id },
      headers: context.headers,
    });
  } catch (error) {
    return failure(error, 'Couldn’t revoke the invite.');
  }
  return { ok: true };
}

/**
 * Accepts the invitation behind an `/invite/<token>` link. Only the invited address, signed in and
 * verified, can accept (checked here and again by Better Auth). Lands on Home in the new workspace.
 */
export async function acceptInvite(
  context: OperationContext,
  token: string,
): Promise<MemberActionResult> {
  const { user } = context;
  const outcome = await (async (): Promise<MemberActionResult | 'in'> => {
    try {
      const found = await findInviteByToken(context.db, String(token));
      if (found && found.state === 'accepted') {
        // Settled already — by an earlier accept, or because they got in another way first (auto-join, an
        // approved request). For the invited, verified address that is a member, opening the link again
        // just goes there (`inviteAlreadyHonoured` checks all three); for anyone else it is used up.
        const workspaceId = await inviteAlreadyHonoured(context.db, {
          invitationId: found.id,
          userId: user.id,
        });
        if (workspaceId === undefined) {
          return { ok: false, error: 'This invitation is no longer valid.' };
        }
        await context.auth.api.setActiveOrganization({
          body: { organizationId: workspaceId },
          headers: context.headers,
        });
        return 'in';
      }
      if (!found || found.state !== 'pending') {
        return { ok: false, error: 'This invitation is no longer valid.' };
      }
      if (found.email.toLowerCase() !== user.email.toLowerCase()) {
        return { ok: false, error: AUTH_ERRORS.YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION! };
      }
      if (!user.emailVerified) {
        return {
          ok: false,
          error: AUTH_ERRORS.EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION!,
        };
      }
      const requestHeaders = context.headers;
      try {
        await context.auth.api.acceptInvitation({
          body: { invitationId: found.id },
          headers: requestHeaders,
        });
      } catch (error) {
        // They got in another way while accepting (an owner approved their request to join): Better Auth's
        // accept then trips over the membership that already exists. That is a success, not an error.
        const workspaceId = await inviteAlreadyHonoured(context.db, {
          invitationId: found.id,
          userId: user.id,
        });
        if (workspaceId === undefined) throw error;
        await context.auth.api.setActiveOrganization({
          body: { organizationId: workspaceId },
          headers: requestHeaders,
        });
      }
      return 'in';
    } catch (error) {
      return failure(error, 'Couldn’t accept the invitation.');
    }
  })();
  if (outcome !== 'in') return outcome;
  return { ok: true };
}

/** Declines the invitation behind an `/invite/<token>` link (the invited address only). */
export async function declineInvite(
  context: OperationContext,
  token: string,
): Promise<MemberActionResult> {
  const { user } = context;
  try {
    const found = await findInviteByToken(context.db, String(token));
    if (!found || found.state !== 'pending') {
      return { ok: false, error: 'This invitation is no longer valid.' };
    }
    if (found.email.toLowerCase() !== user.email.toLowerCase()) {
      return { ok: false, error: AUTH_ERRORS.YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION! };
    }
    await context.auth.api.rejectInvitation({
      body: { invitationId: found.id },
      headers: context.headers,
    });
  } catch (error) {
    return failure(error, 'Couldn’t decline the invitation.');
  }
  return { ok: true };
}
