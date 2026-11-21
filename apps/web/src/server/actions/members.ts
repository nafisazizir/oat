'use server';

import type { Role } from '@oat/core';
import { refresh, revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { operationContext } from '../operation-context';
import * as operations from '../operations/members';
import { requireSession } from '../session';

export type MemberActionResult = { ok: true } | { ok: false; error: string };

export async function updateWorkspace(input: {
  workspaceId: string;
  name: string;
  icon: string | null;
}): Promise<MemberActionResult> {
  const { user } = await requireSession();
  const result = await operations.updateWorkspace(operationContext(user, await headers()), input);
  if (!result.ok) return { ok: false, error: result.error };
  refresh();
  return result;
}

export async function leaveWorkspace(workspaceId: string): Promise<MemberActionResult> {
  const { user } = await requireSession();
  const result = await operations.leaveWorkspace(
    operationContext(user, await headers()),
    workspaceId,
  );
  if (!result.ok) return { ok: false, error: result.error };
  revalidatePath('/', 'layout');
  redirect('/home');
}

export async function deleteWorkspace(input: {
  workspaceId: string;
  confirmName: string;
}): Promise<MemberActionResult> {
  const { user } = await requireSession();
  const result = await operations.deleteWorkspace(operationContext(user, await headers()), input);
  if (!result.ok) return { ok: false, error: result.error };
  revalidatePath('/', 'layout');
  redirect('/home');
}

export async function changeRole(input: {
  workspaceId: string;
  userId: string;
  role: Role;
}): Promise<MemberActionResult> {
  const { user } = await requireSession();
  const result = await operations.changeRole(operationContext(user, await headers()), input);
  if (!result.ok) return { ok: false, error: result.error };
  refresh();
  return result;
}

export async function removeMember(input: {
  workspaceId: string;
  userId: string;
}): Promise<MemberActionResult> {
  const { user } = await requireSession();
  const result = await operations.removeMember(operationContext(user, await headers()), input);
  if (!result.ok) return { ok: false, error: result.error };
  refresh();
  return result;
}

export async function inviteMember(input: {
  workspaceId: string;
  email: string;
  role: Role;
}): Promise<MemberActionResult> {
  const { user } = await requireSession();
  const result = await operations.inviteMember(operationContext(user, await headers()), input);
  if (!result.ok) return { ok: false, error: result.error };
  refresh();
  return result;
}

export async function resendInvite(inviteId: string): Promise<MemberActionResult> {
  const { user } = await requireSession();
  const result = await operations.resendInvite(operationContext(user, await headers()), inviteId);
  if (!result.ok) return { ok: false, error: result.error };
  refresh();
  return result;
}

export async function revokeInvite(inviteId: string): Promise<MemberActionResult> {
  const { user } = await requireSession();
  const result = await operations.revokeInvite(operationContext(user, await headers()), inviteId);
  if (!result.ok) return { ok: false, error: result.error };
  refresh();
  return result;
}

export async function acceptInvite(token: string): Promise<MemberActionResult> {
  const { user } = await requireSession();
  const result = await operations.acceptInvite(operationContext(user, await headers()), token);
  if (!result.ok) return { ok: false, error: result.error };
  revalidatePath('/', 'layout');
  redirect('/home');
}

export async function declineInvite(token: string): Promise<MemberActionResult> {
  const { user } = await requireSession();
  const result = await operations.declineInvite(operationContext(user, await headers()), token);
  if (!result.ok) return { ok: false, error: result.error };
  refresh();
  return result;
}
