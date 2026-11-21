/**
 * Who can do what — the single source of truth for authorization (SPEC §4 Sharing, §6, FACTORY §3, D-18).
 *
 * Every function is pure: callers load the resource and the acting user's memberships, build a
 * {@link PermissionContext}, and ask. Nothing here touches a database or a session. API routes use
 * {@link assertCan} (or the move asserts), which throw {@link ForbiddenError}.
 *
 * Terms: "role" = the actor's role in the *resource's* workspace (looked up by the resource's `workspaceId`,
 * so a membership in another workspace never counts). "Doc owner" = `document.ownerId === userId` **and** the
 * actor is still a member of that workspace (a removed member loses access to what they created).
 * "Editor role" = owner | admin | member. Anonymous (`userId: null`) actors have no memberships.
 *
 * Documents (checked in this order; first matching row wins)
 * | Action         | Rule                                                                                    |
 * |----------------|-----------------------------------------------------------------------------------------|
 * | read           | in trash: doc owner; or owner/admin when visibility ≠ private. Share tokens never work. |
 * |                | doc owner → yes. private → no. workspace → any member. link → any member, or anyone    |
 * |                | presenting a token equal to `shareToken` (read-only; tokens < 22 chars never match).    |
 * | edit           | in trash → no (restore first). Non-member or viewer → no. Doc owner → yes.              |
 * |                | private → no. workspace/link → editor role.                                             |
 * | delete/restore | Non-member or viewer → no. Doc owner → yes. private → no. workspace/link → owner/admin.  |
 * | share          | (change visibility, create/rotate link) in trash → no. Non-member or viewer → no.       |
 * |                | Doc owner → yes. private → no. workspace/link → owner/admin. Entering `link` always     |
 * |                | issues a new token (`shouldRotateShareToken`).                                          |
 * | move (D-18)    | Target folder in another workspace → no. Needs create in the workspace and edit on the  |
 * |                | doc. Into root or a workspace folder → yes. Into a private folder → only if the actor   |
 * |                | owns the folder and the doc; the doc becomes `private` (`setVisibility`).               |
 *
 * Folders (no share links). D-18: a private folder belongs to its owner — only they see it or add children,
 * and everything inside it is private and theirs. Reads don't cascade: each document's own visibility
 * decides whether it is readable; the create/move/visibility rules below keep that invariant.
 * | Action         | Rule                                                                                    |
 * |----------------|-----------------------------------------------------------------------------------------|
 * | read           | Non-member → no. Folder owner → yes. private → no. workspace → any member.               |
 * | edit (rename)  | Non-member or viewer → no. Folder owner → yes. private → no. workspace → editor role.    |
 * | create in      | Same as edit. The new item's visibility is `visibilityForNewItem(folder, requested)`:   |
 * |                | always `private` inside a private folder.                                               |
 * | set visibility | Edit, and making a non-private folder private needs owning it and every descendant      |
 * |                | (`containedOwnerIds`).                                                                  |
 * | delete         | Non-member or viewer → no. Folder owner → yes. private → no. workspace → owner/admin.   |
 * | move           | As document move, with edit on the folder; moving a non-private folder into a private   |
 * |                | one needs owning every descendant too, and the folder becomes private. Cycles (into     |
 * |                | itself or a descendant) are the caller's check.                                         |
 *
 * `decideMove*` return `{ allowed, setVisibility? }`; `canMove*` are their boolean forms.
 *
 * Workspaces (one kind, D-36: every workspace can have members, be renamed, left and deleted)
 * | Action           | Rule                                                                                  |
 * |------------------|---------------------------------------------------------------------------------------|
 * | create in        | editor role (viewers never create).                                                   |
 * | manage members   | owner/admin.                                                                          |
 * | invite(role)     | manage members, and `role` ≤ actor's role (admins can't invite owners).               |
 * | change role      | manage members; target in this workspace; owners change anyone; admins change only    |
 * |                  | members/viewers and grant at most admin; never demote the last owner.                 |
 * | remove member    | target in this workspace; never the last owner. Anyone may leave (remove themselves)  |
 * |                  | unless it is their last workspace; otherwise owners remove anyone, admins only        |
 * |                  | members/viewers.                                                                      |
 * | delete workspace | owner, and not the actor's last workspace.                                            |
 *
 * Joining by email domain (D-36). "Matches" = the person's email is **verified**, its domain is not a public
 * mailbox domain (`email-domains.ts`), the workspace lists that domain, and the workspace is not deleted.
 * The email always comes from the user row, never from a request.
 * | Action             | Rule                                                                                |
 * |--------------------|-------------------------------------------------------------------------------------|
 * | edit join settings | (policy, removing a domain) owner/admin.                                            |
 * | add domain         | owner/admin, with a verified email, and only that email's own domain; never a       |
 * |                    | public mailbox domain.                                                              |
 * | auto-join          | policy `auto_join`; signed in, not a member, matches. Joins as `member`.            |
 * | request to join    | policy `request`; signed in, not a member, matches; no pending request and no       |
 * |                    | declined one (a "no" stands until an owner/admin invites them).                     |
 * | decide request     | owner/admin of the request's workspace, while it is pending; approving with a role  |
 * |                    | ≤ their own.                                                                        |
 * An `invite_only` workspace offers a matching stranger nothing and is never shown to them (`joinOption`).
 *
 * "Last workspace" (D-36: no account is ever left without one by its own action) is read from the context:
 * `ctx.memberships` must hold **all** of the actor's memberships in live workspaces (as
 * `createPermissionContext` is normally given). A context built from one workspace's rows alone therefore
 * refuses leaving and deleting — it fails closed.
 */
