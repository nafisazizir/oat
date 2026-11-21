/**
 * Workspace helpers on top of the Better Auth organization tables (`workspace`, `membership`): creating the
 * workspace a new user gets (D-36: there is one kind of workspace; *whether* they get one is decided in
 * `joining.ts`), the user's workspace list, the active workspace and the `@oat/core` permission context.
 */
import { createPermissionContext, type PermissionContext, type Role } from '@oat/core';
import { type Db, membership, user, workspace } from '@oat/db';
import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';

/** Name of a first workspace when the user has no name to make one from. */
export const FALLBACK_WORKSPACE_NAME = 'My workspace';

/** Longest first name used in a workspace name (workspace names are at most 60 characters). */
const MAX_FIRST_NAME = 40;

/**
 * The name of the workspace created for a new user: "<First name>’s workspace", or
 * {@link FALLBACK_WORKSPACE_NAME} when they have no name (magic-link sign-ups). They can rename it.
 */
export function firstWorkspaceName(userName: string | null | undefined): string {
  const first = (userName ?? '').trim().split(/\s+/)[0] ?? '';
  return first ? `${first.slice(0, MAX_FIRST_NAME)}’s workspace` : FALLBACK_WORKSPACE_NAME;
}

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Per-user mutex for the rest of `tx`: everything that decides on "how many workspaces does this user have"
 * (creating their first one, leaving or deleting their last one) runs one at a time per user. An advisory
 * lock, not a row lock: it can't wait on (or block) a Better Auth transaction that is writing the user row
 * while one of our hooks runs on another connection. Returns the user, `undefined` if there is none.
 */
export async function lockUser(tx: Tx, userId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`oat:user-workspaces:${userId}`}, 0))`,
  );
  const [row] = await tx
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

/** The user's memberships in live workspaces, oldest first. */
export const liveMemberships = (db: Db | Tx, userId: string) =>
  db
    .select({
      workspaceId: membership.workspaceId,
      userId: membership.userId,
      role: membership.role,
    })
    .from(membership)
    .innerJoin(workspace, eq(workspace.id, membership.workspaceId))
    .where(and(eq(membership.userId, userId), isNull(workspace.deletedAt)))
    .orderBy(asc(membership.createdAt), asc(membership.id));

/** The live workspace the user has belonged to longest, if any (without creating one). */
export async function findFirstWorkspaceId(db: Db, userId: string): Promise<string | undefined> {
  const [row] = await liveMemberships(db, userId).limit(1);
  return row?.workspaceId;
}

/**
 * Creates an ordinary workspace named {@link firstWorkspaceName} with `me` as its `owner` (D-36). The
 * caller holds {@link lockUser} and has decided that one is needed (`joining.ts` `ensureFirstWorkspace`).
 */
export async function createWorkspaceFor(
  tx: Tx,
  me: { id: string; name: string | null },
): Promise<string> {
  const name = firstWorkspaceName(me.name);
  const [created] = await tx
    .insert(workspace)
    .values({ name, slug: workspaceSlug(name), createdBy: me.id })
    .returning({ id: workspace.id });
  if (!created) throw new Error('createWorkspaceFor: workspace missing after insert');
  await tx.insert(membership).values({ workspaceId: created.id, userId: me.id, role: 'owner' });
  return created.id;
}

/**
 * Where a new session starts (D-36): the workspace the user last switched to if they are still a member of
 * it, else the one they have belonged to longest. `undefined` for a user without a workspace.
 */
export async function startingWorkspaceId(db: Db, userId: string): Promise<string | undefined> {
  const [rows, last] = await Promise.all([
    liveMemberships(db, userId),
    lastActiveWorkspaceId(db, userId),
  ]);
  return rows.find((r) => r.workspaceId === last)?.workspaceId ?? rows[0]?.workspaceId;
}

/** The workspace the user last switched to (may be one they have since left: check before use). */
export async function lastActiveWorkspaceId(db: Db, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: user.lastActiveWorkspaceId })
    .from(user)
    .where(eq(user.id, userId));
  return row?.id ?? null;
}

/** Records the workspace the user just switched to, for {@link startingWorkspaceId}. */
export async function rememberActiveWorkspace(
  db: Db,
  userId: string,
  workspaceId: string | null,
): Promise<void> {
  await db.update(user).set({ lastActiveWorkspaceId: workspaceId }).where(eq(user.id, userId));
}

export interface UserWorkspace {
  id: string;
  name: string;
  slug: string;
  /** Workspace icon: an emoji (5.1), or null. */
  logo: string | null;
  role: Role;
  memberCount: number;
  /** When the user became a member (their oldest membership is where they land by default). */
  joinedAt: Date;
}

/** Every live (not soft-deleted) workspace the user is a member of, by name. */
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
      logo: workspace.logo,
      role: membership.role,
      memberCount: sql<number>`${memberCounts.n}::int`,
      joinedAt: membership.createdAt,
    })
    .from(membership)
    .innerJoin(workspace, eq(workspace.id, membership.workspaceId))
    .innerJoin(memberCounts, eq(memberCounts.workspaceId, workspace.id))
    .where(and(eq(membership.userId, userId), isNull(workspace.deletedAt)))
    .orderBy(asc(sql`lower(${workspace.name})`), asc(workspace.id));
}

/**
 * The workspace to show: the session's active one if the user is still a member, else the one they last
 * switched to, else the one they have belonged to longest (D-36; the same rule as
 * {@link startingWorkspaceId}). `undefined` only for a user with no memberships at all.
 */
export function pickActiveWorkspace<W extends Pick<UserWorkspace, 'id' | 'joinedAt'>>(
  workspaces: readonly W[],
  activeWorkspaceId: string | null | undefined,
  lastActiveId?: string | null,
): W | undefined {
  const older = (a: W, b: W) =>
    a.joinedAt.getTime() - b.joinedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return (
    workspaces.find((w) => w.id === activeWorkspaceId) ??
    workspaces.find((w) => w.id === lastActiveId) ??
    [...workspaces].sort(older)[0]
  );
}

/**
 * The `@oat/core` permission context for a signed-in user: their memberships in live workspaces. A
 * soft-deleted workspace contributes no role, so nothing in it is readable or writable.
 */
export async function loadPermissionContext(
  db: Db | Tx,
  userId: string,
): Promise<PermissionContext> {
  return createPermissionContext({ userId, memberships: await liveMemberships(db, userId) });
}

/** A URL slug for a new workspace: `<words-from-name>-<random>` (unique enough to not retry). */
export function workspaceSlug(name: string, random: () => string = randomSuffix): string {
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
