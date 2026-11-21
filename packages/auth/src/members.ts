/**
 * Workspace membership (5.1/5.2): listing members and invites, changing roles, removing members,
 * leaving, and soft-deleting a workspace.
 *
 * Every decision comes from `@oat/core` (`assertCan`), evaluated on rows read **inside the same
 * transaction, under a lock**: the workspace row is locked first (a per-workspace mutex), then every
 * membership row of the workspace `FOR UPDATE`. Two owners demoting/removing each other or leaving at the
 * same time therefore run one after the other, and the second sees the first one's change in its owner
 * count, so a workspace always keeps at least one owner. Leaving and deleting also take the actor's own
 * user lock first (`lockUser`) and read all their live memberships inside it, so nobody ends up without a
 * workspace by leaving two at once (D-36: the last one can't be left or deleted).
 *
 * Better Auth's own member endpoints (`update-member-role`, `remove-member`, `leave`) can't take part in
 * that transaction, so `server.ts` blocks them; invitations still go through Better Auth (see the web
 * actions), with our hooks as the policy layer.
 */
import {
  assertCan,
  canInvite,
  createPermissionContext,
  type MemberTarget,
  canAddDomain,
  canEditJoinSettings,
  type Role,
  ROLES,
  type WorkspaceAccess,
} from '@oat/core';
import {
  type Db,
  invite,
  joinRequest,
  membership,
  session,
  user,
  workspace,
  workspaceDomain,
} from '@oat/db';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { loadPermissionContext, lockUser } from './workspaces.ts';

/** How long an invitation link stays valid (Better Auth `invitationExpiresIn`). */
export const INVITE_EXPIRES_IN = 7 * 24 * 60 * 60;

/** How long a soft-deleted workspace is kept before it may be purged (purge job: later task). */
export const WORKSPACE_RESTORE_DAYS = 30;

/** The workspace (or member, or invite) doesn't exist, was deleted, or isn't visible to the actor. */
export class NotFoundError extends Error {
  override readonly name = 'NotFoundError';
  readonly code = 'NOT_FOUND';
  readonly status = 404;
}