import { emailDomain, isPublicMailboxDomain, normalizeDomain } from './email-domains.ts';
import type {
  DocumentVisibility,
  FolderVisibility,
  JoinPolicy,
  JoinRequestStatus,
  Membership,
  Role,
} from './types.ts';

// ---------------------------------------------------------------------------------------------------------
// Context and resource shapes
// ---------------------------------------------------------------------------------------------------------

/** Everything the permission functions know about the actor. */
export interface PermissionContext {
  /** `null` = anonymous (signed out). */
  readonly userId: string | null;
  /** The actor's own memberships: workspaceId → role. */
  readonly memberships: ReadonlyMap<string, Role>;
  /** Share token presented with the request (e.g. from a `/s/<token>` URL), if any. */
  readonly shareToken?: string;
}

/** The fields of a document that permissions depend on (a full `Document` also fits). */
export interface DocumentAccess {
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly visibility: DocumentVisibility;
  readonly shareToken: string | null;
  readonly deletedAt: Date | null;
}

/** The fields of a folder that permissions depend on (a full `Folder` also fits). */
export interface FolderAccess {
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly visibility: FolderVisibility;
}

/** The fields of a workspace that permissions depend on (a full `Workspace` also fits). */
export interface WorkspaceAccess {
  readonly id: string;
}

/** A user's email as the *server* knows it (the user row) — never an address taken from a request. */
export interface EmailIdentity {
  readonly email: string;
  /** Only verified addresses ever match a workspace's domains. */
  readonly emailVerified: boolean;
}

/** The fields of a workspace that decide who may find and join it by email domain (D-36). */
export interface JoinableWorkspaceAccess extends WorkspaceAccess {
  readonly joinPolicy: JoinPolicy;
  /** The workspace's allowed email domains. */
  readonly domains: readonly string[];
  /** Soft delete: a deleted workspace is never joinable. */
  readonly deletedAt: Date | null;
}

/** The fields of a request to join that permissions depend on. */
export interface JoinRequestAccess {
  readonly workspaceId: string;
  readonly status: JoinRequestStatus;
}

/** A membership being changed or removed, plus how many owners the workspace has right now. */
export interface MemberTarget extends Pick<Membership, 'workspaceId' | 'userId' | 'role'> {
  /**
   * Current number of `owner` memberships in the target's workspace (for last-owner protection). Routes
   * must count owners under a row lock in the same transaction as the change (or back it with a DB guard);
   * otherwise two owners demoting/leaving concurrently could both see 2.
   */
  readonly ownerCount: number;
}

/**
 * Builds a context from the actor's membership rows. Rows belonging to other users are ignored, and an
 * anonymous actor never has memberships, so passing the wrong rows can't accidentally grant access.
 */
