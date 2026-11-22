'use server';

import { refresh } from 'next/cache';
import { headers } from 'next/headers';

import { operationContext } from '../operation-context';
import * as operations from '../operations/workspaces';
import { requireSession } from '../session';

export type ActionResult = { ok: true; workspaceId: string } | { ok: false; error: string };

export async function switchWorkspace(workspaceId: string): Promise<ActionResult> {
  const { user } = await requireSession();
  const result = await operations.switchWorkspace(
    operationContext(user, await headers()),
    workspaceId,
  );
  if (!result.ok) return { ok: false, error: result.error };
  refresh();
  return result;
}

export async function createWorkspace(name: string): Promise<ActionResult> {
  const { user } = await requireSession();
  const result = await operations.createWorkspace(operationContext(user, await headers()), name);
  if (!result.ok) return { ok: false, error: result.error };
  refresh();
  return result;
}