export function isNotFoundError(error: unknown): error is NotFoundError {
  return error instanceof NotFoundError;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface LockedWorkspace {
  access: WorkspaceAccess;
  /** Every membership of the workspace, locked `FOR UPDATE`. */
  members: { workspaceId: string; userId: string; role: Role }[];
  ownerCount: number;
}

/**
 * Locks the (live) workspace and all its memberships for the rest of `tx`. Throws {@link NotFoundError}
 * when the workspace doesn't exist, is deleted, or the actor isn't a member (so non-members can't probe).
 */
export async function lockWorkspace(
  tx: Tx,
  workspaceId: string,
  actorId: string,
): Promise<LockedWorkspace> {
  const [ws] = await tx
    .select({ id: workspace.id, deletedAt: workspace.deletedAt })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .for('update');
  if (!ws || ws.deletedAt !== null) throw new NotFoundError('Workspace not found.');
  // A fresh statement after the mutex: under READ COMMITTED it sees every change committed before we
  // got the workspace lock.
  const members = await tx
    .select({
      workspaceId: membership.workspaceId,
      userId: membership.userId,
      role: membership.role,
    })
    .from(membership)
    .where(eq(membership.workspaceId, workspaceId))
    .orderBy(asc(membership.id))
    .for('update');
  if (!members.some((m) => m.userId === actorId)) throw new NotFoundError('Workspace not found.');
  return {
    access: { id: ws.id },
    members,
    ownerCount: members.filter((m) => m.role === 'owner').length,
  };
}

function targetOf(locked: LockedWorkspace, userId: string): MemberTarget {
  const row = locked.members.find((m) => m.userId === userId);
  if (!row) throw new NotFoundError('Member not found.');
  return { ...row, ownerCount: locked.ownerCount };
}

/** The actor's context from the locked rows of this workspace alone. */
export const contextOf = (locked: LockedWorkspace, actorId: string) =>
  createPermissionContext({ userId: actorId, memberships: locked.members });

/** The actor's user lock, for leaving or deleting. Take it before {@link lockWorkspace} (user, then workspace). */
async function lockActor(tx: Tx, actorId: string) {
  if (!(await lockUser(tx, actorId))) throw new NotFoundError('Workspace not found.');
}

/**
 * The actor's context for leaving or deleting, built **after** both locks are held ({@link lockActor}, then
 * {@link lockWorkspace}): their role in this workspace comes from the locked rows (a demotion that committed
 * while we waited for the workspace lock counts), and their other live memberships — which the
 * last-workspace rule counts — from a fresh read under the user lock.
 */
async function lockedActorContext(tx: Tx, locked: LockedWorkspace, actorId: string) {
  const all = await loadPermissionContext(tx, actorId);
  const elsewhere = [...all.memberships]
    .filter(([workspaceId]) => workspaceId !== locked.access.id)
    .map(([workspaceId, role]) => ({ workspaceId, userId: actorId, role }));
  return createPermissionContext({
    userId: actorId,
    memberships: [...elsewhere, ...locked.members.filter((m) => m.userId === actorId)],
  });
}

/**
 * Sessions that had `workspaceId` active fall back to another of the user's workspaces on their next
 * request (`pickActiveWorkspace`).
 */
async function clearActiveWorkspace(tx: Tx, workspaceId: string, userId?: string) {
  await tx
    .update(session)
    .set({ activeWorkspaceId: null })
    .where(
      userId === undefined
        ? eq(session.activeWorkspaceId, workspaceId)
        : and(eq(session.activeWorkspaceId, workspaceId), eq(session.userId, userId)),
    );
}

/**
 * Revokes the pending invitations `inviterId` sent in this workspace that they could no longer send with
 * `role` (`undefined` = no longer a member): an invite carries its sender's authority only while they
 * still have it. Runs inside the member-change transaction. Accepting also re-checks
 * ({@link inviterMayStillInvite}), so invites can't outlive a demotion either way.
 */
async function revokeInvitesBeyondAuthority(
  tx: Tx,
  access: WorkspaceAccess,
  inviterId: string,
  role: Role | undefined,
) {
  const pending = await tx
    .select({ id: invite.id, role: invite.role })
    .from(invite)
    .where(
      and(
        eq(invite.workspaceId, access.id),
        eq(invite.inviterId, inviterId),
        eq(invite.status, 'pending'),
      ),
    );
  const ctx = createPermissionContext({
    userId: inviterId,
    memberships: role ? [{ workspaceId: access.id, userId: inviterId, role }] : [],
  });
  const stale = pending.filter((i) => !canInvite(ctx, access, i.role)).map((i) => i.id);
  if (stale.length > 0) {
    await tx.update(invite).set({ status: 'canceled' }).where(inArray(invite.id, stale));
  }
}

/**
 * Drops the allowed email domains `userId` listed in this workspace once they could no longer list them
 * (`role`: their role now; `undefined` = no longer a member): like an invitation, a listed domain carries
 * its lister's authority only while they have it (D-36: removal and demotion close the door they opened).
 * A domain that another current owner/admin could list themselves — their verified email is on it — stays,
 * in that person's name. Runs inside the member-change transaction, after the change is written.
 */
async function dropDomainsBeyondAuthority(
  tx: Tx,
  access: WorkspaceAccess,
  userId: string,
  role: Role | undefined,
) {
  const still = createPermissionContext({
    userId,
    memberships: role ? [{ workspaceId: access.id, userId, role }] : [],
  });
  if (canEditJoinSettings(still, access)) return;
  const listed = await tx
    .select({ domain: workspaceDomain.domain })
    .from(workspaceDomain)
    .where(and(eq(workspaceDomain.workspaceId, access.id), eq(workspaceDomain.addedBy, userId)));
  if (listed.length === 0) return;
  const managers = await tx
    .select({
      userId: membership.userId,
      role: membership.role,
      email: user.email,
      emailVerified: user.emailVerified,
    })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(and(eq(membership.workspaceId, access.id), inArray(membership.role, ['owner', 'admin'])))
    .orderBy(asc(membership.id));
  for (const { domain } of listed) {
    const heir = managers.find((m) =>
      canAddDomain(
        createPermissionContext({
          userId: m.userId,
          memberships: [{ workspaceId: access.id, userId: m.userId, role: m.role }],
        }),
        access,
        m,
        domain,
      ),
    );
    const row = and(eq(workspaceDomain.workspaceId, access.id), eq(workspaceDomain.domain, domain));
    if (heir) await tx.update(workspaceDomain).set({ addedBy: heir.userId }).where(row);
    else await tx.delete(workspaceDomain).where(row);
  }
}

/**
 * Records that `userId` was removed from the workspace by `removedBy`, as a `declined` request to join: a
 * request of theirs that was waiting is declined, else a declined row is written. `@oat/core` reads the
 * latest request, so they can neither auto-join nor ask again — an owner/admin's invitation is the only
 * way back (D-36: a removed member loses access). Not written when someone leaves on their own.
 */
async function recordRemoval(tx: Tx, access: WorkspaceAccess, userId: string, removedBy: string) {
  const decision = { status: 'declined' as const, decidedBy: removedBy, decidedAt: sql`now()` };
  await tx
    .update(joinRequest)
    .set({ ...decision, role: null })
    .where(
      and(
        eq(joinRequest.workspaceId, access.id),
        eq(joinRequest.userId, userId),
        eq(joinRequest.status, 'pending'),
      ),
    );
  // Always a new row: it must be the *latest* one, also after an earlier approval.
  await tx.insert(joinRequest).values({ workspaceId: access.id, userId, ...decision });
}

/**
 * Whether `inviterId` may still invite with `role` into `workspaceId` right now: the workspace is live and
 * their *current* membership passes `@oat/core` `canInvite`. Checked when an invite is accepted or
 * (re)sent, so a removed or demoted admin's old invites can't be used to get back in.
 */
export async function inviterMayStillInvite(
  db: Db,
  input: { inviterId: string; workspaceId: string; role: string },
): Promise<boolean> {
  const [row] = await db
    .select({ deletedAt: workspace.deletedAt, memberRole: membership.role })
    .from(workspace)
    .leftJoin(
      membership,
      and(eq(membership.workspaceId, workspace.id), eq(membership.userId, input.inviterId)),
    )
    .where(eq(workspace.id, input.workspaceId));
  if (!row || row.deletedAt !== null || !row.memberRole) return false;
  if (!(ROLES as readonly string[]).includes(input.role)) return false;
  const ctx = createPermissionContext({
    userId: input.inviterId,
    memberships: [
      { workspaceId: input.workspaceId, userId: input.inviterId, role: row.memberRole },
    ],
  });
  return canInvite(ctx, { id: input.workspaceId }, input.role as Role);
}

/** Changes `userId`'s role in a workspace (`@oat/core` `changeRole`, incl. last-owner protection). */
export async function changeMemberRole(
  db: Db,
  input: { actorId: string; workspaceId: string; userId: string; role: Role },
): Promise<void> {
  await db.transaction(async (tx) => {
    const locked = await lockWorkspace(tx, input.workspaceId, input.actorId);
    const target = targetOf(locked, input.userId);
    assertCan('changeRole', contextOf(locked, input.actorId), locked.access, target, input.role);
    if (target.role === input.role) return;
    await tx
      .update(membership)
      .set({ role: input.role })
      .where(
        and(eq(membership.workspaceId, input.workspaceId), eq(membership.userId, input.userId)),
      );
    await revokeInvitesBeyondAuthority(tx, locked.access, input.userId, input.role);
    await dropDomainsBeyondAuthority(tx, locked.access, input.userId, input.role);
  });
}

/**
 * Removes `userId` from a workspace; `userId === actorId` is leaving. `@oat/core` `removeMember` decides
 * (anyone may leave unless it is their last workspace, owners remove anyone, admins only members/viewers,
 * never the last owner). A member removed from their only workspace gets a new one of their own the next
 * time they open Oat (`ensureFirstWorkspace`). Removal by someone else also closes the domain door behind
 * them ({@link recordRemoval}); either way the domains they had listed go ({@link dropDomainsBeyondAuthority}).
 */
export async function removeMember(
  db: Db,
  input: { actorId: string; workspaceId: string; userId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const leaving = input.userId === input.actorId;
    if (leaving) await lockActor(tx, input.actorId);
    const locked = await lockWorkspace(tx, input.workspaceId, input.actorId);
    const target = targetOf(locked, input.userId);
    const ctx = leaving
      ? await lockedActorContext(tx, locked, input.actorId)
      : contextOf(locked, input.actorId);
    assertCan('removeMember', ctx, locked.access, target);
    await tx
      .delete(membership)
      .where(
        and(eq(membership.workspaceId, input.workspaceId), eq(membership.userId, input.userId)),
      );
    await clearActiveWorkspace(tx, input.workspaceId, input.userId);
    await revokeInvitesBeyondAuthority(tx, locked.access, input.userId, undefined);
    await dropDomainsBeyondAuthority(tx, locked.access, input.userId, undefined);
    if (!leaving) await recordRemoval(tx, locked.access, input.userId, input.actorId);
  });
}

