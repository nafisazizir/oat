/**
 * Backfill: (re-)index every document, e.g. after enabling indexing on existing data, changing the embedding
 * model, or losing the queue. Idempotent and cheap on already-indexed data (unchanged chunks aren't
 * re-embedded). Inline by default; `enqueue` hands the work to running workers instead.
 */
import { type Db, document } from '@oat/db';
import { and, asc, eq, gt } from 'drizzle-orm';
import { syncActionItems } from './action-items.ts';
import { type IndexerDeps, indexDocument, type IndexResult } from './indexer.ts';
import type { IndexQueue } from './queue.ts';

export interface BackfillOptions {
  /** Only this workspace. */
  workspaceId?: string;
  /** Documents indexed at once (inline mode). Default 4. */
  concurrency?: number;
  /** Enqueue `document:<id>` jobs instead of indexing inline. */
  queue?: IndexQueue;
  onProgress?: (done: number, result?: IndexResult) => void;
}

export interface BackfillTotals {
  documents: number;
  inserted: number;
  updated: number;
  deleted: number;
  unchanged: number;
  embedded: number;
  /** Chunks dropped by maxChunksPerDocument, summed. */
  truncated: number;
  failed: { documentId: string; error: string }[];
}

/** Document ids in id order (UUIDv7 ≈ creation order), a page at a time. */
async function* documentIds(db: Db, workspaceId: string | undefined, pageSize = 200) {
  let after: string | undefined;
  for (;;) {
    const rows = await db
      .select({ id: document.id })
      .from(document)
      .where(
        and(
          workspaceId ? eq(document.workspaceId, workspaceId) : undefined,
          after ? gt(document.id, after) : undefined,
        ),
      )
      .orderBy(asc(document.id))
      .limit(pageSize);
    if (rows.length === 0) return;
    yield rows.map((r) => r.id);
    after = rows.at(-1)!.id;
  }
}

export async function backfill(
  deps: IndexerDeps,
  options: BackfillOptions = {},
): Promise<BackfillTotals> {
  const totals: BackfillTotals = {
    documents: 0,
    inserted: 0,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    embedded: 0,
    truncated: 0,
    failed: [],
  };
  const concurrency = Math.max(1, options.concurrency ?? 4);
  for await (const ids of documentIds(deps.db, options.workspaceId)) {
    if (options.queue) {
      await options.queue.enqueue(...ids.map((id) => ({ kind: 'document' as const, id })));
      totals.documents += ids.length;
      options.onProgress?.(totals.documents);
      continue;
    }
    for (let i = 0; i < ids.length; i += concurrency) {
      await Promise.all(
        ids.slice(i, i + concurrency).map(async (id) => {
          try {
            // Action items first (8.4): cheap, and independent of the embedding provider.
            await syncActionItems(deps.db, id);
            const r = await indexDocument(deps, id);
            totals.inserted += r.inserted;
            totals.updated += r.updated;
            totals.deleted += r.deleted;
            totals.unchanged += r.unchanged;
            totals.embedded += r.embedded;
            totals.truncated += r.truncated;
            totals.documents += 1;
            options.onProgress?.(totals.documents, r);
          } catch (error) {
            totals.failed.push({
              documentId: id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }),
      );
    }
  }
  return totals;
}
