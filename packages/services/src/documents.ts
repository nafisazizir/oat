import {
  assertCan,
  assertCanMoveDocument,
  canDeleteDocument,
  canEditDocument,
  canReadDocument,
  type DocumentKind,
  visibilityForNewItem,
} from '@oat/core';
import { type Db, document, type DocumentRow, type FolderRow } from '@oat/db';
import { emptyDoc, ensureBlockIds, type JSONContent, validateDoc } from '@oat/editor';
import { toMarkdown } from '@oat/editor/markdown';
import { and, asc, desc, eq, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';

import type { DocumentDetail, DocumentSummary } from './dto/api-types.ts';

import type { Actor } from './actor.ts';
import {
  badRequest,
  confirmPrivate,
  invalidContent,
  notFound,
  notInTrash,
  staleVersion,
} from './errors.ts';
import {
  lockTree,
  MAX_NAME_LENGTH,
  parentForCreate,
  type Queryable,
  readableFolder,
  requireMember,
  workspaceForCreate,
} from './folders.ts';

/*
 * Document data access (SPEC §4/§6). Every function takes the acting user, loads the row, and asks
 * `@oat/core` (`canReadDocument`, `assertCan`, `assertCanMoveDocument`) before reading or writing.
 * - Unreadable = 404, also for documents that exist but are private to someone else (no existence leak);
 *   readable but not allowed = 403.
 * - Every accepted write bumps `version` (D-19); content/title updates must carry the `baseVersion` they
 *   were made on, and a stale one is refused with 409 + the server copy.
 * - `change_log` rows are written by Postgres triggers (D-22); nothing to do here.
 * - Content writes are validated with `validateDoc` (the editor's schema + attribute rules), get block ids
 *   (`ensureBlockIds`) and a derived `content_md` (`toMarkdown`, D-4: JSON canonical, Markdown derived).
 */

/** Columns for lists: everything but the (possibly large) content. */
const summaryColumns = {
  id: document.id,
  workspaceId: document.workspaceId,
  folderId: document.folderId,
  ownerId: document.ownerId,
  kind: document.kind,
  title: document.title,
  visibility: document.visibility,
  shareToken: document.shareToken,
  version: document.version,
  createdAt: document.createdAt,
  updatedAt: document.updatedAt,
  deletedAt: document.deletedAt,
};
type SummaryRow = Omit<
  DocumentRow,
  'contentJson' | 'contentMd' | 'shareTranscript' | 'conflictOfId' | 'conflictDevice' | 'conflictAt'
>;

export function toSummary(actor: Actor, row: SummaryRow): DocumentSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    folderId: row.folderId,
    ownerId: row.ownerId,
    kind: row.kind,
    title: row.title,
    visibility: row.visibility,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
    access: { edit: canEditDocument(actor.ctx, row), delete: canDeleteDocument(actor.ctx, row) },
  };
}

export function toDetail(actor: Actor, row: DocumentRow): DocumentDetail {
  return { ...toSummary(actor, row), contentJson: row.contentJson as JSONContent };
}

/** Validated content + its derived Markdown, or 400 `invalid_content`. */
export function prepareContent(json: unknown): { contentJson: JSONContent; contentMd: string } {
  const checked = validateDoc(json);
  if (!checked.ok) throw invalidContent(checked.error);
  const contentJson = ensureBlockIds(json as JSONContent);
  return { contentJson, contentMd: toMarkdown(contentJson) };
}

