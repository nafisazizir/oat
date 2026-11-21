/**
 * Getting into a workspace without an invitation (D-36): a workspace lists email domains and a join policy;
 * someone whose **verified** email is on a listed domain may ask to join (`request`: an owner/admin
 * approves and picks the role, or declines) or join straight away as a member (`auto_join`). An
 * `invite_only` workspace is never shown to them. This is also where a signed-in user without a workspace
 * gets one: {@link ensureFirstWorkspace}.
 *
 * Every decision comes from `@oat/core` (`joinOption`, `assertCan`). Nothing here takes an email address or
 * a domain to match from its caller: the person is always the user row, read inside the transaction.
 *
 * Locks, in this order: the acting user's advisory lock (`lockUser`: one "which workspaces am I in"
 * decision at a time), then the workspace row `FOR UPDATE` (the same per-workspace mutex `members.ts` uses,
 * so a join, a decision, a policy change and a soft delete of one workspace run one after the other). Two
 * joins by one person, or two owners deciding one request, therefore can't both act; the unique indexes
 * (`membership_workspace_user_uq`, `join_request_one_pending_uq`) are the backstop.
 */
import {
  assertCan,
  canInvite,
  canRequestToJoin,
  createPermissionContext,
  type EmailIdentity,
  emailDomain,
  isPublicMailboxDomain,
  type JoinableWorkspaceAccess,
  type JoinOption,
  joinOption,
  type JoinPolicy,
  type JoinRequestStatus,
  normalizeDomain,
  type Role,
  roleIn,
} from '@oat/core';
import {
  type Db,
  invite,
  joinRequest,
  membership,
  user,
  workspace,
  workspaceDomain,
} from '@oat/db';
import { and, asc, count, desc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';

import type { EmailMessage, Mailer } from './email.ts';
import { joinDecisionEmail, joinRequestEmail } from './email.ts';
import { contextOf, lockWorkspace, NotFoundError } from './members.ts';
import {
  createWorkspaceFor,
  liveMemberships,
  loadPermissionContext,
  lockUser,
  type Tx,
} from './workspaces.ts';

/** Most workspaces offered on the join screen (a domain rarely has more than a handful). */
const MAX_JOINABLE = 20;

/** The request was already approved or declined (by someone else, a moment ago). */
export class JoinRequestDecidedError extends Error {
  override readonly name = 'JoinRequestDecidedError';
  readonly code = 'CONFLICT';
  readonly status = 409;
  constructor(readonly decided: Exclude<JoinRequestStatus, 'pending'>) {
    super(`This request was already ${decided}.`);
  }
}

export function isJoinRequestDecidedError(error: unknown): error is JoinRequestDecidedError {
  return error instanceof JoinRequestDecidedError;
}

type Person = EmailIdentity & { id: string; name: string | null };

async function findPerson(db: Db | Tx, userId: string): Promise<Person | undefined> {
  const [row] = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
    })
    .from(user)
    .where(eq(user.id, userId));
  return row;
}

const displayName = (person: { name: string | null; email: string }) =>
  person.name?.trim() || person.email;

// ---------------------------------------------------------------------------------------------------------
// What a person can join
// ---------------------------------------------------------------------------------------------------------

/**
 * The domain `person` could list on a workspace they manage — their own, if their email is verified and
 * not on a public mailbox domain — or why there is none. For the settings UI; `canAddDomain` decides.
 */
export function listableDomain(
  person: EmailIdentity,
): { domain: string; reason?: undefined } | { domain: null; reason: 'unverified' | 'public' } {
  const domain = emailDomain(person.email);
  if (!person.emailVerified || domain === null) return { domain: null, reason: 'unverified' };
  if (isPublicMailboxDomain(domain)) return { domain: null, reason: 'public' };
  return { domain };
}

