'use server';

import type { JoinPolicy, Role } from '@oat/core';
import { refresh, revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { operationContext } from '../operation-context';
import * as operations from '../operations/joining';
import { requireSession } from '../session';

export type JoinActionResult = { ok: true } | { ok: false; error: string };

export async function joinWorkspace(workspaceId: string): Promise<JoinActionResult> {
  const { user } = await requireSession();
  const result = await operations.joinWorkspace(
    operationContext(user, await headers()),
    workspaceId,
  );
  if (!result.ok) return { ok: false, error: result.error };
  revalidatePath('/', 'layout');
  redirect('/home');
}

export async function requestAccess(workspaceId: string): Promise<JoinActionResult> {
  const { user } = await requireSession();
  const result = await operations.requestAccess(
    operationContext(user, await headers()),
    workspaceId,
  );
  if (!result.ok) return { ok: false, error: result.error };
  refresh();
  return result;
}

export async function createMyWorkspace(): Promise<JoinActionResult> {
  const { user } = await requireSession();
  const result = await operations.createMyWorkspace(operationContext(user, await headers()));
  if (!result.ok) return { ok: false, error: result.error };
  revalidatePath('/', 'layout');
  redirect('/home');
}

export async function setJoinPolicy(input: {
  workspaceId: string;
  policy: JoinPolicy;
}): Promise<JoinActionResult> {
  const { user } = await requireSession();
  const result = await operations.setJoinPolicy(operationContext(user, await headers()), input);
  if (!result.ok) return { ok: false, error: result.error };
  refresh();
  return result;
}

export async function allowMyDomain(workspaceId: string): Promise<JoinActionResult> {
  const { user } = await requireSession();
  const result = await operations.allowMyDomain(
    operationContext(user, await headers()),
    workspaceId,
  );
  if (!result.ok) return { ok: false, error: result.error };
  refresh();
  return result;
}

export async function removeAllowedDomain(input: {
  workspaceId: string;
  domain: string;
}): Promise<JoinActionResult> {
  const { user } = await requireSession();
  const result = await operations.removeAllowedDomain(
    operationContext(user, await headers()),
    input,
  );
  if (!result.ok) return { ok: false, error: result.error };
  refresh();
  return result;
}

export async function approveJoinRequest(input: {
  requestId: string;
  role: Role;
}): Promise<JoinActionResult> {
  const { user } = await requireSession();
  const result = await operations.approveJoinRequest(
    operationContext(user, await headers()),
    input,
  );
  if (!result.ok) return { ok: false, error: result.error };
  refresh();
  return result;
}

export async function declineJoinRequest(requestId: string): Promise<JoinActionResult> {
  const { user } = await requireSession();
  const result = await operations.declineJoinRequest(
    operationContext(user, await headers()),
    requestId,
  );
  if (!result.ok) return { ok: false, error: result.error };
  refresh();
  return result;
}