export function createPermissionContext(input: {
  userId: string | null;
  memberships?: Iterable<Pick<Membership, 'workspaceId' | 'userId' | 'role'>>;
  shareToken?: string;
}): PermissionContext {
  const memberships = new Map<string, Role>();
  if (input.userId !== null) {
    for (const m of input.memberships ?? []) {
      if (m.userId === input.userId) memberships.set(m.workspaceId, m.role);
    }
  }
  return input.shareToken === undefined
    ? { userId: input.userId, memberships }
    : { userId: input.userId, memberships, shareToken: input.shareToken };
}

// ---------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------

const ROLE_RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/** True when `a` grants at least as much as `b`. */
export function roleAtLeast(a: Role, b: Role): boolean {
  return ROLE_RANK[a] >= ROLE_RANK[b];
}

/** The actor's role in a workspace, or `undefined` if anonymous or not a member. */
export function roleIn(ctx: PermissionContext, workspaceId: string): Role | undefined {
  return ctx.userId === null ? undefined : ctx.memberships.get(workspaceId);
}

const canWrite = (role: Role | undefined): role is Role => role !== undefined && role !== 'viewer';
const isAdmin = (role: Role | undefined): boolean => role === 'owner' || role === 'admin';
/** Owners manage everyone; admins manage only roles strictly below their own (members, viewers). */
const manages = (actor: Role, target: Role): boolean =>
  actor === 'owner' || ROLE_RANK[actor] > ROLE_RANK[target];

/** Shortest share token that can ever match: 22 base64url chars = 128 bits of entropy. */
export const MIN_SHARE_TOKEN_LENGTH = 22;

/**
 * Constant-time comparison (for a given stored token) so a check can't leak a matching prefix by timing.
 * Stored tokens shorter than {@link MIN_SHARE_TOKEN_LENGTH} never match.
 */
function tokensMatch(expected: string | null, presented: string | undefined): boolean {
  if (expected === null || expected.length < MIN_SHARE_TOKEN_LENGTH || presented === undefined) {
    return false;
  }
  let diff = expected.length ^ presented.length;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i % Math.max(presented.length, 1));
  }
  return diff === 0;
}

/**
 * Whether a visibility change must issue a fresh share token: every time a document (re-)enters `link`,
 * so a link that was turned off never comes back to life.
 */
export function shouldRotateShareToken(from: DocumentVisibility, to: DocumentVisibility): boolean {
  return to === 'link' && from !== 'link';
}

/**
 * Result of a move check. When `setVisibility` is present the caller must apply it in the same write as the
 * move (D-18: anything filed into a private folder becomes private).
 */
export type MoveDecision =
  { readonly allowed: false } | { readonly allowed: true; readonly setVisibility?: 'private' };

const DENY: MoveDecision = Object.freeze({ allowed: false });
const ALLOW: MoveDecision = Object.freeze({ allowed: true });
const ALLOW_MAKE_PRIVATE: MoveDecision = Object.freeze({ allowed: true, setVisibility: 'private' });

/**
 * True when `userId` owns every item in the subtree. Used before something non-private becomes private, so
 * nobody can hide other people's documents or folders under it (D-18).
 */
const ownsAll = (userId: string | null, ownerIds: readonly string[]): boolean =>
  ownerIds.every((id) => id === userId);

/**
 * Shared D-18 move rule for documents and folders. `canEditItem` = edit rights on the moved item;
 * `containedOwnerIds` = owners of everything inside it (empty for documents).
 */
function decideMove(
  ctx: PermissionContext,
  item: { readonly workspaceId: string; readonly ownerId: string; readonly visibility: string },
  canEditItem: boolean,
  target: FolderAccess | null,
  containedOwnerIds: readonly string[],
): MoveDecision {
  if (target !== null && target.workspaceId !== item.workspaceId) return DENY;
  if (!canWrite(roleIn(ctx, item.workspaceId)) || !canEditItem) return DENY;
  if (target === null || target.visibility === 'workspace') return ALLOW;
  if (target.ownerId !== ctx.userId || item.ownerId !== ctx.userId) return DENY;
  if (item.visibility === 'private') return ALLOW;
  return ownsAll(ctx.userId, containedOwnerIds) ? ALLOW_MAKE_PRIVATE : DENY;
}

// ---------------------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------------------

