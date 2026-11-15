/** Reading the trigger-written change log (D-19, D-22). See `schema/sync.ts` for the ordering argument. */
import { and, asc, desc, inArray, sql } from 'drizzle-orm';
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

/**
 * The cursor of the newest change in `workspaceIds` that {@link readChanges} would serve right now (`null`
 * when there is none): where a live listener (the 3.5 SSE channel) starts when it has nothing to replay.
 */
export async function headCursor(db: Db, workspaceIds: readonly string[]): Promise<string | null> {
  if (workspaceIds.length === 0) return null;
  const [row] = await db
    .select({ seq: changeLog.seq, txid: sql<string>`${changeLog.txid}::text` })
    .from(changeLog)
    .where(
      and(
        inArray(changeLog.workspaceId, [...workspaceIds]),
        sql`${changeLog.txid} < pg_snapshot_xmin(pg_current_snapshot())`,
      ),
    )
    .orderBy(desc(changeLog.txid), desc(changeLog.seq))
    .limit(1);
  return row ? encodeCursor(row) : null;
}

/**
 * Whether committed changes in `workspaceIds` after `cursor` are being held back by the D-22 visibility rule
 * (an older transaction somewhere in the cluster is still open). A pull that comes back with this set
 * isn't complete yet: the client should try again shortly rather than wait for its next scheduled pull.
 */
export async function hasHeldBackChanges(
  db: Db,
  workspaceIds: readonly string[],
  cursor: string | null,
): Promise<boolean> {
  if (workspaceIds.length === 0) return false;
  const after = cursor === null ? undefined : decodeCursor(cursor);
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(changeLog)
    .where(
      and(
        inArray(changeLog.workspaceId, [...workspaceIds]),
        sql`${changeLog.txid} >= pg_snapshot_xmin(pg_current_snapshot())`,
        after &&
          sql`(${changeLog.txid}, ${changeLog.seq}) > (${after.txid}::xid8, ${after.seq}::bigint)`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

export interface LongTransaction {
  pid: number;
  /** Seconds since the transaction started. */
  ageSeconds: number;
  /** `active`, `idle in transaction`, … */
  state: string | null;
  applicationName: string | null;
  database: string | null;
}

/**
 * Transactions in the cluster open for at least `minAgeMs` that hold back the xmin horizon (they have an
 * xid or a snapshot): what stalls every change-log reader (D-22). For diagnostics/logs; no query text.
 */
export async function longTransactions(db: Db, minAgeMs = 5_000): Promise<LongTransaction[]> {
  const rows = await db.$client<
    {
      pid: number;
      age_seconds: number;
      state: string | null;
      application_name: string | null;
      datname: string | null;
    }[]
  >`
    select pid, extract(epoch from now() - xact_start)::float8 as age_seconds, state,
           application_name, datname
    from pg_stat_activity
    where xact_start is not null
      and xact_start < now() - make_interval(secs => ${minAgeMs / 1000})
      and (backend_xid is not null or backend_xmin is not null)
      and pid <> pg_backend_pid()
    order by xact_start
    limit 20`;
  return rows.map((r) => ({
    pid: r.pid,
    ageSeconds: Number(r.age_seconds),
    state: r.state,
    applicationName: r.application_name,
    database: r.datname,
  }));
}