/** Leaving a workspace: {@link removeMember} on yourself. */
export function leaveWorkspace(
  db: Db,
  input: { actorId: string; workspaceId: string },
): Promise<void> {
  return removeMember(db, { ...input, userId: input.actorId });
}

/**
 * Soft-deletes a workspace (owner only, never the actor's last one; D-22, D-36): sets `deleted_at`, after
 * which it is hidden from workspace lists and permission contexts. Data stays for
 * {@link WORKSPACE_RESTORE_DAYS} days. Other members for whom it was the only workspace get a new one of
 * their own the next time they open Oat (`ensureFirstWorkspace`).
 */
export async function deleteWorkspace(
  db: Db,
  input: { actorId: string; workspaceId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockActor(tx, input.actorId);
    const locked = await lockWorkspace(tx, input.workspaceId, input.actorId);
    const ctx = await lockedActorContext(tx, locked, input.actorId);
    assertCan('deleteWorkspace', ctx, locked.access);
    await tx
      .update(workspace)
      .set({ deletedAt: sql`now()` })
      .where(eq(workspace.id, input.workspaceId));
    await clearActiveWorkspace(tx, input.workspaceId);
  });
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
}

/** A live (not soft-deleted) workspace by id. Membership is the caller's check. */
export async function findLiveWorkspace(
  db: Db,
  workspaceId: string,
): Promise<WorkspaceSummary | undefined> {
  const [row] = await db
    .select({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      logo: workspace.logo,
    })
    .from(workspace)
    .where(and(eq(workspace.id, workspaceId), isNull(workspace.deletedAt)));
  return row;
}