export interface JoinableWorkspace {
  id: string;
  name: string;
  logo: string | null;
  memberCount: number;
  /** `join` = one click; `request` = ask an owner/admin; `requested` = their answer is pending. */
  option: JoinOption;
}

export interface InviteChoice {
  /** The invite's secret (what `/invite/<token>` carries); only ever handed to the invited address. */
  token: string;
  role: Role;
  workspace: { id: string; name: string; logo: string | null };
  invitedBy: string;
}

export interface JoinChoices {
  /** Invitations to the person's address that can still be accepted. */
  invites: InviteChoice[];
  /** Workspaces that list the domain of their verified email and let such people in or ask. */
  workspaces: JoinableWorkspace[];
}

/** Whether there is anything to choose from. */
export const hasJoinChoices = (choices: JoinChoices): boolean =>
  choices.invites.length + choices.workspaces.length > 0;

async function pendingInvitesFor(db: Db | Tx, me: Person): Promise<InviteChoice[]> {
  // Accepting needs a verified address (Better Auth and `acceptInvite` both check).
  if (!me.emailVerified) return [];
  const rows = await db
    .select({
      token: invite.token,
      role: invite.role,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceLogo: workspace.logo,
      inviterId: invite.inviterId,
      inviterName: user.name,
      inviterEmail: user.email,
      inviterRole: membership.role,
    })
    .from(invite)
    .innerJoin(workspace, eq(workspace.id, invite.workspaceId))
    .innerJoin(user, eq(user.id, invite.inviterId))
    .leftJoin(
      membership,
      and(eq(membership.workspaceId, invite.workspaceId), eq(membership.userId, invite.inviterId)),
    )
    .where(
      and(
        sql`lower(${invite.email}) = lower(${me.email})`,
        eq(invite.status, 'pending'),
        gt(invite.expiresAt, sql`now()`),
        isNull(workspace.deletedAt),
      ),
    )
    .orderBy(asc(invite.createdAt), asc(invite.id));
  return (
    rows
      // An invite only carries its sender's authority while they still have it (as when accepting).
      .filter((r) => {
        if (!r.inviterRole) return false;
        const ctx = createPermissionContext({
          userId: r.inviterId,
          memberships: [{ workspaceId: r.workspaceId, userId: r.inviterId, role: r.inviterRole }],
        });
        return canInvite(ctx, { id: r.workspaceId }, r.role);
      })
      .map((r) => ({
        token: r.token,
        role: r.role,
        workspace: { id: r.workspaceId, name: r.workspaceName, logo: r.workspaceLogo },
        invitedBy: displayName({ name: r.inviterName, email: r.inviterEmail }),
      }))
  );
}

/** The status of the person's latest request to each of `workspaceIds`. */
async function latestRequests(
  db: Db | Tx,
  userId: string,
  workspaceIds: readonly string[],
): Promise<Map<string, JoinRequestStatus>> {
  const latest = new Map<string, JoinRequestStatus>();
  if (workspaceIds.length === 0) return latest;
  const rows = await db
    .select({ workspaceId: joinRequest.workspaceId, status: joinRequest.status })
    .from(joinRequest)
    .where(and(eq(joinRequest.userId, userId), inArray(joinRequest.workspaceId, [...workspaceIds])))
    .orderBy(desc(joinRequest.createdAt), desc(joinRequest.id));
  for (const row of rows) {
    if (!latest.has(row.workspaceId)) latest.set(row.workspaceId, row.status);
  }
  return latest;
}

