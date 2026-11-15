/**
 * Indexes one document: chunk → hash → embed only what's new → reconcile the `chunk` rows (6.1).
 *
 * Idempotent: running it twice on unchanged content changes nothing and embeds nothing. A chunk whose text
 * (and embedding model) is unchanged keeps its row and embedding; only its ordinal/refs/time range are
 * updated if they moved. Rows for chunks that no longer exist are deleted.
 *
 * Bounded: at most `maxChunksPerDocument` chunks (the rest is dropped and reported as `truncated`), embedded
 * in batches of `embedBatchSize`. Each batch is stored as soon as it's embedded ("staged"), so a run that
 * fails halfway (provider error, crash, lease lost) never pays for those embeddings again: the retry finds
 * them by content hash. Staged rows of a run that never finishes are removed by the next run's reconcile.
 *
 * Concurrency: every write runs in a transaction under a per-document advisory lock, with the document row
 * `FOR KEY SHARE` (a document deleted meanwhile is skipped; its chunks cascaded). The queue keeps one job
 * per document (`document:<id>`), and the reconcile re-reads the document's `updated_at`/title under the lock:
 * if it changed since the drafts were cut (a rename racing a transcript update), the run starts over from
 * fresh content instead of writing stale text.
 */
import type { EmbeddingModelV4 } from '@ai-sdk/provider';
import { EMBEDDING_DIMENSIONS } from '@oat/core';
import {
  type ChunkSource,
  chunk,
  type Db,
  document,
  meeting,
  type NewChunkRow,
  transcriptSegment,
} from '@oat/db';
import { embedMany } from 'ai';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { chunkNotes, type NotesChunkOptions, type NotesDoc } from './chunk-notes.ts';
import { chunkTranscript, type TranscriptChunkOptions } from './chunk-transcript.ts';
import { chunkHash } from './text.ts';
import type { ChunkDraft } from './types.ts';

/** Default cap on chunks per document (≈ 400k tokens of notes + transcript, about 8 h of meeting). */
export const DEFAULT_MAX_CHUNKS_PER_DOCUMENT = 1000;
/** Default texts per embedding call. */
export const DEFAULT_EMBED_BATCH_SIZE = 64;
/** Restarts after a concurrent change before giving up (the job is retried later). */
const MAX_ROUNDS = 3;

export interface IndexerDeps {
  db: Db;
  embeddingModel: EmbeddingModelV4;
  notes?: Omit<NotesChunkOptions, 'title'>;
  transcript?: Omit<TranscriptChunkOptions, 'title'>;
  /** Default {@link DEFAULT_MAX_CHUNKS_PER_DOCUMENT} (`OAT_INDEX_MAX_CHUNKS`). */
  maxChunksPerDocument?: number;
  /** Default {@link DEFAULT_EMBED_BATCH_SIZE}. */
  embedBatchSize?: number;
}

export interface IndexResult {
  documentId: string;
  /** `missing`: the document no longer exists (nothing to do). */
  status: 'indexed' | 'missing';
  inserted: number;
  updated: number;
  deleted: number;
  unchanged: number;
  /** Texts sent to the embedding model. */
  embedded: number;
  /** Chunks dropped by `maxChunksPerDocument`. */
  truncated: number;
}

const ALL_SOURCES: readonly ChunkSource[] = ['notes', 'transcript'];

/** The key mixed into every chunk hash: switching models re-embeds everything. */
export function modelKey(model: EmbeddingModelV4): string {
  return `${model.provider}/${model.modelId}`;
}

/** Embeds `texts` and checks the vector width the `chunk` table expects. */
export async function embedTexts(model: EmbeddingModelV4, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const { embeddings } = await embedMany({ model, values: texts, maxRetries: 2 });
  for (const e of embeddings) {
    if (e.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `embedding model ${modelKey(model)} returned ${e.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`,
      );
    }
  }
  return embeddings;
}

interface Draft extends ChunkDraft {
  hash: string;
}

/**
 * Keeps at most `max` chunks: notes and transcript each get at least half when both are long, and either
 * can use what the other leaves. Returns the kept drafts (ordinals unchanged) and how many were dropped.
 */
export function capDrafts<T extends ChunkDraft>(
  drafts: T[],
  max: number,
): { kept: T[]; dropped: number } {
  if (drafts.length <= max) return { kept: drafts, dropped: 0 };
  const notes = drafts.filter((d) => d.source === 'notes');
  const transcript = drafts.filter((d) => d.source === 'transcript');
  const half = Math.ceil(max / 2);
  const notesKept = Math.min(notes.length, Math.max(half, max - transcript.length));
  const kept = [...notes.slice(0, notesKept), ...transcript.slice(0, max - notesKept)];
  return { kept, dropped: drafts.length - kept.length };
}

