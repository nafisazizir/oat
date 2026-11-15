/**
 * Action items (8.4): queries over `action_item`, the derived table of every document's task items.
 *
 * - {@link replaceDocumentActionItems}: the one writer's primitive (indexing worker, task toggle write-through).
 *   Idempotent: upserts per (document, block) and deletes rows whose block is gone, in one transaction under a
 *   per-document advisory lock. Rows extracted from an older document version than the stored ones are
 *   skipped, so a slow worker never overwrites a newer write-through.
 * - {@link listActionItems}: permission-filtered in SQL with the same rule as search/retrieval (member of a live
 *   workspace, live document, own or not private); callers re-check each row with `canReadDocument`.
 */
import type { DocumentKind, DocumentVisibility } from '@oat/core';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { Db } from './client.ts';
import { document } from './schema/documents.ts';
import { meeting } from './schema/meetings.ts';
import { actionItem } from './schema/tasks.ts';
import { workspace } from './schema/workspace.ts';

/** An action item as extracted from a document (before it is stored). */
export interface ActionItemDraft {
  blockId: string;
  ordinal: number;
  text: string;
  ownerUserId: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  /** `YYYY-MM-DD` or null. */
  due: string | null;
  done: boolean;
}

export interface ReplaceActionItemsResult {
  /** `stale`: newer rows were already stored (nothing written). */
  status: 'written' | 'stale';
  inserted: number;
  updated: number;
  deleted: number;
  unchanged: number;
}

/** Longest stored item text (characters). */
export const MAX_ACTION_ITEM_TEXT = 2000;

const same = (row: ActionItemDraft, draft: ActionItemDraft) =>
  row.ordinal === draft.ordinal &&
  row.text === draft.text &&
  row.ownerUserId === draft.ownerUserId &&
  row.ownerName === draft.ownerName &&
  row.ownerEmail === draft.ownerEmail &&
  row.due === draft.due &&
  row.done === draft.done;

/**
 * Makes the stored action items of `documentId` exactly `drafts` (extracted from `documentVersion`). Duplicate
 * block ids keep the first draft.
 */
