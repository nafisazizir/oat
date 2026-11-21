'use server';

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
import {
  assertCan,
  isForbiddenError,
  isLastWorkspace,
  roleIn,
  RoleSchema,
  type Role,
} from '@oat/core';
import { refresh, revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { parseWorkspaceIcon } from '@/lib/workspace';

import { getAuth } from '../auth';
import { getDb } from '../db';
import { requireSession } from '../session';

/*
 * Workspace settings, members and invitations (5.1/5.2). Every action: session → input validation →
 * `@oat/core` `assertCan` on fresh rows → the write. Invitations and settings go through Better Auth
 * (its own checks and our hooks are a second layer); role changes, removals, leaving and deleting go
 * through `@oat/auth` members.ts, which re-checks under a row lock.
 */

export type MemberActionResult = { ok: true } | { ok: false; error: string };

const Id = z.string().min(1).max(100);
const Email = z.email('Enter a valid email address.').max(254);
const Name = z
  .string()
  .trim()
  .min(1, 'Give the workspace a name.')
  .max(60, 'Keep the name under 60 characters.');

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
  if (isForbiddenError(error)) return { ok: false, error: forbidden };
  if (isNotFoundError(error)) return { ok: false, error: NOT_FOUND };
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
async function load(userId: string, workspaceId: string) {
  const db = getDb();
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
export async function updateWorkspace(input: {
  workspaceId: string;
  name: string;
  icon: string | null;
}): Promise<MemberActionResult> {
  const { user } = await requireSession();
  const parsed = z.object({ workspaceId: Id, name: Name }).safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  let icon: string | null;
  try {
    icon = parseWorkspaceIcon(input.icon);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  try {
    const loaded = await load(user.id, parsed.data.workspaceId);
    if (!loaded) return { ok: false, error: NOT_FOUND };
    // Workspace settings are managed by the same people who manage members (owners/admins).
    assertCan('manageMembers', loaded.ctx, loaded.access);
    await getAuth().api.updateOrganization({
      body: {
        organizationId: loaded.workspace.id,
        data: { name: parsed.data.name, logo: icon ?? '' },
      },
      headers: await headers(),
    });
  } catch (error) {
    return failure(error, 'Couldn’t save the workspace.');
  }
  refresh();
  return { ok: true };
}

/** Why the user's only workspace stays (D-36); `@oat/auth` enforces it, this is the wording. */
const LAST_WORKSPACE = (verb: 'leave' | 'delete') =>
  `This is your only workspace. Create or join another one before you ${verb} it.`;

/**
 * Leaves a workspace (never the user's last one); afterwards another of their workspaces is active
 * (`pickActiveWorkspace`).
 */
export async function leaveWorkspace(workspaceId: string): Promise<MemberActionResult> {
  const { user } = await requireSession();
  const id = Id.safeParse(workspaceId);
  if (!id.success) return { ok: false, error: NOT_FOUND };
  try {
    const loaded = await load(user.id, id.data);
    if (!loaded) return { ok: false, error: NOT_FOUND };
    if (isLastWorkspace(loaded.ctx, id.data)) return { ok: false, error: LAST_WORKSPACE('leave') };
    await leave(getDb(), { actorId: user.id, workspaceId: id.data });
  } catch (error) {
    return failure(
      error,
      'Couldn’t leave the workspace.',
      'You’re the only owner. Make someone else an owner first, or delete the workspace.',
    );
  }
  // The shared (app) layout (switcher) must re-render on the way to Home, not just the page.
  revalidatePath('/', 'layout');
  redirect('/home');
}

/** Soft-deletes a workspace (owner only, never their last one). `confirmName` must match its name. */
export async function deleteWorkspace(input: {
  workspaceId: string;
  confirmName: string;
}): Promise<MemberActionResult> {
  const { user } = await requireSession();
  const id = Id.safeParse(input.workspaceId);
  if (!id.success) return { ok: false, error: NOT_FOUND };
  try {
    const loaded = await load(user.id, id.data);
    if (!loaded) return { ok: false, error: NOT_FOUND };
    if (input.confirmName.trim() !== loaded.workspace.name.trim()) {
      return { ok: false, error: 'Type the workspace name exactly to confirm.' };
    }
    if (roleIn(loaded.ctx, id.data) === 'owner' && isLastWorkspace(loaded.ctx, id.data)) {
      return { ok: false, error: LAST_WORKSPACE('delete') };
    }
    await softDeleteWorkspace(getDb(), { actorId: user.id, workspaceId: id.data });
  } catch (error) {
    return failure(error, 'Couldn’t delete the workspace.', 'Only owners can delete a workspace.');
  }
  // The shared (app) layout (switcher) must re-render on the way to Home, not just the page.
  revalidatePath('/', 'layout');
  redirect('/home');
}

// ---------------------------------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------------------------------

export async function changeRole(input: {
  workspaceId: string;
  userId: string;
  role: Role;
}): Promise<MemberActionResult> {
  const { user } = await requireSession();
  const parsed = z.object({ workspaceId: Id, userId: Id, role: RoleSchema }).safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  try {
    await changeMemberRole(getDb(), { actorId: user.id, ...parsed.data });
  } catch (error) {
    return failure(
      error,
      'Couldn’t change the role.',
      'You can’t make that change. A workspace always keeps at least one owner.',
    );
  }
  refresh();
  return { ok: true };
}

export async function removeMember(input: {
  workspaceId: string;
  userId: string;
}): Promise<MemberActionResult> {
  const { user } = await requireSession();
  const parsed = z.object({ workspaceId: Id, userId: Id }).safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  try {
    await remove(getDb(), { actorId: user.id, ...parsed.data });
  } catch (error) {
    return failure(error, 'Couldn’t remove the member.');
  }
  refresh();
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------------------------------

/** Invites `email` with `role` (at most the inviter's own role); sends our invitation email. */
export async function inviteMember(input: {
  workspaceId: string;
  email: string;
  role: Role;
}): Promise<MemberActionResult> {
  const { user } = await requireSession();
  const parsed = z
    .object({
      workspaceId: Id,
      email: z.string().trim().toLowerCase().pipe(Email),
      role: RoleSchema,
    })
    .safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  try {
    const loaded = await load(user.id, parsed.data.workspaceId);
    if (!loaded) return { ok: false, error: NOT_FOUND };
    assertCan('invite', loaded.ctx, loaded.access, parsed.data.role);
    await getAuth().api.createInvitation({
      body: {
        email: parsed.data.email,
        role: parsed.data.role,
        organizationId: loaded.workspace.id,
      },
      headers: await headers(),
    });
  } catch (error) {
    return failure(error, 'Couldn’t send the invite.', 'You can’t invite people with that role.');
  }
  refresh();
  return { ok: true };
}

/**
 * Sends a pending invite again with a fresh expiry (same link). An expired one is replaced by a new
 * invitation (new link) and the old one is revoked.
 */
export async function resendInvite(inviteId: string): Promise<MemberActionResult> {
  const { user } = await requireSession();
  const id = Id.safeParse(inviteId);
  if (!id.success) return { ok: false, error: 'This invitation is no longer valid.' };
  try {
    const db = getDb();
    const existing = await findInvite(db, id.data);
    if (!existing || existing.status !== 'pending') {
      return { ok: false, error: 'This invitation is no longer valid.' };
    }
    const loaded = await load(user.id, existing.workspaceId);
    if (!loaded) return { ok: false, error: NOT_FOUND };
    assertCan('invite', loaded.ctx, loaded.access, existing.role);
    const requestHeaders = await headers();
    const result = await getAuth().api.createInvitation({
      body: {
        email: existing.email,
        role: existing.role,
        organizationId: existing.workspaceId,
        resend: true,
      },
      headers: requestHeaders,
    });
    if (result && result.id !== existing.id) {
      await getAuth().api.cancelInvitation({
        body: { invitationId: existing.id },
        headers: requestHeaders,
      });
    }
  } catch (error) {
    return failure(error, 'Couldn’t resend the invite.');
  }
  refresh();
  return { ok: true };
}

/** Revokes a pending invite: its link stops working. */
export async function revokeInvite(inviteId: string): Promise<MemberActionResult> {
  const { user } = await requireSession();
  const id = Id.safeParse(inviteId);
  if (!id.success) return { ok: false, error: 'This invitation is no longer valid.' };
  try {
    const existing = await findInvite(getDb(), id.data);
    if (!existing || existing.status !== 'pending') {
      return { ok: false, error: 'This invitation is no longer valid.' };
    }
    const loaded = await load(user.id, existing.workspaceId);
    if (!loaded) return { ok: false, error: NOT_FOUND };
    assertCan('manageMembers', loaded.ctx, loaded.access);
    await getAuth().api.cancelInvitation({
      body: { invitationId: existing.id },
      headers: await headers(),
    });
  } catch (error) {
    return failure(error, 'Couldn’t revoke the invite.');
  }
  refresh();
  return { ok: true };
}

/**
 * Accepts the invitation behind an `/invite/<token>` link. Only the invited address, signed in and
 * verified, can accept (checked here and again by Better Auth). Lands on Home in the new workspace.
 */
export async function acceptInvite(token: string): Promise<MemberActionResult> {
  const { user } = await requireSession();
  try {
    const found = await findInviteByToken(getDb(), String(token));
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
    const requestHeaders = await headers();
    try {
      await getAuth().api.acceptInvitation({
        body: { invitationId: found.id },
        headers: requestHeaders,
      });
    } catch (error) {
      // They got in another way while accepting (an owner approved their request to join): Better Auth's
      // accept then trips over the membership that already exists. That is a success, not an error.
      const workspaceId = await inviteAlreadyHonoured(getDb(), {
        invitationId: found.id,
        userId: user.id,
      });
      if (workspaceId === undefined) throw error;
      await getAuth().api.setActiveOrganization({
        body: { organizationId: workspaceId },
        headers: requestHeaders,
      });
    }
  } catch (error) {
    return failure(error, 'Couldn’t accept the invitation.');
  }
  // The shared (app) layout (switcher) must re-render on the way to Home, not just the page.
  revalidatePath('/', 'layout');
  redirect('/home');
}

/** Declines the invitation behind an `/invite/<token>` link (the invited address only). */
export async function declineInvite(token: string): Promise<MemberActionResult> {
  const { user } = await requireSession();
  try {
    const found = await findInviteByToken(getDb(), String(token));
    if (!found || found.state !== 'pending') {
      return { ok: false, error: 'This invitation is no longer valid.' };
    }
    if (found.email.toLowerCase() !== user.email.toLowerCase()) {
      return { ok: false, error: AUTH_ERRORS.YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION! };
    }
    await getAuth().api.rejectInvitation({
      body: { invitationId: found.id },
      headers: await headers(),
    });
  } catch (error) {
    return failure(error, 'Couldn’t decline the invitation.');
  }
  refresh();
  return { ok: true };
}
