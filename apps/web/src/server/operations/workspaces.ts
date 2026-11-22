import { workspaceSlug } from '@oat/auth';
import { WorkspaceId, WorkspaceName } from '@oat/services/dto/workspaces';

import type { OperationContext } from '../operation-context';

export type ActionResult =
  { ok: true; workspaceId: string } | { ok: false; error: string; status?: number };

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
export async function switchWorkspace(
  context: OperationContext,
  workspaceId: string,
): Promise<ActionResult> {
  const id = WorkspaceId.safeParse(workspaceId);
  if (!id.success) return { ok: false, error: 'Unknown workspace.' };
  try {
    await context.auth.api.setActiveOrganization({
      body: { organizationId: id.data },
      headers: context.headers,
    });
  } catch (error) {
    return { ok: false, error: message(error, 'Couldn’t switch workspace.') };
  }
  return { ok: true, workspaceId: id.data };
}

/** Creates a workspace owned by the current user and switches to it. */
export async function createWorkspace(
  context: OperationContext,
  name: string,
): Promise<ActionResult> {
  const parsed = WorkspaceName.safeParse(name);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]!.message };
  const requestHeaders = context.headers;
  try {
    const org = await context.auth.api.createOrganization({
      body: { name: parsed.data, slug: workspaceSlug(parsed.data) },
      headers: requestHeaders,
    });
    if (!org) return { ok: false, error: 'Couldn’t create the workspace.' };
    await context.auth.api.setActiveOrganization({
      body: { organizationId: org.id },
      headers: requestHeaders,
    });
    return { ok: true, workspaceId: org.id };
  } catch (error) {
    return { ok: false, error: message(error, 'Couldn’t create the workspace.') };
  }
}
