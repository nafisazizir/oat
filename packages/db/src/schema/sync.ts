/**
 * Server-side change log (D-19, D-22). One row per write to a synced row, appended by Postgres triggers
 * (`oat_log_change()`, migration `0002_change_log_triggers.sql`) so Better Auth writes (`membership`,
 * `invite`, `workspace`) and FK cascades are captured too, not just app code.
 *
 * Ordering: `seq` is assigned at insert, not at commit, so seqs commit out of order and a plain
 * `seq > cursor` pull would skip rows from a transaction that commits late. Each row therefore carries the
 * writing transaction's `txid` (xid8), and readers (`readChanges()` in `sync.ts`) only return rows whose
 * transaction is older than every transaction still running (`txid < pg_snapshot_xmin(pg_current_snapshot())`),
 * ordered by `(txid, seq)`. Every later row then has a larger txid, so a `(txid, seq)` cursor never misses one.
 * Cost: one long-running transaction delays everyone's pulls until it finishes.
 *
 * `workspace_id` has no FK on purpose: a workspace's own delete (and its cascade) must still be loggable, and
 * old rows outlive their workspace until pruned (3.5).
 */
import { sql } from 'drizzle-orm';
import {
  bigserial,
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
} from 'drizzle-orm/pg-core';
import { createdAt } from './columns.ts';
import { document } from './documents.ts';
import { changeOpEnum } from './enums.ts';

/** Postgres `xid8` (64-bit, wraparound-free transaction id), read as a decimal string. */
export const xid8 = customType<{ data: string; driverData: string }>({
  dataType: () => 'xid8',
});

/** Tables whose writes are logged (each has an `oat_log_change` trigger). Keep in sync with the migration. */
export const SYNCED_TABLES = [
  'workspace',
  'membership',
  'invite',
  'folder',
  'document',
  'meeting',
  'participant',
  'transcript_segment',
  'enhancement',
  'template',
  'chat_thread',
  'chat_message',
] as const;
export type SyncedTable = (typeof SYNCED_TABLES)[number];

export const changeLog = pgTable(
  'change_log',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    txid: xid8('txid')
      .notNull()
      .default(sql`pg_current_xact_id()`),
    /** SQL table name of the changed row, e.g. `document`, `transcript_segment`. */
    tableName: text('table_name').$type<SyncedTable>().notNull(),
    rowId: text('row_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    op: changeOpEnum('op').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('change_log_workspace_txid_seq_idx').on(t.workspaceId, t.txid, t.seq),
    // Server-side consumers that follow every workspace (the 6.1 indexer: `readAllChanges`).
    index('change_log_txid_seq_idx').on(t.txid, t.seq),
  ],
);

/**
 * Texts a sync push wrote into a document (3.5): `content_key` = SHA-256 (base64url) of `@oat/core`
 * `documentContentKey(title, content)`, the last 20 per document. A push on a stale base whose text is
 * one of these is a replay of a write that already landed (its answer was lost, and someone may have
 * edited since): answered `ok`, never turned into a conflicted copy.
 */
export const syncReceipt = pgTable(
  'sync_receipt',
  {
    documentId: text('document_id')
      .notNull()
      .references(() => document.id, { onDelete: 'cascade' }),
    contentKey: text('content_key').notNull(),
    version: integer('version').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.documentId, t.contentKey] })],
);