export function canReadDocument(ctx: PermissionContext, doc: DocumentAccess): boolean {
  const role = roleIn(ctx, doc.workspaceId);
  const isOwner = role !== undefined && doc.ownerId === ctx.userId;
  if (doc.deletedAt !== null) {
    return isOwner || (doc.visibility !== 'private' && isAdmin(role));
  }
  if (isOwner) return true;
  switch (doc.visibility) {
    case 'private':
      return false;
    case 'workspace':
      return role !== undefined;
    case 'link':
      return role !== undefined || tokensMatch(doc.shareToken, ctx.shareToken);
  }
}

export function canEditDocument(ctx: PermissionContext, doc: DocumentAccess): boolean {
  if (doc.deletedAt !== null) return false;
  const role = roleIn(ctx, doc.workspaceId);
  if (!canWrite(role)) return false;
  if (doc.ownerId === ctx.userId) return true;
  return doc.visibility !== 'private';
}

/** Covers moving to trash, restoring from trash and permanent deletion. */
export function canDeleteDocument(ctx: PermissionContext, doc: DocumentAccess): boolean {
  const role = roleIn(ctx, doc.workspaceId);
  if (!canWrite(role)) return false;
  if (doc.ownerId === ctx.userId) return true;
  return doc.visibility !== 'private' && isAdmin(role);
}

/**
 * Changing visibility, creating or rotating the share link. When the change enters `link`, the caller must
 * issue a new token ({@link shouldRotateShareToken}).
 */
export function canShareDocument(ctx: PermissionContext, doc: DocumentAccess): boolean {
  if (doc.deletedAt !== null) return false;
  const role = roleIn(ctx, doc.workspaceId);
  if (!canWrite(role)) return false;
  if (doc.ownerId === ctx.userId) return true;
  return doc.visibility !== 'private' && isAdmin(role);
}

/**
 * Moving a document into `target` (`null` = the root of the document's own workspace). D-18: no
 * cross-workspace moves; into a private folder only by someone who owns both, and the doc becomes private.
 * Returns a decision object — never use it in a boolean context; {@link canMoveDocument} is the boolean.
 */
export function decideMoveDocument(
  ctx: PermissionContext,
  doc: DocumentAccess,
  target: FolderAccess | null,
): MoveDecision {
  return decideMove(ctx, doc, canEditDocument(ctx, doc), target, []);
}

/** Boolean form of {@link decideMoveDocument} (ignores the visibility change the move would require). */
export function canMoveDocument(
  ctx: PermissionContext,
  doc: DocumentAccess,
  target: FolderAccess | null,
): boolean {
  return decideMoveDocument(ctx, doc, target).allowed;
}

// ---------------------------------------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------------------------------------

export function canReadFolder(ctx: PermissionContext, folder: FolderAccess): boolean {
  const role = roleIn(ctx, folder.workspaceId);
  if (role === undefined) return false;
  return folder.ownerId === ctx.userId || folder.visibility === 'workspace';
}

/**
 * Renaming a folder. Visibility changes use {@link canSetFolderVisibility}, adding children
 * {@link canCreateInFolder}, moving {@link decideMoveFolder} / {@link decideMoveDocument}.
 */
export function canEditFolder(ctx: PermissionContext, folder: FolderAccess): boolean {
  const role = roleIn(ctx, folder.workspaceId);
  if (!canWrite(role)) return false;
  return folder.ownerId === ctx.userId || folder.visibility === 'workspace';
}

/**
 * Creating a document or subfolder inside `folder` (D-18: only the owner adds to a private folder). The new
 * item's visibility must come from {@link visibilityForNewItem}.
 */
export function canCreateInFolder(ctx: PermissionContext, folder: FolderAccess): boolean {
  return canEditFolder(ctx, folder);
}

/** Visibility a new item created in `folder` (`null` = root) gets: always `private` inside a private folder. */
export function visibilityForNewItem<V extends DocumentVisibility>(
  folder: FolderAccess | null,
  requested: V,
): V | 'private' {
  return folder !== null && folder.visibility === 'private' ? 'private' : requested;
}

/**
 * Changing a folder's visibility. Making a non-private folder private additionally requires owning the folder
 * and everything inside it (`containedOwnerIds`: owner ids of every descendant document and folder), so
 * nobody can hide other people's items (D-18).
 */