async function joinableWorkspacesFor(db: Db | Tx, me: Person): Promise<JoinableWorkspace[]> {
  const { domain } = listableDomain(me);
  if (domain === null) return [];
  const rows = await db
    .select({
      id: workspace.id,
      name: workspace.name,
      logo: workspace.logo,
      joinPolicy: workspace.joinPolicy,
      deletedAt: workspace.deletedAt,
    })
    .from(workspaceDomain)
    .innerJoin(workspace, eq(workspace.id, workspaceDomain.workspaceId))
    .where(
      and(
        eq(workspaceDomain.domain, domain),
        isNull(workspace.deletedAt),
        ne(workspace.joinPolicy, 'invite_only'),
      ),
    )
    .orderBy(asc(sql`lower(${workspace.name})`), asc(workspace.id))
    .limit(MAX_JOINABLE * 2);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [ctx, previous, counts] = await Promise.all([
    loadPermissionContext(db, me.id),
    latestRequests(db, me.id, ids),
    db
      .select({ workspaceId: membership.workspaceId, n: count() })
      .from(membership)
      .where(inArray(membership.workspaceId, ids))
      .groupBy(membership.workspaceId),
  ]);
  const memberCount = new Map(counts.map((c) => [c.workspaceId, Number(c.n)]));
  const joinable: JoinableWorkspace[] = [];
  for (const row of rows) {
    const access: JoinableWorkspaceAccess = {
      id: row.id,
      joinPolicy: row.joinPolicy,
      domains: [domain],
      deletedAt: row.deletedAt,
    };
    const option = joinOption(ctx, access, me, previous.get(row.id) ?? null);
    if (option === null) continue;
    joinable.push({
      id: row.id,
      name: row.name,
      logo: row.logo,
      memberCount: memberCount.get(row.id) ?? 0,
      option,
    });
  }
  return joinable.slice(0, MAX_JOINABLE);
}

async function joinChoicesFor(db: Db | Tx, me: Person): Promise<JoinChoices> {
  const [invites, workspaces] = await Promise.all([
    pendingInvitesFor(db, me),
    joinableWorkspacesFor(db, me),
  ]);
  // A workspace that invited them is offered once, as the invitation.
  const invited = new Set(invites.map((i) => i.workspace.id));
  return { invites, workspaces: workspaces.filter((w) => !invited.has(w.id)) };
}

/**
 * What the signed-in user could join right now: invitations to their address and workspaces that list the
 * domain of their verified email (never `invite_only` ones, never for a public mailbox domain). Empty for an
 * unknown user.
 */
export async function getJoinChoices(db: Db, userId: string): Promise<JoinChoices> {
  const me = await findPerson(db, userId);
  return me ? joinChoicesFor(db, me) : { invites: [], workspaces: [] };
}

// ---------------------------------------------------------------------------------------------------------
// The first workspace
// ---------------------------------------------------------------------------------------------------------

/** What {@link ensureFirstWorkspace} found or did. */
export type FirstWorkspace =
  /** The user is in a workspace: an existing one (their oldest), or the one just created for them. */
  | { workspaceId: string; created: boolean }
  /** No workspace yet, but there is one they could join or an invitation to answer: nothing was created. */
  | { workspaceId: undefined; created: false; choices: true };

async function firstWorkspace(
  db: Db,
  userId: string,
  evenWithChoices: boolean,
): Promise<FirstWorkspace> {
  return db.transaction(async (tx) => {
    const me = await lockUser(tx, userId);
    if (!me) throw new Error('ensureFirstWorkspace: unknown user');
    const [existing] = await liveMemberships(tx, userId).limit(1);
    if (existing) return { workspaceId: existing.workspaceId, created: false };
    if (!evenWithChoices && hasJoinChoices(await joinChoicesFor(tx, me))) {
      return { workspaceId: undefined, created: false, choices: true };
    }
    return { workspaceId: await createWorkspaceFor(tx, me), created: true };
  });
}

/**
 * Makes sure a signed-in user is not left without a workspace (D-36). Does nothing when they are a member
 * of a live workspace, or when they have a choice to make first — an invitation to their address, or a
 * workspace their verified email's domain lets them join or ask to join ({@link getJoinChoices}); the web
 * sends them to the join screen, where "Create my own workspace" is {@link createOwnWorkspace}. Otherwise
 * creates an ordinary workspace named `firstWorkspaceName` with them as `owner`.
 *
 * Safe to call concurrently and repeatedly: the check and the insert run under `lockUser`, so two
 * sign-ins at once create exactly one workspace.
 *
 * Runs on our own connection, so it must only be called once the user row is committed (Better Auth runs
 * `user.create.after` hooks after the transaction).
 */