/** Chunks a document would have right now (for the given sources), with hashes. Uncapped. */
export async function draftChunks(
  deps: IndexerDeps,
  doc: { id: string; title: string; contentJson: unknown },
  sources: readonly ChunkSource[] = ALL_SOURCES,
): Promise<Draft[]> {
  const drafts: ChunkDraft[] = [];
  if (sources.includes('notes')) {
    drafts.push(...chunkNotes(doc.contentJson as NotesDoc, { ...deps.notes, title: doc.title }));
  }
  if (sources.includes('transcript')) {
    const segments = await deps.db
      .select({
        id: transcriptSegment.id,
        source: transcriptSegment.source,
        speakerLabel: transcriptSegment.speakerLabel,
        startMs: transcriptSegment.startMs,
        endMs: transcriptSegment.endMs,
        text: transcriptSegment.text,
      })
      .from(transcriptSegment)
      .innerJoin(meeting, eq(meeting.id, transcriptSegment.meetingId))
      .where(and(eq(meeting.documentId, doc.id), eq(transcriptSegment.isFinal, true)))
      .orderBy(asc(transcriptSegment.startMs), asc(transcriptSegment.id));
    drafts.push(...chunkTranscript(segments, { ...deps.transcript, title: doc.title }));
  }
  const key = modelKey(deps.embeddingModel);
  return drafts.map((d) => ({ ...d, hash: chunkHash(key, d.text) }));
}