export function canSetFolderVisibility(
  ctx: PermissionContext,
  folder: FolderAccess,
  to: FolderVisibility,
  containedOwnerIds: readonly string[],
): boolean {
  if (!canEditFolder(ctx, folder)) return false;
  if (to === 'workspace' || folder.visibility === 'private') return true;
  return folder.ownerId === ctx.userId && ownsAll(ctx.userId, containedOwnerIds);
}

export function canDeleteFolder(ctx: PermissionContext, folder: FolderAccess): boolean {
  const role = roleIn(ctx, folder.workspaceId);
  if (!canWrite(role)) return false;
  if (folder.ownerId === ctx.userId) return true;
  return folder.visibility === 'workspace' && isAdmin(role);
}

/**
 * Moving a folder under `target` (`null` = workspace root). Same rules as {@link decideMoveDocument}, with
 * edit rights on the folder; moving a non-private folder into a private one also requires owning everything
 * inside it (`containedOwnerIds`: owner ids of every descendant document and folder). The caller must reject
 * cycles (target is the folder itself or a descendant). Returns a decision object — never use it in a
 * boolean context; {@link canMoveFolder} is the boolean.
 */
export function decideMoveFolder(
  ctx: PermissionContext,
  folder: FolderAccess,
  target: FolderAccess | null,
  containedOwnerIds: readonly string[],
): MoveDecision {
  return decideMove(ctx, folder, canEditFolder(ctx, folder), target, containedOwnerIds);
}

/** Boolean form of {@link decideMoveFolder} (ignores the visibility change the move would require). */
export function canMoveFolder(
  ctx: PermissionContext,
  folder: FolderAccess,
  target: FolderAccess | null,
  containedOwnerIds: readonly string[],
): boolean {
  return decideMoveFolder(ctx, folder, target, containedOwnerIds).allowed;
}

// ---------------------------------------------------------------------------------------------------------
// Workspaces and members
// ---------------------------------------------------------------------------------------------------------

/** Creating documents or folders in the workspace. */
export function canCreateInWorkspace(ctx: PermissionContext, workspace: WorkspaceAccess): boolean {
  return canWrite(roleIn(ctx, workspace.id));
}

/** Opening member management at all (listing invites, changing roles, removing others). */
export function canManageMembers(ctx: PermissionContext, workspace: WorkspaceAccess): boolean {
  return isAdmin(roleIn(ctx, workspace.id));
}

/** Inviting someone with `role`; nobody can invite above their own role. */
export function canInvite(ctx: PermissionContext, workspace: WorkspaceAccess, role: Role): boolean {
  if (!canManageMembers(ctx, workspace)) return false;
  return roleAtLeast(roleIn(ctx, workspace.id) as Role, role);
}

/** Owners change anyone's role; admins change only members/viewers, and grant at most admin. */
export function canChangeRole(
  ctx: PermissionContext,
  workspace: WorkspaceAccess,
  target: MemberTarget,
  newRole: Role,
): boolean {
  if (target.workspaceId !== workspace.id || !canManageMembers(ctx, workspace)) return false;
  const actor = roleIn(ctx, workspace.id) as Role;
  if (!manages(actor, target.role) || !roleAtLeast(actor, newRole)) return false;
  return !isLastOwner(target) || newRole === 'owner';
}

/**
 * Whether `workspaceId` is the only workspace the actor belongs to (per the context's memberships): it can't
 * be left or deleted until they create or join another one (D-36).
 */
export function isLastWorkspace(ctx: PermissionContext, workspaceId: string): boolean {
  return ctx.memberships.has(workspaceId) && ctx.memberships.size <= 1;
}

/** Removing a member, including leaving a workspace yourself (never your last one). */
export function canRemoveMember(
  ctx: PermissionContext,
  workspace: WorkspaceAccess,
  target: MemberTarget,
): boolean {
  if (target.workspaceId !== workspace.id) return false;
  const actor = roleIn(ctx, workspace.id);
  if (actor === undefined || isLastOwner(target)) return false;
  if (target.userId === ctx.userId) return !isLastWorkspace(ctx, workspace.id);
  return isAdmin(actor) && manages(actor, target.role);
}

/** Deleting a workspace: its owners, and never the actor's last one. */
export function canDeleteWorkspace(ctx: PermissionContext, workspace: WorkspaceAccess): boolean {
  return roleIn(ctx, workspace.id) === 'owner' && !isLastWorkspace(ctx, workspace.id);
}