export function ensureFirstWorkspace(db: Db, userId: string): Promise<FirstWorkspace> {
  return firstWorkspace(db, userId, false);
}

/**
 * "Create my own workspace" on the join screen: like {@link ensureFirstWorkspace}, but creates the workspace
 * even though there are workspaces to join. Still only for a user without one (it returns the existing one
 * otherwise), so pressing it twice creates one workspace.
 */
export async function createOwnWorkspace(
  db: Db,
  userId: string,
): Promise<{ workspaceId: string; created: boolean }> {
  const result = await firstWorkspace(db, userId, true);
  if (result.workspaceId === undefined) throw new Error('createOwnWorkspace: nothing created');
  return result;
}

// ---------------------------------------------------------------------------------------------------------
// Joining and asking to join
// ---------------------------------------------------------------------------------------------------------

/**
 * The workspace row, locked for the rest of `tx`, as the join rules see it. Throws {@link NotFoundError}
 * for an unknown or soft-deleted workspace (never joinable).
 */
async function lockJoinable(
  tx: Tx,
  workspaceId: string,
): Promise<JoinableWorkspaceAccess & { name: string }> {
  const [ws] = await tx
    .select({
      id: workspace.id,
      name: workspace.name,
      joinPolicy: workspace.joinPolicy,
      deletedAt: workspace.deletedAt,
    })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .for('update');
  if (!ws || ws.deletedAt !== null) throw new NotFoundError('Workspace not found.');
  // After the mutex: sees every domain change committed before we got it.
  const domains = await tx
    .select({ domain: workspaceDomain.domain })
    .from(workspaceDomain)
    .where(eq(workspaceDomain.workspaceId, workspaceId));
  return { ...ws, domains: domains.map((d) => d.domain) };
}

/**
 * Joins an `auto_join` workspace as `member` (`@oat/core` `autoJoin`: verified email on a listed, non-public
 * domain; live workspace). Idempotent: someone who is already a member stays as they are. A workspace the
 * person may not join looks exactly like one that doesn't exist ({@link NotFoundError}), so ids can't be
 * probed.
 */
export async function joinWorkspace(
  db: Db,
  input: { userId: string; workspaceId: string },
): Promise<{ joined: boolean }> {
  return db.transaction(async (tx) => {
    const me = await lockUser(tx, input.userId);
    if (!me) throw new NotFoundError('Workspace not found.');
    const ws = await lockJoinable(tx, input.workspaceId);
    const ctx = await loadPermissionContext(tx, me.id);
    if (roleIn(ctx, ws.id) !== undefined) return { joined: false };
    try {
      assertCan('autoJoin', ctx, ws, me);
    } catch {
      throw new NotFoundError('Workspace not found.');
    }
    const inserted = await tx
      .insert(membership)
      .values({ workspaceId: ws.id, userId: me.id, role: 'member' })
      .onConflictDoNothing({ target: [membership.workspaceId, membership.userId] })
      .returning({ id: membership.id });
    await settlePendingRequests(tx, ws.id, me.id, 'member');
    return { joined: inserted.length > 0 };
  });
}

/**
 * A person who became a member some other way (auto-join, an accepted invitation) no longer has a request
 * waiting: it is recorded as approved, with nobody as the decider.
 */
export async function settlePendingRequests(
  db: Db | Tx,
  workspaceId: string,
  userId: string,
  role: Role,
): Promise<void> {
  await db
    .update(joinRequest)
    .set({ status: 'approved', decidedAt: sql`now()`, role })
    .where(
      and(
        eq(joinRequest.workspaceId, workspaceId),
        eq(joinRequest.userId, userId),
        eq(joinRequest.status, 'pending'),
      ),
    );
}

