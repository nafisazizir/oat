import 'server-only';

import {
  canDeleteDocument,
  canEditDocument,
  canReadDocument,
  type SyncConflictResolve,
} from '@oat/core';
import { type Db, document, type DocumentRow } from '@oat/db';
import type { JSONContent } from '@oat/editor';
import { and, eq, sql } from 'drizzle-orm';

import type { Actor } from '../actor';
import { ApiError, forbidden, notFound } from '../api/errors';
import { normalizeTitle, prepareContent } from '../documents';

/*
 * Conflicted copies (D-19, 3.5). A copy is an ordinary private page with `conflict_of_id` pointing at the
 * document whose newer server version beat a device's edit; `conflict_device` / `conflict_at` say whose
 * edit and when. The banner on the copy compares both and resolves:
 * - keep `copy`: the copy's title (without the " (conflicted copy)" suffix) and body become a new version
 *   of the original (needs edit rights on it; `baseVersion` guards against a third edit since the compare);
 * - keep `original`: nothing changes on the original.
 * Either way the copy moves to the trash (recoverable, like any deleted page).
 */

const SUFFIX = ' (conflicted copy)';

export interface ConflictSide {
  id: string;
  title: string;
  contentJson: JSONContent;
  version: number;
  updatedAt: string;
}

export interface ConflictDetail {
  copy: ConflictSide & { device: string | null; at: string | null };
  /** `null` when the original is gone or the user can't read it any more. */
  original: (ConflictSide & { editable: boolean; deleted: boolean }) | null;
  /** The user may trash the copy (and so resolve the conflict). */
  canResolve: boolean;
}

const side = (row: DocumentRow): ConflictSide => ({
  id: row.id,
  title: row.title,
  contentJson: row.contentJson as JSONContent,
  version: row.version,
  updatedAt: row.updatedAt.toISOString(),
});

export function stripSuffix(title: string): string {
  return title.endsWith(SUFFIX) ? title.slice(0, -SUFFIX.length) : title;
}

async function load(db: Db, id: string): Promise<DocumentRow | undefined> {
  const [row] = await db.select().from(document).where(eq(document.id, id));
  return row;
}

/** The conflict a live copy belongs to, or `null` when `copyId` isn't a readable, live conflicted copy. */
export async function getConflict(
  db: Db,
  actor: Actor,
  copyId: string,
): Promise<ConflictDetail | null> {
  const copy = await load(db, copyId);
  if (!copy || !copy.conflictOfId || copy.deletedAt || !canReadDocument(actor.ctx, copy)) {
    return null;
  }
  const original = await load(db, copy.conflictOfId);
  const readable = original && canReadDocument(actor.ctx, original) ? original : null;
  return {
    copy: {
      ...side(copy),
      device: copy.conflictDevice,
      at: copy.conflictAt?.toISOString() ?? null,
    },
    original: readable && {
      ...side(readable),
      editable: canEditDocument(actor.ctx, readable),
      deleted: readable.deletedAt !== null,
    },
    canResolve: canDeleteDocument(actor.ctx, copy),
  };
}

/** `GET /api/sync/conflicts/:id`. */
export async function requireConflict(db: Db, actor: Actor, copyId: string) {
  const conflict = await getConflict(db, actor, copyId);
  if (!conflict) throw notFound('Conflicted copy');
  return conflict;
}

/** `POST /api/sync/conflicts/:id` — see the module comment. Returns the original's new state. */
export async function resolveConflict(
  db: Db,
  actor: Actor,
  copyId: string,
  input: SyncConflictResolve,
): Promise<{ originalId: string | null; originalVersion: number | null }> {
  return db.transaction(async (tx) => {
    const [copy] = await tx.select().from(document).where(eq(document.id, copyId)).for('update');
    if (!copy || !copy.conflictOfId || copy.deletedAt || !canReadDocument(actor.ctx, copy)) {
      throw notFound('Conflicted copy');
    }
    if (!canDeleteDocument(actor.ctx, copy)) throw forbidden();
    let result = {
      originalId: copy.conflictOfId as string | null,
      originalVersion: null as number | null,
    };
    if (input.keep === 'copy') {
      const [original] = await tx
        .select()
        .from(document)
        .where(eq(document.id, copy.conflictOfId))
        .for('update');
      if (!original || !canReadDocument(actor.ctx, original)) throw notFound('Original document');
      if (!canEditDocument(actor.ctx, original)) {
        throw forbidden('You can’t edit the original, so its copy can’t replace it.');
      }
      if (input.baseVersion !== undefined && input.baseVersion !== original.version) {
        throw new ApiError(
          409,
          'stale_version',
          'The original changed since you compared them. Compare again.',
        );
      }
      const content = prepareContent(copy.contentJson);
      const [updated] = await tx
        .update(document)
        .set({
          title: normalizeTitle(stripSuffix(copy.title)),
          ...content,
          version: sql`${document.version} + 1`,
        })
        .where(and(eq(document.id, original.id), eq(document.version, original.version)))
        .returning();
      result = { originalId: original.id, originalVersion: updated!.version };
    }
    await tx
      .update(document)
      .set({ deletedAt: new Date(), version: sql`${document.version} + 1` })
      .where(eq(document.id, copy.id));
    return result;
  });
}