const isLastOwner = (target: MemberTarget): boolean =>
  target.role === 'owner' && target.ownerCount <= 1;

// ---------------------------------------------------------------------------------------------------------
// Joining by email domain (D-36)
// ---------------------------------------------------------------------------------------------------------

/**
 * The domain through which `person` matches `workspace`, or `null`: their email is verified, its domain is
 * not a public mailbox domain, the workspace lists it, and the workspace is live. This is the only way a
 * workspace is ever tied to someone who wasn't invited.
 */
export function matchingJoinDomain(
  workspace: JoinableWorkspaceAccess,
  person: EmailIdentity,
): string | null {
  if (workspace.deletedAt !== null || !person.emailVerified) return null;
  const domain = emailDomain(person.email);
  if (domain === null || isPublicMailboxDomain(domain)) return null;
  return workspace.domains.some((listed) => normalizeDomain(listed) === domain) ? domain : null;
}

/** Changing the join policy or removing an allowed domain: the people who manage members. */
export function canEditJoinSettings(ctx: PermissionContext, workspace: WorkspaceAccess): boolean {
  return canManageMembers(ctx, workspace);
}

/**
 * Listing `domain` as an allowed domain: an owner/admin, and only the domain of their own verified email —
 * never a public mailbox domain. `actor` must be the acting user's own row (never request input).
 */
export function canAddDomain(
  ctx: PermissionContext,
  workspace: WorkspaceAccess,
  actor: EmailIdentity,
  domain: string,
): boolean {
  if (!canEditJoinSettings(ctx, workspace) || !actor.emailVerified) return false;
  const own = emailDomain(actor.email);
  if (own === null || isPublicMailboxDomain(own)) return false;
  return normalizeDomain(domain) === own;
}

/** A signed-in person who isn't a member yet and matches one of the workspace's domains. */
const matchesAsStranger = (
  ctx: PermissionContext,
  workspace: JoinableWorkspaceAccess,
  person: EmailIdentity,
): boolean =>
  ctx.userId !== null &&
  roleIn(ctx, workspace.id) === undefined &&
  matchingJoinDomain(workspace, person) !== null;

/** Joining straight away (as `member`): an `auto_join` workspace the person matches. */
export function canAutoJoin(
  ctx: PermissionContext,
  workspace: JoinableWorkspaceAccess,
  person: EmailIdentity,
): boolean {
  return workspace.joinPolicy === 'auto_join' && matchesAsStranger(ctx, workspace, person);
}

/**
 * Asking to join: a `request` workspace the person matches. `previous` is the status of their latest
 * request to this workspace (`null` = never asked): one that is still pending or was declined blocks a new
 * one, so nobody can ask twice at once or keep asking after a "no" (an owner/admin can still invite them).
 */
export function canRequestToJoin(
  ctx: PermissionContext,
  workspace: JoinableWorkspaceAccess,
  person: EmailIdentity,
  previous: JoinRequestStatus | null,
): boolean {
  if (previous === 'pending' || previous === 'declined') return false;
  return workspace.joinPolicy === 'request' && matchesAsStranger(ctx, workspace, person);
}

/** What a workspace offers someone who isn't a member; `null` = it is not shown to them at all. */
export type JoinOption = 'join' | 'request' | 'requested';

/**
 * Whether — and how — a workspace is shown to someone looking for one to join: `join` (auto-join),
 * `request` (may ask), `requested` (their request is waiting). `null` for everything else: an
 * `invite_only` workspace is never shown to a matching stranger, and nothing is shown to an unverified or
 * public-mailbox address, a member, or after a declined request.
 */
export function joinOption(
  ctx: PermissionContext,
  workspace: JoinableWorkspaceAccess,
  person: EmailIdentity,
  previous: JoinRequestStatus | null,
): JoinOption | null {
  if (canAutoJoin(ctx, workspace, person)) return 'join';
  if (canRequestToJoin(ctx, workspace, person, previous)) return 'request';
  if (previous === 'pending' && canRequestToJoin(ctx, workspace, person, null)) return 'requested';
  return null;
}

/**
 * Seeing and deciding a request to join: owners/admins of that workspace, while it is pending. Approving
 * passes the `role` the new member gets, which is never above the decider's own; declining passes none.
 */