/** Whether a workspace exists and isn't soft-deleted. */
export async function isLiveWorkspace(db: Db, workspaceId: string): Promise<boolean> {
  const [row] = await db
    .select({ deletedAt: workspace.deletedAt })
    .from(workspace)
    .where(eq(workspace.id, workspaceId));
  return row !== undefined && row.deletedAt === null;
}

// ---------------------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------------------

export interface WorkspaceMember {
  userId: string;
  name: string | null;
  email: string;
  image: string | null;
  role: Role;
  joinedAt: Date;
}

const ROLE_ORDER = sql`case ${membership.role} when 'owner' then 0 when 'admin' then 1 when 'member' then 2 else 3 end`;

/** Members of a workspace: owners first, then by name. The caller checks the actor may see them. */
export async function listMembers(db: Db, workspaceId: string): Promise<WorkspaceMember[]> {
  return db
    .select({
      userId: membership.userId,
      name: user.name,
      email: user.email,
      image: user.image,
      role: membership.role,
      joinedAt: membership.createdAt,
    })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(eq(membership.workspaceId, workspaceId))
    .orderBy(ROLE_ORDER, asc(user.name), asc(user.email));
}

export type InviteState = 'pending' | 'expired' | 'accepted' | 'rejected' | 'canceled';

/** What an invitation looks like to people: a pending one past its expiry is `expired`. */
export function inviteState(
  invitation: { status: string; expiresAt: Date },
  now: Date = new Date(),
): InviteState {
  if (invitation.status === 'pending') return invitation.expiresAt <= now ? 'expired' : 'pending';
  if (invitation.status === 'accepted' || invitation.status === 'rejected') {
    return invitation.status;
  }
  return 'canceled';
}

export interface PendingInvite {
  id: string;
  email: string;
  role: Role;
  state: 'pending' | 'expired';
  expiresAt: Date;
  invitedBy: string;
  createdAt: Date;
}

/** Invitations still waiting for an answer (including expired ones, which can be resent), newest first. */
export async function listPendingInvites(db: Db, workspaceId: string): Promise<PendingInvite[]> {
  const rows = await db
    .select({
      id: invite.id,
      email: invite.email,
      role: invite.role,
      status: invite.status,
      expiresAt: invite.expiresAt,
      createdAt: invite.createdAt,
      inviterName: user.name,
      inviterEmail: user.email,
    })
    .from(invite)
    .innerJoin(user, eq(user.id, invite.inviterId))
    .where(and(eq(invite.workspaceId, workspaceId), eq(invite.status, 'pending')))
    .orderBy(desc(invite.createdAt));
  const now = new Date();
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    state: inviteState(r, now) === 'expired' ? 'expired' : 'pending',
    expiresAt: r.expiresAt,
    invitedBy: r.inviterName?.trim() || r.inviterEmail,
    createdAt: r.createdAt,
  }));
}