/** Who to tell about a new request. */
export interface JoinRequestNotice {
  workspace: { id: string; name: string };
  requester: { name: string; email: string };
  /** Addresses of the workspace's owners and admins. */
  recipients: string[];
}

/**
 * Asks to join a `request` workspace (`@oat/core` `requestToJoin`). At most one pending request per person
 * per workspace: asking again while one is waiting returns it (`created: false`, nobody is notified again),
 * and after a decline there is no asking again. As with {@link joinWorkspace}, "may not" looks like "not
 * found". `notice` says whom to email ({@link sendJoinRequestEmails}), after the transaction committed.
 */
export async function requestToJoin(
  db: Db,
  input: { userId: string; workspaceId: string },
): Promise<{ requestId: string; created: boolean; notice?: JoinRequestNotice }> {
  return db.transaction(async (tx) => {
    const me = await lockUser(tx, input.userId);
    if (!me) throw new NotFoundError('Workspace not found.');
    const ws = await lockJoinable(tx, input.workspaceId);
    const ctx = await loadPermissionContext(tx, me.id);
    const [latest] = await tx
      .select({ id: joinRequest.id, status: joinRequest.status })
      .from(joinRequest)
      .where(and(eq(joinRequest.workspaceId, ws.id), eq(joinRequest.userId, me.id)))
      .orderBy(desc(joinRequest.createdAt), desc(joinRequest.id))
      .limit(1);
    if (latest?.status === 'pending' && canRequestToJoin(ctx, ws, me, null)) {
      return { requestId: latest.id, created: false };
    }
    try {
      assertCan('requestToJoin', ctx, ws, me, latest?.status ?? null);
    } catch {
      throw new NotFoundError('Workspace not found.');
    }
    const [created] = await tx
      .insert(joinRequest)
      .values({ workspaceId: ws.id, userId: me.id })
      .returning({ id: joinRequest.id });
    if (!created) throw new Error('requestToJoin: request missing after insert');
    const managers = await tx
      .select({ email: user.email })
      .from(membership)
      .innerJoin(user, eq(user.id, membership.userId))
      .where(and(eq(membership.workspaceId, ws.id), inArray(membership.role, ['owner', 'admin'])))
      .orderBy(asc(membership.id));
    return {
      requestId: created.id,
      created: true,
      notice: {
        workspace: { id: ws.id, name: ws.name },
        requester: { name: displayName(me), email: me.email },
        recipients: managers.map((m) => m.email),
      },
    };
  });
}

// ---------------------------------------------------------------------------------------------------------
// Deciding requests (owners/admins)
// ---------------------------------------------------------------------------------------------------------

export type JoinDecision = { approve: Role } | 'decline';

/** Whom to tell about a decision. */
export interface JoinDecisionNotice {
  to: string;
  workspace: { id: string; name: string };
  approved: boolean;
  /** The role granted (approved only). */
  role?: Role;
}

/**
 * Approves (with a role, at most the decider's own) or declines a pending request (`@oat/core`
 * `decideJoinRequest`), on rows read under the workspace lock: two owners deciding at once run one after the
 * other and the second gets {@link JoinRequestDecidedError}; approving twice never makes two memberships.
 * Someone who became a member meanwhile keeps the role they have. A non-member of the request's workspace
 * gets {@link NotFoundError}; a member or viewer `ForbiddenError`.
 */