const sameRefs = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** Drafts that have no stored row yet, counting duplicates (identical texts in one document). */
function unstored(drafts: Draft[], storedHashes: readonly string[]): Draft[] {
  const counts = new Map<string, number>();
  for (const h of storedHashes) counts.set(h, (counts.get(h) ?? 0) + 1);
  return drafts.filter((d) => {
    const n = counts.get(d.hash) ?? 0;
    if (n > 0) {
      counts.set(d.hash, n - 1);
      return false;
    }
    return true;
  });
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Advisory lock for the document's chunks + the document row; null if the document is gone. */
async function lockDocument(tx: Tx, documentId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`chunk:${documentId}`}, 0))`,
  );
  const [live] = await tx
    .select({
      workspaceId: document.workspaceId,
      title: document.title,
      updatedAt: document.updatedAt,
    })
    .from(document)
    .where(eq(document.id, documentId))
    .for('key share');
  return live ?? null;
}

const toRow = (
  documentId: string,
  workspaceId: string,
  d: Draft,
  embedding: number[],
): NewChunkRow => ({
  workspaceId,
  documentId,
  source: d.source,
  ordinal: d.ordinal,
  refIds: d.refIds,
  segmentStartMs: d.startMs,
  segmentEndMs: d.endMs,
  text: d.text,
  contentHash: d.hash,
  tokenCount: d.tokenCount,
  embedding,
});

/**
 * Re-indexes `sources` of one document. `transcript` covers the meeting attached to the document (none →
 * its transcript chunks are removed).
 */
export async function indexDocument(
  deps: IndexerDeps,
  documentId: string,
  options: { sources?: readonly ChunkSource[] } = {},
): Promise<IndexResult> {
  const { db, embeddingModel } = deps;
  const sources = options.sources ?? ALL_SOURCES;
  const maxChunks = Math.max(1, deps.maxChunksPerDocument ?? DEFAULT_MAX_CHUNKS_PER_DOCUMENT);
  const batchSize = Math.max(1, deps.embedBatchSize ?? DEFAULT_EMBED_BATCH_SIZE);
  const result: IndexResult = {
    documentId,
    status: 'indexed',
    inserted: 0,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    embedded: 0,
    truncated: 0,
  };
  const missing = () => ({ ...result, status: 'missing' as const });
  const forSources = and(eq(chunk.documentId, documentId), inArray(chunk.source, [...sources]));

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const [doc] = await db
      .select({
        id: document.id,
        title: document.title,
        contentJson: document.contentJson,
        updatedAt: document.updatedAt,
      })
      .from(document)
      .where(eq(document.id, documentId));
    if (!doc) return missing();

    const { kept: drafts, dropped } = capDrafts(await draftChunks(deps, doc, sources), maxChunks);
    result.truncated = dropped;

    // Stage: embed what isn't stored yet, a batch at a time, and store each batch right away.
    const stored = await db.select({ hash: chunk.contentHash }).from(chunk).where(forSources);
    const todo = unstored(
      drafts,
      stored.map((r) => r.hash),
    );
    for (let i = 0; i < todo.length; i += batchSize) {
      const batch = todo.slice(i, i + batchSize);
      const texts = new Map(batch.map((d) => [d.hash, d.text]));
      const vectors = await embedTexts(embeddingModel, [...texts.values()]);
      const byHash = new Map([...texts.keys()].map((h, j) => [h, vectors[j]!]));
      result.embedded += texts.size;
      const gone = await db.transaction(async (tx) => {
        const live = await lockDocument(tx, documentId);
        if (!live) return true;
        await tx
          .insert(chunk)
          .values(batch.map((d) => toRow(documentId, live.workspaceId, d, byHash.get(d.hash)!)));
        return false;
      });
      if (gone) return missing();
      result.inserted += batch.length;
    }

    // Reconcile: every draft has a row now; fix ordinals/refs, drop leftovers.
    const outcome = await db.transaction(async (tx) => {
      const live = await lockDocument(tx, documentId);
      if (!live) return 'missing' as const;
      if (live.updatedAt.getTime() !== doc.updatedAt.getTime() || live.title !== doc.title) {
        return 'stale' as const; // changed while we worked: start over from the new content
      }
      const rows = await tx
        .select({
          id: chunk.id,
          workspaceId: chunk.workspaceId,
          source: chunk.source,
          ordinal: chunk.ordinal,
          refIds: chunk.refIds,
          segmentStartMs: chunk.segmentStartMs,
          segmentEndMs: chunk.segmentEndMs,
          tokenCount: chunk.tokenCount,
          contentHash: chunk.contentHash,
        })
        .from(chunk)
        .where(forSources)
        .orderBy(asc(chunk.source), asc(chunk.ordinal), asc(chunk.createdAt));
      const byHash = new Map<string, typeof rows>();
      for (const row of rows)
        byHash.set(row.contentHash, [...(byHash.get(row.contentHash) ?? []), row]);
      // A concurrent run deleted rows we staged: start over (they'll be found or re-embedded).
      if (drafts.some((d) => !byHash.has(d.hash))) return 'stale' as const;

      let updated = 0;
      let unchanged = 0;
      for (const d of drafts) {
        const row = byHash.get(d.hash)?.shift();
        if (!row) return 'stale' as const;
        const same =
          row.workspaceId === live.workspaceId &&
          row.ordinal === d.ordinal &&
          sameRefs(row.refIds, d.refIds) &&
          row.segmentStartMs === d.startMs &&
          row.segmentEndMs === d.endMs &&
          row.tokenCount === d.tokenCount;
        if (same) {
          unchanged++;
          continue;
        }
        await tx
          .update(chunk)
          .set({
            workspaceId: live.workspaceId,
            ordinal: d.ordinal,
            refIds: d.refIds,
            segmentStartMs: d.startMs,
            segmentEndMs: d.endMs,
            tokenCount: d.tokenCount,
          })
          .where(eq(chunk.id, row.id));
        updated++;
      }
      const leftovers = [...byHash.values()].flat().map((r) => r.id);
      if (leftovers.length > 0) await tx.delete(chunk).where(inArray(chunk.id, leftovers));
      return { updated, unchanged, deleted: leftovers.length };
    });

    if (outcome === 'missing') return missing();
    if (outcome === 'stale') continue;
    // Rows staged by this run were inserted fresh; don't also count them as updated/unchanged.
    const staged = result.inserted;
    return {
      ...result,
      updated: outcome.updated,
      unchanged: Math.max(0, outcome.unchanged - staged),
      deleted: outcome.deleted,
    };
  }
  throw new Error(`index ${documentId}: the document kept changing; will retry`);
}

/** Re-indexes the document of a meeting (legacy `meeting:<id>` jobs). `missing` when the meeting is gone. */
export async function indexMeeting(deps: IndexerDeps, meetingId: string): Promise<IndexResult> {
  const [row] = await deps.db
    .select({ documentId: meeting.documentId })
    .from(meeting)
    .where(eq(meeting.id, meetingId));
  if (!row) {
    return {
      documentId: '',
      status: 'missing',
      inserted: 0,
      updated: 0,
      deleted: 0,
      unchanged: 0,
      embedded: 0,
      truncated: 0,
    };
  }
  return indexDocument(deps, row.documentId);
}
