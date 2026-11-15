import { loadPermissionContext } from '@oat/auth';
import type { PermissionContext } from '@oat/core';
import type { Db } from '@oat/db';

/** The signed-in user acting on documents/folders, with their memberships (`@oat/core` context). */
export type Actor = {
  readonly userId: string;
  readonly ctx: PermissionContext;
};

export async function loadActor(db: Db, userId: string): Promise<Actor> {
  return { userId, ctx: await loadPermissionContext(db, userId) };
}