export async function decideJoinRequest(
  db: Db,
  input: { actorId: string; requestId: string; decision: JoinDecision },
): Promise<{ status: 'approved' | 'declined'; notice: JoinDecisionNotice }> {
  const role = input.decision === 'decline' ? undefined : input.decision.approve;
  return db.transaction(async (tx) => {
    const [found] = await tx
      .select({ workspaceId: joinRequest.workspaceId })
      .from(joinRequest)
      .where(eq(joinRequest.id, input.requestId));
    if (!found) throw new NotFoundError('Request not found.');
    const locked = await lockWorkspace(tx, found.workspaceId, input.actorId);
    const [request] = await tx
      .select({
        id: joinRequest.id,
        workspaceId: joinRequest.workspaceId,
        userId: joinRequest.userId,
        status: joinRequest.status,
      })
      .from(joinRequest)
      .where(eq(joinRequest.id, input.requestId))
      .for('update');
    if (!request) throw new NotFoundError('Request not found.');
    const ctx = contextOf(locked, input.actorId);
    // Whether the actor may decide requests here at all, before saying anything about this one.
    assertCan('decideJoinRequest', ctx, locked.access, { ...request, status: 'pending' }, role);
    if (request.status !== 'pending') throw new JoinRequestDecidedError(request.status);

    if (role !== undefined) {
      await tx
        .insert(membership)
        .values({ workspaceId: request.workspaceId, userId: request.userId, role })
        .onConflictDoNothing({ target: [membership.workspaceId, membership.userId] });
    }
    const status = role === undefined ? 'declined' : 'approved';
    await tx
      .update(joinRequest)
      .set({ status, decidedBy: input.actorId, decidedAt: sql`now()`, role: role ?? null })
      .where(eq(joinRequest.id, request.id));

    const [[requester], [ws]] = await Promise.all([
      tx.select({ email: user.email }).from(user).where(eq(user.id, request.userId)),
      tx.select({ name: workspace.name }).from(workspace).where(eq(workspace.id, locked.access.id)),
    ]);
    if (!requester || !ws) throw new Error('decideJoinRequest: requester or workspace missing');
    return {
      status,
      notice: {
        to: requester.email,
        workspace: { id: locked.access.id, name: ws.name },
        approved: role !== undefined,
        ...(role === undefined ? {} : { role }),
      },
    };
  });
}

export interface PendingJoinRequest {
  id: string;
  userId: string;
  name: string | null;
  email: string;
  image: string | null;
  requestedAt: Date;
}

/** Requests waiting for a decision, oldest first. The caller checks the actor may see them. */
export async function listJoinRequests(db: Db, workspaceId: string): Promise<PendingJoinRequest[]> {
  return db
    .select({
      id: joinRequest.id,
      userId: joinRequest.userId,
      name: user.name,
      email: user.email,
      image: user.image,
      requestedAt: joinRequest.createdAt,
    })
    .from(joinRequest)
    .innerJoin(user, eq(user.id, joinRequest.userId))
    .where(and(eq(joinRequest.workspaceId, workspaceId), eq(joinRequest.status, 'pending')))
    .orderBy(asc(joinRequest.createdAt), asc(joinRequest.id));
}

// ---------------------------------------------------------------------------------------------------------
// Join settings (owners/admins)
// ---------------------------------------------------------------------------------------------------------

export interface JoinSettings {
  policy: JoinPolicy;
  /** Allowed email domains, by name. */
  domains: string[];
}

/** A workspace's join policy and allowed domains. The caller checks the actor may see them. */
export async function getJoinSettings(db: Db, workspaceId: string): Promise<JoinSettings> {
  const [[ws], domains] = await Promise.all([
    db
      .select({ policy: workspace.joinPolicy })
      .from(workspace)
      .where(eq(workspace.id, workspaceId)),
    db
      .select({ domain: workspaceDomain.domain })
      .from(workspaceDomain)
      .where(eq(workspaceDomain.workspaceId, workspaceId))
      .orderBy(asc(workspaceDomain.domain)),
  ]);
  if (!ws) throw new NotFoundError('Workspace not found.');
  return { policy: ws.policy, domains: domains.map((d) => d.domain) };
}