/** One-line title; empty is allowed ("Untitled" is a display concern). */
export function normalizeTitle(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

async function loadRow(db: Queryable, id: string): Promise<DocumentRow | undefined> {
  const [row] = await db.select().from(document).where(eq(document.id, id));
  return row;
}

/** A document the actor can read (trashed ones included, per `canReadDocument`), else 404. */
async function readableRow(db: Queryable, actor: Actor, id: string): Promise<DocumentRow> {
  const row = await loadRow(db, id);
  if (!row || !canReadDocument(actor.ctx, row)) throw notFound();
  return row;
}

export async function getDocument(db: Db, actor: Actor, id: string): Promise<DocumentDetail> {
  return toDetail(actor, await readableRow(db, actor, id));
}

/**
 * Documents of a workspace the actor can read: live ones for the tree, or trashed ones (`trash: true`)
 * for the trash view. Ordered oldest first (new pages append to the tree).
 */
export async function listDocuments(
  db: Db,
  actor: Actor,
  workspaceId: string,
  options: { trash?: boolean } = {},
): Promise<DocumentSummary[]> {
  requireMember(actor, workspaceId);
  const rows = await db
    .select(summaryColumns)
    .from(document)
    .where(
      and(
        eq(document.workspaceId, workspaceId),
        options.trash ? isNotNull(document.deletedAt) : isNull(document.deletedAt),
        // Cheap pre-filter; `canReadDocument` below is the rule.
        or(ne(document.visibility, 'private'), eq(document.ownerId, actor.userId)),
      ),
    )
    .orderBy(options.trash ? desc(document.deletedAt) : asc(document.createdAt), asc(document.id));
  return rows.filter((row) => canReadDocument(actor.ctx, row)).map((row) => toSummary(actor, row));
}

/** Most recently edited live documents of one kind (Home). */
export async function listRecentDocuments(
  db: Db,
  actor: Actor,
  workspaceId: string,
  options: { kind?: DocumentKind; limit: number },
): Promise<DocumentSummary[]> {
  requireMember(actor, workspaceId);
  const rows = await db
    .select(summaryColumns)
    .from(document)
    .where(
      and(
        eq(document.workspaceId, workspaceId),
        isNull(document.deletedAt),
        options.kind ? eq(document.kind, options.kind) : undefined,
        or(ne(document.visibility, 'private'), eq(document.ownerId, actor.userId)),
      ),
    )
    .orderBy(desc(document.updatedAt), asc(document.id))
    .limit(options.limit * 2);
  return rows
    .filter((row) => canReadDocument(actor.ctx, row))
    .slice(0, options.limit)
    .map((row) => toSummary(actor, row));
}

export async function createDocument(
  db: Db,
  actor: Actor,
  input: {
    workspaceId: string;
    folderId?: string | null;
    kind?: DocumentKind;
    title?: string;
    visibility?: 'private' | 'workspace';
    contentJson?: unknown;
  },
): Promise<DocumentDetail> {
  const ws = await workspaceForCreate(db, actor, input.workspaceId);
  const content = prepareContent(input.contentJson ?? emptyDoc());
  return db.transaction(async (tx) => {
    let parent: FolderRow | null = null;
    if (input.folderId) {
      // Serialised with folder moves/deletes, and the parent row locked (see `lockTree`).
      await lockTree(tx, ws.id);
      parent = await parentForCreate(tx, actor, ws.id, input.folderId);
    }
    // Default: the folder's visibility (pages created in a shared folder are shared), else private.
    const visibility = visibilityForNewItem(
      parent,
      input.visibility ?? parent?.visibility ?? 'private',
    );
    const [row] = await tx
      .insert(document)
      .values({
        workspaceId: ws.id,
        folderId: parent?.id ?? null,
        ownerId: actor.userId,
        kind: input.kind ?? 'page',
        title: normalizeTitle(input.title ?? ''),
        visibility,
        ...content,
      })
      .returning();
    return toDetail(actor, row!);
  });
}

/**
 * Title and/or content update with optimistic concurrency (D-19): applied only if the stored version
 * still equals `baseVersion` (checked in the UPDATE itself, so two racing writers can't both win).
 */
export async function updateDocument(
  db: Db,
  actor: Actor,
  id: string,
  input: { baseVersion: number; title?: string; contentJson?: unknown },
): Promise<DocumentDetail> {
  const row = await readableRow(db, actor, id);
  assertCan('editDocument', actor.ctx, row);
  if (input.title === undefined && input.contentJson === undefined) {
    throw badRequest('Nothing to update.');
  }
  const patch = {
    ...(input.title !== undefined ? { title: normalizeTitle(input.title) } : {}),
    ...(input.contentJson !== undefined ? prepareContent(input.contentJson) : {}),
  };
  const [updated] = await db
    .update(document)
    .set({ ...patch, version: sql`${document.version} + 1` })
    .where(
      and(eq(document.id, id), eq(document.version, input.baseVersion), isNull(document.deletedAt)),
    )
    .returning();
  if (updated) return toDetail(actor, updated);

  const current = await loadRow(db, id);
  if (!current || !canReadDocument(actor.ctx, current)) throw notFound();
  if (current.deletedAt) assertCan('editDocument', actor.ctx, current); // trashed meanwhile → 403
  throw staleVersion(toDetail(actor, current));
}

/**
 * Files a document into `folderId` (`null` = workspace root). D-18 via `decideMoveDocument`: same
 * workspace only; into a private folder only if the actor owns folder and document, and the document
 * becomes private (the caller confirms with `makePrivate`).
 */
export async function moveDocument(
  db: Db,
  actor: Actor,
  id: string,
  input: { folderId: string | null; makePrivate?: boolean },
): Promise<DocumentDetail> {
  const { workspaceId } = await readableRow(db, actor, id);
  return db.transaction(async (tx) => {
    // Serialised with folder moves/deletes so the target can't vanish or turn private mid-move.
    await lockTree(tx, workspaceId);
    const row = await readableRow(tx, actor, id);
    const target = input.folderId
      ? await readableFolder(tx, actor, input.folderId, { lock: true })
      : null;
    // Another workspace's folder looks like any unknown folder.
    if (target && target.workspaceId !== row.workspaceId) throw notFound('Folder');
    const decision = assertCanMoveDocument(actor.ctx, row, target);
    if (decision.setVisibility && !input.makePrivate) throw confirmPrivate();
    if (row.folderId === (target?.id ?? null) && !decision.setVisibility) {
      return toDetail(actor, row);
    }
    const [updated] = await tx
      .update(document)
      .set({
        folderId: target?.id ?? null,
        ...(decision.setVisibility ? { visibility: decision.setVisibility } : {}),
        version: sql`${document.version} + 1`,
      })
      .where(and(eq(document.id, id), isNull(document.deletedAt)))
      .returning();
    if (!updated) throw notFound();
    return toDetail(actor, updated);
  });
}

/** Moves a document to the trash (soft delete). Idempotent. */
export async function trashDocument(db: Db, actor: Actor, id: string): Promise<DocumentDetail> {
  const row = await readableRow(db, actor, id);
  assertCan('deleteDocument', actor.ctx, row);
  if (row.deletedAt) return toDetail(actor, row);
  const [updated] = await db
    .update(document)
    .set({ deletedAt: new Date(), version: sql`${document.version} + 1` })
    .where(eq(document.id, id))
    .returning();
  return toDetail(actor, updated!);
}

/** Brings a document back from the trash (to its folder, or the root if the folder was deleted). */
export async function restoreDocument(db: Db, actor: Actor, id: string): Promise<DocumentDetail> {
  const row = await readableRow(db, actor, id);
  assertCan('deleteDocument', actor.ctx, row);
  if (!row.deletedAt) return toDetail(actor, row);
  const [updated] = await db
    .update(document)
    .set({ deletedAt: null, version: sql`${document.version} + 1` })
    .where(eq(document.id, id))
    .returning();
  return toDetail(actor, updated!);
}

/** Permanently deletes a document that is already in the trash. */
export async function deleteDocumentForever(db: Db, actor: Actor, id: string): Promise<void> {
  const row = await readableRow(db, actor, id);
  assertCan('deleteDocument', actor.ctx, row);
  if (!row.deletedAt) throw notInTrash();
  await db.delete(document).where(and(eq(document.id, id), isNotNull(document.deletedAt)));
}
