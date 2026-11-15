/** Reading the trigger-written change log (D-19, D-22). See `schema/sync.ts` for the ordering argument. */
import { and, asc, inArray, sql } from 'drizzle-orm';
import type { Db } from './client.ts';
import { changeLog, type ChangeOp, type SyncedTable } from './schema/index.ts';

export interface Change {
  seq: number;
  /** Writing transaction (xid8 as a decimal string). */
  txid: string;
  tableName: SyncedTable;
  rowId: string;
  workspaceId: string;
  op: ChangeOp;
}

export interface ChangePage {
  changes: Change[];
  /** Pass back to continue after the last returned change. Unchanged (possibly `null`) when nothing new. */
  cursor: string | null;
  /** More visible changes exist beyond `limit`; call again right away. */
  hasMore: boolean;
}

const CURSOR = /^(\d{1,20})\.(\d{1,19})$/;

/** Opaque to clients: `<txid>.<seq>` of the last change returned. */
export function encodeCursor(change: Pick<Change, 'txid' | 'seq'>): string {
  return `${change.txid}.${change.seq}`;
}

export function decodeCursor(cursor: string): { txid: string; seq: string } {
  const m = CURSOR.exec(cursor);
  if (!m) throw new Error('invalid change cursor');
  return { txid: m[1]!, seq: m[2]! };
}

/**
 * Changes in `workspaceIds` after `cursor` (`null` = from the beginning), oldest first. Only returns rows
 * from transactions older than every transaction still in flight, so a transaction that commits after a
 * later-numbered one is never skipped: its rows simply appear once it (and everything before it) is done.
 */
export async function readChanges(
  db: Db,
  workspaceIds: readonly string[],
  cursor: string | null,
  options: { limit?: number } = {},
): Promise<ChangePage> {
  const limit = options.limit ?? 500;
  if (workspaceIds.length === 0) return { changes: [], cursor, hasMore: false };
  const after = cursor === null ? undefined : decodeCursor(cursor);

  const rows = await db
    .select({
      seq: changeLog.seq,
      txid: sql<string>`${changeLog.txid}::text`,
      tableName: changeLog.tableName,
      rowId: changeLog.rowId,
      workspaceId: changeLog.workspaceId,
      op: changeLog.op,
    })
    .from(changeLog)
    .where(
      and(
        inArray(changeLog.workspaceId, [...workspaceIds]),
        sql`${changeLog.txid} < pg_snapshot_xmin(pg_current_snapshot())`,
        after &&
          sql`(${changeLog.txid}, ${changeLog.seq}) > (${after.txid}::xid8, ${after.seq}::bigint)`,
      ),
    )
    .orderBy(asc(changeLog.txid), asc(changeLog.seq))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const changes = hasMore ? rows.slice(0, limit) : rows;
  const last = changes.at(-1);
  return { changes, cursor: last ? encodeCursor(last) : cursor, hasMore };
}

/**
 * Like {@link readChanges}, across every workspace: for trusted server-side consumers (the 6.1 indexer), never
 * for client pulls. Same visibility rule and cursor format; `tables` narrows to the tables the caller cares
 * about (the cursor still advances past the others only as far as the returned rows).
 */
export async function readAllChanges(
  db: Db,
  cursor: string | null,
  options: { limit?: number; tables?: readonly SyncedTable[] } = {},
): Promise<ChangePage> {
  const limit = options.limit ?? 500;
  const after = cursor === null ? undefined : decodeCursor(cursor);
  const rows = await db
    .select({
      seq: changeLog.seq,
      txid: sql<string>`${changeLog.txid}::text`,
      tableName: changeLog.tableName,
      rowId: changeLog.rowId,
      workspaceId: changeLog.workspaceId,
      op: changeLog.op,
    })
    .from(changeLog)
    .where(
      and(
        options.tables && inArray(changeLog.tableName, [...options.tables]),
        sql`${changeLog.txid} < pg_snapshot_xmin(pg_current_snapshot())`,
        after &&
          sql`(${changeLog.txid}, ${changeLog.seq}) > (${after.txid}::xid8, ${after.seq}::bigint)`,
      ),
    )
    .orderBy(asc(changeLog.txid), asc(changeLog.seq))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const changes = hasMore ? rows.slice(0, limit) : rows;
  const last = changes.at(-1);
  return { changes, cursor: last ? encodeCursor(last) : cursor, hasMore };
}