/** Sets the join policy (`@oat/core` `editJoinSettings`: owners/admins). Pending requests stay decidable. */
export async function setJoinPolicy(
  db: Db,
  input: { actorId: string; workspaceId: string; policy: JoinPolicy },
): Promise<void> {
  await db.transaction(async (tx) => {
    const locked = await lockWorkspace(tx, input.workspaceId, input.actorId);
    assertCan('editJoinSettings', contextOf(locked, input.actorId), locked.access);
    await tx
      .update(workspace)
      .set({ joinPolicy: input.policy })
      .where(eq(workspace.id, input.workspaceId));
  });
}

/**
 * Lists the actor's **own** email domain as an allowed domain of the workspace. There is deliberately no
 * domain parameter: the domain is read from the actor's user row, and `@oat/core` `addDomain` refuses an
 * unverified address and a public mailbox domain. Idempotent.
 */
export async function addOwnDomain(
  db: Db,
  input: { actorId: string; workspaceId: string },
): Promise<{ domain: string }> {
  return db.transaction(async (tx) => {
    const locked = await lockWorkspace(tx, input.workspaceId, input.actorId);
    const actor = await findPerson(tx, input.actorId);
    if (!actor) throw new NotFoundError('Workspace not found.');
    const domain = emailDomain(actor.email) ?? '';
    assertCan('addDomain', contextOf(locked, input.actorId), locked.access, actor, domain);
    await tx
      .insert(workspaceDomain)
      .values({ workspaceId: input.workspaceId, domain, addedBy: input.actorId })
      .onConflictDoNothing();
    return { domain };
  });
}

/** Removes an allowed domain (`@oat/core` `editJoinSettings`); any owner/admin may remove any of them. */
export async function removeDomain(
  db: Db,
  input: { actorId: string; workspaceId: string; domain: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const locked = await lockWorkspace(tx, input.workspaceId, input.actorId);
    assertCan('editJoinSettings', contextOf(locked, input.actorId), locked.access);
    const domain = normalizeDomain(input.domain);
    if (domain === null) return;
    await tx
      .delete(workspaceDomain)
      .where(
        and(eq(workspaceDomain.workspaceId, input.workspaceId), eq(workspaceDomain.domain, domain)),
      );
  });
}

// ---------------------------------------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------------------------------------

/** Where the request email sends owners/admins: the members page (of their active workspace). */
export function joinRequestsUrl(baseURL: string): string {
  return new URL('/settings/workspace/members', baseURL).toString();
}

async function sendAll(mailer: Mailer, messages: EmailMessage[]): Promise<void> {
  const results = await Promise.allSettled(messages.map((message) => mailer.send(message)));
  for (const result of results) {
    // The request or decision already happened; a mail that didn't go out must not undo or fail it.
    if (result.status === 'rejected') console.error('join email not sent', result.reason);
  }
}

/** Tells the workspace's owners and admins that someone asked to join. Never throws. */
export function sendJoinRequestEmails(
  mailer: Mailer,
  baseURL: string,
  notice: JoinRequestNotice,
): Promise<void> {
  return sendAll(
    mailer,
    notice.recipients.map((to) =>
      joinRequestEmail({
        to,
        url: joinRequestsUrl(baseURL),
        workspaceName: notice.workspace.name,
        requesterName: notice.requester.name,
        requesterEmail: notice.requester.email,
      }),
    ),
  );
}

/** Tells the requester that their request was approved or declined. Never throws. */
export function sendJoinDecisionEmail(
  mailer: Mailer,
  baseURL: string,
  notice: JoinDecisionNotice,
): Promise<void> {
  return sendAll(mailer, [
    joinDecisionEmail({
      to: notice.to,
      url: new URL('/home', baseURL).toString(),
      workspaceName: notice.workspace.name,
      approved: notice.approved,
      ...(notice.role === undefined ? {} : { role: notice.role }),
    }),
  ]);
}
