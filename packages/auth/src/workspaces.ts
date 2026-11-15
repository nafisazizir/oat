/**
 * Workspace helpers on top of the Better Auth organization tables (`workspace`, `membership`): the
 * personal workspace every user gets, the user's workspace list, the active workspace and the
 * `@oat/core` permission context.
 */
import { createPermissionContext, type PermissionContext, type Role } from '@oat/core';
import { type Db, membership, workspace } from '@oat/db';
import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';

/** Display name of every personal workspace. */
export const PERSONAL_WORKSPACE_NAME = 'Personal';

/** Slug prefix reserved for personal workspaces (team workspaces can't use it). */
export const PERSONAL_SLUG_PREFIX = 'personal-';

/** The slug a personal workspace is created with (fixed: personal slugs can't be changed). */
export function personalWorkspaceSlug(userId: string): string {
  return `${PERSONAL_SLUG_PREFIX}${userId}`;
}

/** Personal workspaces are found by creator + kind (backed by a partial unique index), never by slug. */
const isPersonalOf = (userId: string) =>
  and(eq(workspace.createdBy, userId), eq(workspace.kind, 'personal'));

/**
 * Creates the user's personal workspace (`kind: personal`) and their owner membership, or does
 * nothing if they exist. Safe to call concurrently and repeatedly: the partial unique index
 * `(created_by) where kind = 'personal'` allows at most one per user. Returns its id.
 *
 * Runs on our own connection, so it must only be called once the user row is committed (Better Auth
 * runs `user.create.after` hooks after the transaction).
 */
export async function ensurePersonalWorkspace(db: Db, userId: string): Promise<string> {
  return db.transaction(async (tx) => {
    await tx
      .insert(workspace)
      .values({
        name: PERSONAL_WORKSPACE_NAME,
        slug: personalWorkspaceSlug(userId),
        kind: 'personal',
        createdBy: userId,
      })
      .onConflictDoNothing();
    const [row] = await tx.select({ id: workspace.id }).from(workspace).where(isPersonalOf(userId));
    if (!row) throw new Error('personal workspace missing after insert');
    await tx
      .insert(membership)
      .values({ workspaceId: row.id, userId, role: 'owner' })
      .onConflictDoNothing({ target: [membership.workspaceId, membership.userId] });
    return row.id;
  });
}

/** The user's personal workspace id, if it exists (without creating it). */
export async function findPersonalWorkspaceId(db: Db, userId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ id: workspace.id })
    .from(workspace)
    .innerJoin(membership, eq(membership.workspaceId, workspace.id))
    .where(and(isPersonalOf(userId), eq(membership.userId, userId)));
  return row?.id;
}

export interface UserWorkspace {
  id: string;
  name: string;
  slug: string;
  kind: 'personal' | 'team';
  /** Workspace icon: an emoji (5.1), or null. */
  logo: string | null;
  role: Role;
  memberCount: number;
}

/** Every live (not soft-deleted) workspace the user is a member of: personal first, then by name. */
export async function listUserWorkspaces(db: Db, userId: string): Promise<UserWorkspace[]> {
  const memberCounts = db
    .select({ workspaceId: membership.workspaceId, n: count().as('n') })
    .from(membership)
    .groupBy(membership.workspaceId)
    .as('member_counts');
  return db
    .select({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      kind: workspace.kind,
      logo: workspace.logo,
      role: membership.role,
      memberCount: sql<number>`${memberCounts.n}::int`,
    })
    .from(membership)
    .innerJoin(workspace, eq(workspace.id, membership.workspaceId))
    .innerJoin(memberCounts, eq(memberCounts.workspaceId, workspace.id))
    .where(and(eq(membership.userId, userId), isNull(workspace.deletedAt)))
    .orderBy(sql`${workspace.kind} = 'personal' desc`, asc(workspace.name), asc(workspace.id));
}

/**
 * The workspace to show: the session's active one if the user is still a member, else their personal
 * workspace, else the first one. `undefined` only for a user with no memberships at all.
 */
export function pickActiveWorkspace<W extends Pick<UserWorkspace, 'id' | 'kind'>>(
  workspaces: readonly W[],
  activeWorkspaceId: string | null | undefined,
): W | undefined {
  return (
    workspaces.find((w) => w.id === activeWorkspaceId) ??
    workspaces.find((w) => w.kind === 'personal') ??
    workspaces[0]
  );
}

/**
 * The `@oat/core` permission context for a signed-in user: their memberships in live workspaces. A
 * soft-deleted workspace contributes no role, so nothing in it is readable or writable.
 */
export async function loadPermissionContext(db: Db, userId: string): Promise<PermissionContext> {
  const rows = await db
    .select({
      workspaceId: membership.workspaceId,
      userId: membership.userId,
      role: membership.role,
    })
    .from(membership)
    .innerJoin(workspace, eq(workspace.id, membership.workspaceId))
    .where(and(eq(membership.userId, userId), isNull(workspace.deletedAt)));
  return createPermissionContext({ userId, memberships: rows });
}

/** A URL slug for a new team workspace: `<words-from-name>-<random>` (unique enough to not retry). */
export function teamWorkspaceSlug(name: string, random: () => string = randomSuffix): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return `${base || 'workspace'}-${random()}`;
}

function randomSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
