import {
  addOwnDomain,
  createOwnWorkspace,
  decideJoinRequest,
  isJoinRequestDecidedError,
  isNotFoundError,
  joinWorkspace as join,
  removeDomain,
  requestToJoin,
  sendJoinDecisionEmail,
  sendJoinRequestEmails,
  setJoinPolicy as setPolicy,
} from '@oat/auth';
import { isForbiddenError, RoleSchema, type JoinPolicy, type Role } from '@oat/core';
import {
  WorkspaceId as Id,
  JoinPolicyInputSchema,
  RemoveDomainSchema,
} from '@oat/services/dto/workspaces';

import type { OperationContext } from '../operation-context';

/*
 * Joining a workspace by email domain (D-36): the join screen's actions (join, ask, create my own) and the
 * owner/admin side (policy, domains, deciding requests). Every action: session → input validation → the
 * `@oat/auth` joining function, which decides with `@oat/core` on rows read under a lock.
 *
 * None of them takes an email address or a domain to *match* or *add*: who the caller is, whether their
 * email is verified and which domain it is on all come from the user row on the server. (`removeDomain`
 * takes a domain, as the key of the row to delete in a workspace the caller manages.)
 */

export type JoinActionResult = { ok: true } | { ok: false; error: string; status?: number };

const NOT_OPEN = 'That workspace isn’t open to you.';
const FORBIDDEN = 'Only owners and admins can do that.';
const NOT_FOUND = 'That workspace or request no longer exists.';

function failure(error: unknown, fallback: string, notFound = NOT_FOUND): JoinActionResult {
  if (isForbiddenError(error)) return { ok: false, error: FORBIDDEN, status: 403 };
  if (isNotFoundError(error)) return { ok: false, error: notFound, status: 404 };
  if (isJoinRequestDecidedError(error)) {
    return { ok: false, error: `Someone already ${error.decided} this request.` };
  }
  console.error(fallback, error);
  return { ok: false, error: fallback };
}

/** Makes the workspace the user just got into the active one, and goes Home in it. */
async function openWorkspace(
  context: OperationContext,
  workspaceId: string,
): Promise<JoinActionResult> {
  await context.auth.api.setActiveOrganization({
    body: { organizationId: workspaceId },
    headers: context.headers,
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------
// The join screen
// ---------------------------------------------------------------------------------------------------

/** Joins an auto-join workspace as a member (verified email on one of its domains) and opens it. */
export async function joinWorkspace(
  context: OperationContext,
  workspaceId: string,
): Promise<JoinActionResult> {
  const { user } = context;
  const id = Id.safeParse(workspaceId);
  if (!id.success) return { ok: false, error: NOT_OPEN };
  try {
    await join(context.db, { userId: user.id, workspaceId: id.data });
  } catch (error) {
    return failure(error, 'Couldn’t join the workspace.', NOT_OPEN);
  }
  return openWorkspace(context, id.data);
}

/** Asks to join a request-access workspace; its owners and admins are emailed (once per request). */
export async function requestAccess(
  context: OperationContext,
  workspaceId: string,
): Promise<JoinActionResult> {
  const { user } = context;
  const id = Id.safeParse(workspaceId);
  if (!id.success) return { ok: false, error: NOT_OPEN };
  try {
    const { notice } = await requestToJoin(context.db, { userId: user.id, workspaceId: id.data });
    if (notice) await sendJoinRequestEmails(context.mailer, context.baseURL, notice);
  } catch (error) {
    return failure(error, 'Couldn’t send the request.', NOT_OPEN);
  }
  return { ok: true };
}

/**
 * "Create my own workspace": the user's first workspace, made although they could join one. Only ever
 * touches the session user (a user who already has a workspace just goes Home).
 */
export async function createMyWorkspace(context: OperationContext): Promise<JoinActionResult> {
  const { user } = context;
  let workspaceId: string;
  try {
    ({ workspaceId } = await createOwnWorkspace(context.db, user.id));
  } catch (error) {
    return failure(error, 'Couldn’t create your workspace.');
  }
  return openWorkspace(context, workspaceId);
}

// ---------------------------------------------------------------------------------------------------
// Join settings (owners/admins)
// ---------------------------------------------------------------------------------------------------

/** Sets who can join without an invitation. */
export async function setJoinPolicy(
  context: OperationContext,
  input: {
    workspaceId: string;
    policy: JoinPolicy;
  },
): Promise<JoinActionResult> {
  const { user } = context;
  const parsed = JoinPolicyInputSchema.extend({ workspaceId: Id }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Pick one of the options.' };
  try {
    await setPolicy(context.db, { actorId: user.id, ...parsed.data });
  } catch (error) {
    return failure(error, 'Couldn’t save the setting.');
  }
  return { ok: true };
}

/**
 * Allows the caller's own email domain. There is no domain argument on purpose: the server reads it from
 * the caller's verified address, and refuses public mailbox domains.
 */
export async function allowMyDomain(
  context: OperationContext,
  workspaceId: string,
): Promise<JoinActionResult> {
  const { user } = context;
  const id = Id.safeParse(workspaceId);
  if (!id.success) return { ok: false, error: NOT_FOUND, status: 404 };
  try {
    await addOwnDomain(context.db, { actorId: user.id, workspaceId: id.data });
  } catch (error) {
    if (isForbiddenError(error)) {
      return {
        ok: false,
        error:
          'You can only add the domain of your own verified work email, as an owner or admin. Public mail services can’t be added.',
      };
    }
    return failure(error, 'Couldn’t add the domain.');
  }
  return { ok: true };
}

/** Stops allowing a domain. People who already joined stay. */
export async function removeAllowedDomain(
  context: OperationContext,
  input: {
    workspaceId: string;
    domain: string;
  },
): Promise<JoinActionResult> {
  const { user } = context;
  const parsed = RemoveDomainSchema.extend({ workspaceId: Id }).safeParse(input);
  if (!parsed.success) return { ok: false, error: NOT_FOUND, status: 404 };
  try {
    await removeDomain(context.db, { actorId: user.id, ...parsed.data });
  } catch (error) {
    return failure(error, 'Couldn’t remove the domain.');
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------
// Requests to join (owners/admins)
// ---------------------------------------------------------------------------------------------------

async function decide(
  context: OperationContext,
  requestId: string,
  decision: { approve: Role } | 'decline',
): Promise<JoinActionResult> {
  const { user } = context;
  const id = Id.safeParse(requestId);
  if (!id.success) return { ok: false, error: NOT_FOUND, status: 404 };
  try {
    const { notice } = await decideJoinRequest(context.db, {
      actorId: user.id,
      requestId: id.data,
      decision,
    });
    await sendJoinDecisionEmail(context.mailer, context.baseURL, notice);
  } catch (error) {
    return failure(error, 'Couldn’t save the decision.');
  }
  return { ok: true };
}

/** Approves a request with a role (at most the approver's own); the requester becomes a member and is told. */
export async function approveJoinRequest(
  context: OperationContext,
  input: {
    requestId: string;
    role: Role;
  },
): Promise<JoinActionResult> {
  const role = RoleSchema.safeParse(input?.role);
  if (!role.success) return { ok: false, error: 'Pick a role.' };
  return decide(context, input.requestId, { approve: role.data });
}

/** Declines a request; the requester is told and can't ask this workspace again. */
export async function declineJoinRequest(
  context: OperationContext,
  requestId: string,
): Promise<JoinActionResult> {
  return decide(context, requestId, 'decline');
}
