'use server';

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
import {
  isForbiddenError,
  JoinPolicySchema,
  RoleSchema,
  type JoinPolicy,
  type Role,
} from '@oat/core';
import { refresh, revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { getAuth, getAuthConfig, getMailer } from '../auth';
import { getDb } from '../db';
import { requireSession } from '../session';

/*
 * Joining a workspace by email domain (D-36): the join screen's actions (join, ask, create my own) and the
 * owner/admin side (policy, domains, deciding requests). Every action: session → input validation → the
 * `@oat/auth` joining function, which decides with `@oat/core` on rows read under a lock.
 *
 * None of them takes an email address or a domain to *match* or *add*: who the caller is, whether their
 * email is verified and which domain it is on all come from the user row on the server. (`removeDomain`
 * takes a domain, as the key of the row to delete in a workspace the caller manages.)
 */

export type JoinActionResult = { ok: true } | { ok: false; error: string };

const Id = z.string().min(1).max(100);

const NOT_OPEN = 'That workspace isn’t open to you.';
const FORBIDDEN = 'Only owners and admins can do that.';
const NOT_FOUND = 'That workspace or request no longer exists.';

function failure(error: unknown, fallback: string, notFound = NOT_FOUND): JoinActionResult {
  if (isForbiddenError(error)) return { ok: false, error: FORBIDDEN };
  if (isNotFoundError(error)) return { ok: false, error: notFound };
  if (isJoinRequestDecidedError(error)) {
    return { ok: false, error: `Someone already ${error.decided} this request.` };
  }
  console.error(fallback, error);
  return { ok: false, error: fallback };
}

/** Makes the workspace the user just got into the active one, and goes Home in it. */
async function openWorkspace(workspaceId: string): Promise<never> {
  await getAuth().api.setActiveOrganization({
    body: { organizationId: workspaceId },
    headers: await headers(),
  });
  // The shared (app) layout (switcher) must re-render on the way to Home, not just the page.
  revalidatePath('/', 'layout');
  redirect('/home');
}

// ---------------------------------------------------------------------------------------------------
// The join screen
// ---------------------------------------------------------------------------------------------------

/** Joins an auto-join workspace as a member (verified email on one of its domains) and opens it. */
export async function joinWorkspace(workspaceId: string): Promise<JoinActionResult> {
  const { user } = await requireSession();
  const id = Id.safeParse(workspaceId);
  if (!id.success) return { ok: false, error: NOT_OPEN };
  try {
    await join(getDb(), { userId: user.id, workspaceId: id.data });
  } catch (error) {
    return failure(error, 'Couldn’t join the workspace.', NOT_OPEN);
  }
  return openWorkspace(id.data);
}

/** Asks to join a request-access workspace; its owners and admins are emailed (once per request). */
export async function requestAccess(workspaceId: string): Promise<JoinActionResult> {
  const { user } = await requireSession();
  const id = Id.safeParse(workspaceId);
  if (!id.success) return { ok: false, error: NOT_OPEN };
  try {
    const { notice } = await requestToJoin(getDb(), { userId: user.id, workspaceId: id.data });
    if (notice) await sendJoinRequestEmails(getMailer(), getAuthConfig().baseURL, notice);
  } catch (error) {
    return failure(error, 'Couldn’t send the request.', NOT_OPEN);
  }
  refresh();
  return { ok: true };
}

/**
 * "Create my own workspace": the user's first workspace, made although they could join one. Only ever
 * touches the session user (a user who already has a workspace just goes Home).
 */
export async function createMyWorkspace(): Promise<JoinActionResult> {
  const { user } = await requireSession();
  let workspaceId: string;
  try {
    ({ workspaceId } = await createOwnWorkspace(getDb(), user.id));
  } catch (error) {
    return failure(error, 'Couldn’t create your workspace.');
  }
  return openWorkspace(workspaceId);
}

// ---------------------------------------------------------------------------------------------------
// Join settings (owners/admins)
// ---------------------------------------------------------------------------------------------------

/** Sets who can join without an invitation. */
export async function setJoinPolicy(input: {
  workspaceId: string;
  policy: JoinPolicy;
}): Promise<JoinActionResult> {
  const { user } = await requireSession();
  const parsed = z.object({ workspaceId: Id, policy: JoinPolicySchema }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Pick one of the options.' };
  try {
    await setPolicy(getDb(), { actorId: user.id, ...parsed.data });
  } catch (error) {
    return failure(error, 'Couldn’t save the setting.');
  }
  refresh();
  return { ok: true };
}

/**
 * Allows the caller's own email domain. There is no domain argument on purpose: the server reads it from
 * the caller's verified address, and refuses public mailbox domains.
 */
export async function allowMyDomain(workspaceId: string): Promise<JoinActionResult> {
  const { user } = await requireSession();
  const id = Id.safeParse(workspaceId);
  if (!id.success) return { ok: false, error: NOT_FOUND };
  try {
    await addOwnDomain(getDb(), { actorId: user.id, workspaceId: id.data });
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
  refresh();
  return { ok: true };
}

/** Stops allowing a domain. People who already joined stay. */
export async function removeAllowedDomain(input: {
  workspaceId: string;
  domain: string;
}): Promise<JoinActionResult> {
  const { user } = await requireSession();
  const parsed = z.object({ workspaceId: Id, domain: z.string().min(1).max(253) }).safeParse(input);
  if (!parsed.success) return { ok: false, error: NOT_FOUND };
  try {
    await removeDomain(getDb(), { actorId: user.id, ...parsed.data });
  } catch (error) {
    return failure(error, 'Couldn’t remove the domain.');
  }
  refresh();
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------
// Requests to join (owners/admins)
// ---------------------------------------------------------------------------------------------------

async function decide(
  requestId: string,
  decision: { approve: Role } | 'decline',
): Promise<JoinActionResult> {
  const { user } = await requireSession();
  const id = Id.safeParse(requestId);
  if (!id.success) return { ok: false, error: NOT_FOUND };
  try {
    const { notice } = await decideJoinRequest(getDb(), {
      actorId: user.id,
      requestId: id.data,
      decision,
    });
    await sendJoinDecisionEmail(getMailer(), getAuthConfig().baseURL, notice);
  } catch (error) {
    return failure(error, 'Couldn’t save the decision.');
  }
  refresh();
  return { ok: true };
}

/** Approves a request with a role (at most the approver's own); the requester becomes a member and is told. */
export async function approveJoinRequest(input: {
  requestId: string;
  role: Role;
}): Promise<JoinActionResult> {
  await requireSession();
  const role = RoleSchema.safeParse(input?.role);
  if (!role.success) return { ok: false, error: 'Pick a role.' };
  return decide(input.requestId, { approve: role.data });
}

/** Declines a request; the requester is told and can't ask this workspace again. */
export async function declineJoinRequest(requestId: string): Promise<JoinActionResult> {
  return decide(requestId, 'decline');
}