export interface InviteDetails {
  id: string;
  token: string;
  email: string;
  role: Role;
  state: InviteState;
  expiresAt: Date;
  workspace: { id: string; name: string; logo: string | null };
  inviter: { name: string; email: string };
}

/**
 * The invitation behind an `/invite/<token>` link, or `undefined` for an unknown token or a deleted
 * workspace. The token is the secret; accepting additionally needs the invited, verified email.
 */
export async function findInviteByToken(db: Db, token: string): Promise<InviteDetails | undefined> {
  if (token.length < 16 || token.length > 128) return undefined;
  const [row] = await db
    .select({
      id: invite.id,
      token: invite.token,
      email: invite.email,
      role: invite.role,
      status: invite.status,
      expiresAt: invite.expiresAt,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceLogo: workspace.logo,
      workspaceDeletedAt: workspace.deletedAt,
      inviterName: user.name,
      inviterEmail: user.email,
    })
    .from(invite)
    .innerJoin(workspace, eq(workspace.id, invite.workspaceId))
    .innerJoin(user, eq(user.id, invite.inviterId))
    .where(eq(invite.token, token));
  if (!row || row.workspaceDeletedAt !== null) return undefined;
  return {
    id: row.id,
    token: row.token,
    email: row.email,
    role: row.role,
    state: inviteState(row),
    expiresAt: row.expiresAt,
    workspace: { id: row.workspaceId, name: row.workspaceName, logo: row.workspaceLogo },
    inviter: { name: row.inviterName?.trim() || row.inviterEmail, email: row.inviterEmail },
  };
}

/**
 * For an accept that failed: whether the invitation has in fact been honoured — `userId` is the invited
 * (verified) address and already a member of that live workspace. That happens when they got in another
 * way a moment earlier (an owner approved their request to join while they were accepting): Better Auth's
 * accept then fails on the one-membership-per-person index. The invitation is marked accepted (if it still
 * says pending) and the workspace id is returned so the caller can carry on as if the accept had worked;
 * `undefined` when the failure was a real one.
 */
export async function inviteAlreadyHonoured(
  db: Db,
  input: { invitationId: string; userId: string },
): Promise<string | undefined> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ workspaceId: invite.workspaceId, email: invite.email, status: invite.status })
      .from(invite)
      .where(eq(invite.id, input.invitationId))
      .for('update');
    if (!row || (row.status !== 'pending' && row.status !== 'accepted')) return undefined;
    const [me] = await tx
      .select({ email: user.email, emailVerified: user.emailVerified })
      .from(user)
      .where(eq(user.id, input.userId));
    if (!me?.emailVerified || me.email.toLowerCase() !== row.email.toLowerCase()) return undefined;
    const [member] = await tx
      .select({ id: membership.id })
      .from(membership)
      .innerJoin(workspace, eq(workspace.id, membership.workspaceId))
      .where(
        and(
          eq(membership.workspaceId, row.workspaceId),
          eq(membership.userId, input.userId),
          isNull(workspace.deletedAt),
        ),
      );
    if (!member) return undefined;
    if (row.status === 'pending') {
      await tx
        .update(invite)
        .set({ status: 'accepted', acceptedAt: sql`now()` })
        .where(eq(invite.id, input.invitationId));
    }
    return row.workspaceId;
  });
}

/** An invitation by id with its workspace (for resend/revoke; the caller checks permissions). */
export async function findInvite(db: Db, invitationId: string) {
  const [row] = await db
    .select({
      id: invite.id,
      workspaceId: invite.workspaceId,
      email: invite.email,
      role: invite.role,
      status: invite.status,
      expiresAt: invite.expiresAt,
    })
    .from(invite)
    .where(eq(invite.id, invitationId));
  return row;
}

/** The invite link token for an invitation id (for the invitation email). */
export async function inviteTokenFor(db: Db, invitationId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ token: invite.token })
    .from(invite)
    .where(eq(invite.id, invitationId));
  return row?.token;
}
