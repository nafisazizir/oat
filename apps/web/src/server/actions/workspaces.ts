'use server';

import { workspaceSlug } from '@oat/auth';
import { refresh } from 'next/cache';
import { headers } from 'next/headers';
import { z } from 'zod';

import { getAuth } from '../auth';
import { requireSession } from '../session';

export type ActionResult = { ok: true; workspaceId: string } | { ok: false; error: string };

const WorkspaceId = z.string().min(1).max(100);
const WorkspaceName = z
  .string()
  .trim()
  .min(1, 'Give the workspace a name.')
  .max(60, 'Keep the name under 60 characters.');

function message(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'body' in error) {
    const body = (error as { body?: { message?: unknown } }).body;
    if (typeof body?.message === 'string') return body.message;
  }
  return fallback;
}

/**
 * Makes `workspaceId` the session's active workspace. Better Auth checks membership (a workspace the
 * user isn't in is refused).
 */
export async function switchWorkspace(workspaceId: string): Promise<ActionResult> {
  await requireSession();
  const id = WorkspaceId.safeParse(workspaceId);
  if (!id.success) return { ok: false, error: 'Unknown workspace.' };
  try {
    await getAuth().api.setActiveOrganization({
      body: { organizationId: id.data },
      headers: await headers(),
    });
  } catch (error) {
    return { ok: false, error: message(error, 'Couldn’t switch workspace.') };
  }
  refresh();
  return { ok: true, workspaceId: id.data };
}

/** Creates a workspace owned by the current user and switches to it. */
export async function createTeamWorkspace(name: string): Promise<ActionResult> {
  await requireSession();
  const parsed = WorkspaceName.safeParse(name);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]!.message };
  const requestHeaders = await headers();
  try {
    const org = await getAuth().api.createOrganization({
      body: { name: parsed.data, slug: workspaceSlug(parsed.data) },
      headers: requestHeaders,
    });
    if (!org) return { ok: false, error: 'Couldn’t create the workspace.' };
    await getAuth().api.setActiveOrganization({
      body: { organizationId: org.id },
      headers: requestHeaders,
    });
    refresh();
    return { ok: true, workspaceId: org.id };
  } catch (error) {
    return { ok: false, error: message(error, 'Couldn’t create the workspace.') };
  }
}