export async function replaceDocumentActionItems(
  db: Db,
  target: { documentId: string; workspaceId: string; documentVersion: number },
  drafts: readonly ActionItemDraft[],
): Promise<ReplaceActionItemsResult> {
  const unique = new Map<string, ActionItemDraft>();
  for (const draft of drafts) {
    if (!unique.has(draft.blockId)) {
      unique.set(draft.blockId, { ...draft, text: draft.text.slice(0, MAX_ACTION_ITEM_TEXT) });
    }
  }
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`action_item:${target.documentId}`}, 0))`,
    );
    const rows = await tx
      .select({
        id: actionItem.id,
        blockId: actionItem.blockId,
        ordinal: actionItem.ordinal,
        text: actionItem.text,
        ownerUserId: actionItem.ownerUserId,
        ownerName: actionItem.ownerName,
        ownerEmail: actionItem.ownerEmail,
        due: actionItem.due,
        done: actionItem.done,
        workspaceId: actionItem.workspaceId,
        documentVersion: actionItem.documentVersion,
      })
      .from(actionItem)
      .where(eq(actionItem.documentId, target.documentId));
    const result: ReplaceActionItemsResult = {
      status: 'written',
      inserted: 0,
      updated: 0,
      deleted: 0,
      unchanged: 0,
    };
    // Version guard: rows from a newer document version win. A document with no stored rows has nothing to
    // compare against, so a stale run can write there; harmless, because the newer write's change_log row
    // re-runs this document's job afterwards (the queue re-runs a job that was re-enqueued while active).
    if (rows.some((r) => r.documentVersion > target.documentVersion)) {
      return { ...result, status: 'stale' };
    }
    const byBlock = new Map(rows.map((r) => [r.blockId, r]));
    const gone = rows.filter((r) => !unique.has(r.blockId)).map((r) => r.id);
    if (gone.length > 0) {
      await tx.delete(actionItem).where(inArray(actionItem.id, gone));
      result.deleted = gone.length;
    }
    for (const draft of unique.values()) {
      const row = byBlock.get(draft.blockId);
      if (row && same(row, draft) && row.workspaceId === target.workspaceId) {
        result.unchanged++;
        if (row.documentVersion !== target.documentVersion) {
          await tx
            .update(actionItem)
            .set({ documentVersion: target.documentVersion })
            .where(eq(actionItem.id, row.id));
        }
        continue;
      }
      const values = {
        workspaceId: target.workspaceId,
        documentId: target.documentId,
        documentVersion: target.documentVersion,
        ...draft,
      };
      if (row) {
        await tx.update(actionItem).set(values).where(eq(actionItem.id, row.id));
        result.updated++;
      } else {
        await tx.insert(actionItem).values(values);
        result.inserted++;
      }
    }
    return result;
  });
}

// ---------------------------------------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------------------------------------

export const ACTION_ITEM_SCOPES = ['assigned', 'created', 'all'] as const;
/** `assigned`: owner is me (user id or email) · `created`: in documents I own · `all`: every readable item. */
export type ActionItemScope = (typeof ACTION_ITEM_SCOPES)[number];

export const ACTION_ITEM_STATUSES = ['open', 'done', 'all'] as const;
export type ActionItemStatus = (typeof ACTION_ITEM_STATUSES)[number];

export const ACTION_ITEM_DUE_FILTERS = ['any', 'overdue', 'soon'] as const;
/** `overdue`: due before today · `soon`: due today or within the next 7 days. */
export type ActionItemDueFilter = (typeof ACTION_ITEM_DUE_FILTERS)[number];

export interface ActionItemQuery {
  /** The reader. */
  userId: string;
  /** The reader's email(s), for owners known only by email. */
  emails?: readonly string[];
  /** Workspaces to search: the reader's memberships (all, or the active one). Empty → nothing. */
  workspaceIds: readonly string[];
  scope: ActionItemScope;
  status: ActionItemStatus;
  due?: ActionItemDueFilter;
  /** Today for the due filters (`YYYY-MM-DD`, the reader's local day). */
  today?: string;
  /** Default 500, at most 1000. */
  limit?: number;
}

export interface ActionItemListRow {
  id: string;
  blockId: string;
  ordinal: number;
  text: string;
  ownerUserId: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  due: string | null;
  done: boolean;
  updatedAt: Date;
  document: {
    id: string;
    workspaceId: string;
    ownerId: string;
    kind: DocumentKind;
    title: string;
    visibility: DocumentVisibility;
    shareToken: string | null;
    deletedAt: Date | null;
    version: number;
    createdAt: Date;
    /** The meeting's start, for meeting notes. */
    meetingStartedAt: Date | null;
  };
}

const addDaysIso = (day: string, n: number) => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

/** Action items the reader may see (permission rule in SQL), newest meetings first, items in note order. */
export async function listActionItems(
  db: Db,
  query: ActionItemQuery,
): Promise<ActionItemListRow[]> {
  if (query.workspaceIds.length === 0) return [];
  const limit = Math.min(Math.max(1, query.limit ?? 500), 1000);
  const emails = [...new Set((query.emails ?? []).map((e) => e.toLowerCase()).filter(Boolean))];

  const where: (SQL | undefined)[] = [
    inArray(document.workspaceId, [...query.workspaceIds]),
    eq(actionItem.workspaceId, document.workspaceId),
    isNull(document.deletedAt),
    isNull(workspace.deletedAt),
    or(eq(document.ownerId, query.userId), ne(document.visibility, 'private')),
  ];
  if (query.scope === 'assigned') {
    where.push(
      or(
        eq(actionItem.ownerUserId, query.userId),
        emails.length > 0
          ? and(
              isNull(actionItem.ownerUserId),
              inArray(sql`lower(${actionItem.ownerEmail})`, emails),
            )
          : undefined,
      ),
    );
  } else if (query.scope === 'created') {
    where.push(eq(document.ownerId, query.userId));
  }
  if (query.status === 'open') where.push(eq(actionItem.done, false));
  if (query.status === 'done') where.push(eq(actionItem.done, true));
  if (query.due && query.due !== 'any' && query.today) {
    if (query.due === 'overdue') where.push(lt(actionItem.due, query.today));
    else {
      where.push(gte(actionItem.due, query.today), lte(actionItem.due, addDaysIso(query.today, 7)));
    }
  }

  const when = sql<Date>`coalesce(${meeting.startedAt}, ${document.createdAt})`;
  const rows = await db
    .select({
      id: actionItem.id,
      blockId: actionItem.blockId,
      ordinal: actionItem.ordinal,
      text: actionItem.text,
      ownerUserId: actionItem.ownerUserId,
      ownerName: actionItem.ownerName,
      ownerEmail: actionItem.ownerEmail,
      due: actionItem.due,
      done: actionItem.done,
      updatedAt: actionItem.updatedAt,
      docId: document.id,
      docWorkspaceId: document.workspaceId,
      docOwnerId: document.ownerId,
      docKind: document.kind,
      docTitle: document.title,
      docVisibility: document.visibility,
      docShareToken: document.shareToken,
      docDeletedAt: document.deletedAt,
      docVersion: document.version,
      docCreatedAt: document.createdAt,
      meetingStartedAt: meeting.startedAt,
    })
    .from(actionItem)
    .innerJoin(document, eq(document.id, actionItem.documentId))
    .innerJoin(workspace, eq(workspace.id, document.workspaceId))
    .leftJoin(meeting, eq(meeting.documentId, document.id))
    .where(and(...where))
    .orderBy(desc(when), asc(document.id), asc(actionItem.ordinal))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    blockId: r.blockId,
    ordinal: r.ordinal,
    text: r.text,
    ownerUserId: r.ownerUserId,
    ownerName: r.ownerName,
    ownerEmail: r.ownerEmail,
    due: r.due,
    done: r.done,
    updatedAt: r.updatedAt,
    document: {
      id: r.docId,
      workspaceId: r.docWorkspaceId,
      ownerId: r.docOwnerId,
      kind: r.docKind,
      title: r.docTitle,
      visibility: r.docVisibility,
      shareToken: r.docShareToken,
      deletedAt: r.docDeletedAt,
      version: r.docVersion,
      createdAt: r.docCreatedAt,
      meetingStartedAt: r.meetingStartedAt,
    },
  }));
}

/** One stored item with its document (for the toggle API). */
export async function getActionItem(
  db: Db,
  id: string,
): Promise<{ id: string; documentId: string; blockId: string; done: boolean } | undefined> {
  const [row] = await db
    .select({
      id: actionItem.id,
      documentId: actionItem.documentId,
      blockId: actionItem.blockId,
      done: actionItem.done,
    })
    .from(actionItem)
    .where(eq(actionItem.id, id));
  return row;
}
