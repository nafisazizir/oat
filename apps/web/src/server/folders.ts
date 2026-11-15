import 'server-only';

import {
  assertCan,
  assertCanMoveFolder,
  canDeleteDocument,
  canDeleteFolder,
  canEditFolder,
  canReadFolder,
  roleIn,
  type FolderVisibility,
  visibilityForNewItem,
  type WorkspaceAccess,
} from '@oat/core';
import { type Db, document, folder, type FolderRow, workspace } from '@oat/db';
import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';

import type { FolderSummary } from '@/lib/api-types';

import type { Actor } from './actor';
import { badRequest, confirmPrivate, forbidden, notFound } from './api/errors';

/*
 * Folder data access (SPEC §6, D-18). Every function takes the acting user and checks `@oat/core`
 * permissions on the loaded rows before writing; anything the actor can't read is "not found".
 * Folders have no trash: deleting one moves the documents inside it (and its subfolders) to the trash
 * and removes the folders; restored documents come back at the workspace root.
 */

/** A Drizzle transaction (same query API as `Db`). */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Queryable = Db | Tx;

export const MAX_NAME_LENGTH = 200;

/** One-line, trimmed name/title (newlines and tabs become spaces). */
export function normalizeName(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

export function toFolderSummary(actor: Actor, row: FolderRow): FolderSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    parentId: row.parentId,
    ownerId: row.ownerId,
    name: row.name,
    visibility: row.visibility,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    access: { edit: canEditFolder(actor.ctx, row), delete: canDeleteFolder(actor.ctx, row) },
  };
}

/** The actor must be a member of the workspace; otherwise it doesn't exist for them. */
export function requireMember(actor: Actor, workspaceId: string): void {
  if (roleIn(actor.ctx, workspaceId) === undefined) throw notFound('Workspace');
}

/** The workspace, checked for "create documents/folders here" (members and up; viewers get 403). */
export async function workspaceForCreate(
  db: Queryable,
  actor: Actor,
  workspaceId: string,
): Promise<WorkspaceAccess> {
  requireMember(actor, workspaceId);
  const [row] = await db
    .select({ id: workspace.id, kind: workspace.kind })
    .from(workspace)
    .where(eq(workspace.id, workspaceId));
  if (!row) throw notFound('Workspace');
  assertCan('createInWorkspace', actor.ctx, row);
  return row;
}

/**
 * A folder the actor can read, else 404 (private folders of other members never show up). Inside a
 * transaction, `lock: true` takes `FOR UPDATE` on the row (a parent being added to).
 */
export async function readableFolder(
  db: Queryable,
  actor: Actor,
  id: string,
  options: { lock?: boolean } = {},
): Promise<FolderRow> {
  const query = db.select().from(folder).where(eq(folder.id, id));
  const [row] = options.lock ? await query.for('update') : await query;
  if (!row) throw notFound('Folder');
  if (!canReadFolder(actor.ctx, row)) throw notFound('Folder');
  return row;
}

/**
 * Serialises structural writes (create in a folder, move, delete) within one workspace for the rest of
 * the transaction. Cycle and D-18 subtree-ownership checks read the tree and then write it; without
 * this, two concurrent moves (A→B, B→A) could both pass and create a cycle, or a page created inside a
 * subtree mid-move could be swept private. Tree writes are rare, so one lock per workspace is cheap.
 */
export async function lockTree(tx: Tx, workspaceId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`oat:tree:${workspaceId}`}))`);
}

/**
 * The folder a new item goes into, checked and locked: readable (else 404, also when it belongs to
 * another workspace), and the actor may add to it. Call inside a transaction after `lockTree`.
 */
export async function parentForCreate(
  tx: Tx,
  actor: Actor,
  workspaceId: string,
  parentId: string,
): Promise<FolderRow> {
  const parent = await readableFolder(tx, actor, parentId, { lock: true });
  if (parent.workspaceId !== workspaceId) throw notFound('Folder');
  assertCan('createInFolder', actor.ctx, parent);
  return parent;
}

/** Ids of every folder below `id` (not including it). `union` keeps a corrupt cycle finite. */
export async function descendantFolderIds(db: Queryable, id: string): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    with recursive sub(id) as (
      select id from folder where parent_id = ${id}
      union
      select f.id from folder f join sub s on f.parent_id = s.id
    )
    select id from sub`);
  return Array.from(rows, (row) => row.id);
}

/** The folders below `id` and every document (incl. trashed) filed in `id` or below. */
async function subtree(db: Queryable, id: string) {
  const folderIds = await descendantFolderIds(db, id);
  const folders = folderIds.length
    ? await db.select().from(folder).where(inArray(folder.id, folderIds))
    : [];
  const documents = await db
    .select({
      id: document.id,
      workspaceId: document.workspaceId,
      ownerId: document.ownerId,
      visibility: document.visibility,
      shareToken: document.shareToken,
      deletedAt: document.deletedAt,
    })
    .from(document)
    .where(inArray(document.folderId, [id, ...folderIds]));
  return { folderIds, folders, documents };
}

/** Folders of a workspace the actor can see (workspace folders + their own private ones). */
export async function listFolders(
  db: Queryable,
  actor: Actor,
  workspaceId: string,
): Promise<FolderSummary[]> {
  requireMember(actor, workspaceId);
  const rows = await db
    .select()
    .from(folder)
    .where(
      and(
        eq(folder.workspaceId, workspaceId),
        or(eq(folder.visibility, 'workspace'), eq(folder.ownerId, actor.userId)),
      ),
    )
    .orderBy(asc(folder.createdAt), asc(folder.id));
  return rows.map((row) => toFolderSummary(actor, row));
}