export function canDecideJoinRequest(
  ctx: PermissionContext,
  workspace: WorkspaceAccess,
  request: JoinRequestAccess,
  role?: Role,
): boolean {
  if (request.workspaceId !== workspace.id || !canManageMembers(ctx, workspace)) return false;
  if (request.status !== 'pending') return false;
  return role === undefined || roleAtLeast(roleIn(ctx, workspace.id) as Role, role);
}

// ---------------------------------------------------------------------------------------------------------
// Assertions for API routes
// ---------------------------------------------------------------------------------------------------------

/**
 * Every boolean check, by name. `assertCan` uses the name in errors (function names don't survive
 * minification). The move entries are the boolean forms; routes that move should use `assertCanMove*`,
 * which also return the visibility change to apply.
 */
export const permissions = Object.freeze({
  readDocument: canReadDocument,
  editDocument: canEditDocument,
  deleteDocument: canDeleteDocument,
  shareDocument: canShareDocument,
  moveDocument: canMoveDocument,
  readFolder: canReadFolder,
  editFolder: canEditFolder,
  createInFolder: canCreateInFolder,
  setFolderVisibility: canSetFolderVisibility,
  deleteFolder: canDeleteFolder,
  moveFolder: canMoveFolder,
  createInWorkspace: canCreateInWorkspace,
  manageMembers: canManageMembers,
  invite: canInvite,
  changeRole: canChangeRole,
  removeMember: canRemoveMember,
  deleteWorkspace: canDeleteWorkspace,
  editJoinSettings: canEditJoinSettings,
  addDomain: canAddDomain,
  autoJoin: canAutoJoin,
  requestToJoin: canRequestToJoin,
  decideJoinRequest: canDecideJoinRequest,
});

export type PermissionAction = keyof typeof permissions;

/** Arguments of a check after the context. */
export type PermissionArgs<A extends PermissionAction> =
  Parameters<(typeof permissions)[A]> extends [PermissionContext, ...infer Rest] ? Rest : never;

/** Thrown by the asserts. API routes map it to HTTP 403 (or 404 to hide existence). */
export class ForbiddenError extends Error {
  override readonly name = 'ForbiddenError';
  readonly code = 'FORBIDDEN';
  readonly status = 403;
  /** The denied action: a {@link PermissionAction}, or an unknown name passed to `assertCan`. */
  readonly action: string;

  constructor(action: string) {
    super(`Forbidden: ${action}`);
    this.action = action;
  }
}

export function isForbiddenError(error: unknown): error is ForbiddenError {
  return error instanceof ForbiddenError;
}

/**
 * Throws {@link ForbiddenError} unless `permissions[action](ctx, ...args)` returns exactly `true`. Fails
 * closed for names that aren't own keys of `permissions` (`constructor`, `toString`, `__proto__`, typos),
 * because `action` may come from untyped input.
 */
export function assertCan<A extends PermissionAction>(
  action: A,
  ctx: PermissionContext,
  ...args: PermissionArgs<A>
): void {
  if (!Object.hasOwn(permissions, action)) throw new ForbiddenError(String(action));
  // TS can't correlate `permissions[A]` with `PermissionArgs<A>` for a generic A; the signature above does.
  const check = permissions[action] as unknown as (
    ctx: PermissionContext,
    ...args: PermissionArgs<A>
  ) => unknown;
  if (check(ctx, ...args) !== true) throw new ForbiddenError(action);
}

export type AllowedMove = Extract<MoveDecision, { allowed: true }>;

/** {@link decideMoveDocument} or throw. Returns the decision so the caller applies `setVisibility`. */
export function assertCanMoveDocument(
  ctx: PermissionContext,
  doc: DocumentAccess,
  target: FolderAccess | null,
): AllowedMove {
  const decision = decideMoveDocument(ctx, doc, target);
  if (!decision.allowed) throw new ForbiddenError('moveDocument');
  return decision;
}

/** {@link decideMoveFolder} or throw. Returns the decision so the caller applies `setVisibility`. */
export function assertCanMoveFolder(
  ctx: PermissionContext,
  folder: FolderAccess,
  target: FolderAccess | null,
  containedOwnerIds: readonly string[],
): AllowedMove {
  const decision = decideMoveFolder(ctx, folder, target, containedOwnerIds);
  if (!decision.allowed) throw new ForbiddenError('moveFolder');
  return decision;
}