export async function createFolder(
  db: Db,
  actor: Actor,
  input: {
    workspaceId: string;
    parentId?: string | null;
    name: string;
    visibility?: FolderVisibility;
  },
): Promise<FolderSummary> {
  const ws = await workspaceForCreate(db, actor, input.workspaceId);
  const name = normalizeName(input.name);
  if (!name) throw badRequest('Give the folder a name.');
  return db.transaction(async (tx) => {
    let parent: FolderRow | null = null;
    if (input.parentId) {
      await lockTree(tx, ws.id);
      parent = await parentForCreate(tx, actor, ws.id, input.parentId);
    }
    const visibility = visibilityForNewItem(
      parent,
      input.visibility ?? parent?.visibility ?? 'private',
    ) as FolderVisibility;
    const [row] = await tx
      .insert(folder)
      .values({
        workspaceId: ws.id,
        parentId: parent?.id ?? null,
        name,
        visibility,
        ownerId: actor.userId,
      })
      .returning();
    return toFolderSummary(actor, row!);
  });
}

export async function renameFolder(
  db: Db,
  actor: Actor,
  id: string,
  input: { name: string },
): Promise<FolderSummary> {
  const row = await readableFolder(db, actor, id);
  assertCan('editFolder', actor.ctx, row);
  const name = normalizeName(input.name);
  if (!name) throw badRequest('Give the folder a name.');
  const [updated] = await db.update(folder).set({ name }).where(eq(folder.id, id)).returning();
  if (!updated) throw notFound('Folder');
  return toFolderSummary(actor, updated);
}

/**
 * Moves a folder under `parentId` (`null` = workspace root). D-18 via `decideMoveFolder`: same workspace,
 * edit rights, and into a private folder only when the actor owns both and everything inside; then the
 * folder and its whole subtree become private (needs `makePrivate`). Cycles are refused here.
 */
export async function moveFolder(
  db: Db,
  actor: Actor,
  id: string,
  input: { parentId: string | null; makePrivate?: boolean },
): Promise<FolderSummary> {
  const { workspaceId } = await readableFolder(db, actor, id);
  return db.transaction(async (tx) => {
    await lockTree(tx, workspaceId);
    // Re-read under the lock: everything below is checked against the current tree.
    const row = await readableFolder(tx, actor, id);
    const target = input.parentId ? await readableFolder(tx, actor, input.parentId) : null;
    // Another workspace's folder looks like any unknown folder.
    if (target && target.workspaceId !== row.workspaceId) throw notFound('Folder');
    const sub = await subtree(tx, id);
    if (target && (target.id === id || sub.folderIds.includes(target.id))) {
      throw badRequest('A folder can’t be moved into itself.');
    }
    const ownerIds = [...sub.folders.map((f) => f.ownerId), ...sub.documents.map((d) => d.ownerId)];
    const decision = assertCanMoveFolder(actor.ctx, row, target, ownerIds);
    if (decision.setVisibility && !input.makePrivate) throw confirmPrivate();

    const [updated] = await tx
      .update(folder)
      .set({
        parentId: target?.id ?? null,
        ...(decision.setVisibility ? { visibility: decision.setVisibility } : {}),
      })
      .where(eq(folder.id, id))
      .returning();
    if (decision.setVisibility) {
      // Everything inside a private folder is private (D-18); the actor owns all of it (checked above).
      if (sub.folderIds.length) {
        await tx
          .update(folder)
          .set({ visibility: 'private' })
          .where(and(inArray(folder.id, sub.folderIds), ne(folder.visibility, 'private')));
      }
      await tx
        .update(document)
        .set({ visibility: 'private', version: sql`${document.version} + 1` })
        .where(
          and(
            inArray(document.folderId, [id, ...sub.folderIds]),
            ne(document.visibility, 'private'),
          ),
        );
    }
    return toFolderSummary(actor, updated!);
  });
}

/**
 * Deletes a folder and its subfolders; every live document inside goes to the trash (and comes back at
 * the root when restored, since the folder is gone). Refused unless the actor may delete every folder and
 * every document in the subtree, so nobody trashes items they couldn't delete one by one.
 */
export async function deleteFolder(
  db: Db,
  actor: Actor,
  id: string,
): Promise<{ trashedDocumentIds: string[] }> {
  const { workspaceId } = await readableFolder(db, actor, id);
  return db.transaction(async (tx) => {
    await lockTree(tx, workspaceId);
    const row = await readableFolder(tx, actor, id);
    assertCan('deleteFolder', actor.ctx, row);
    const sub = await subtree(tx, id);
    const live = sub.documents.filter((d) => d.deletedAt === null);
    // Same generic 403 as any other refusal: don't hint at items the actor may not even see.
    if (
      sub.folders.some((f) => !canDeleteFolder(actor.ctx, f)) ||
      live.some((d) => !canDeleteDocument(actor.ctx, d))
    ) {
      throw forbidden();
    }
    const ids = live.map((d) => d.id);
    if (ids.length) {
      await tx
        .update(document)
        .set({ deletedAt: new Date(), version: sql`${document.version} + 1` })
        .where(and(inArray(document.id, ids), isNull(document.deletedAt)));
    }
    // Subfolders cascade; their documents' folder_id becomes null (FK `set null`).
    await tx.delete(folder).where(eq(folder.id, id));
    return { trashedDocumentIds: ids };
  });
}
