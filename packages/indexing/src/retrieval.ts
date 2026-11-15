/**
 * `searchChunks` (6.1): semantic retrieval over the chunks a user may read, returning citation references.
 *
 * Permissions are applied **in SQL** (the same rule as `canReadDocument` in `@oat/core` for live documents
 * and no share token) and then re-checked row by row with `canReadDocument` itself:
 *   document not in trash · workspace not deleted · actor is a member of it · actor owns the document or it
 *   isn't `private`.
 * Share tokens never widen search (a link grants reading one page, not searching a workspace), and trashed
 * documents are never returned. Chunks carry no visibility of their own; the join to `document` decides, so
 * a visibility change or trash takes effect immediately without re-indexing.
 *
 * Ranking: cosine similarity on the HNSW index (`hnsw.iterative_scan = relaxed_order`, pgvector ≥ 0.8, so a
 * filter that removes most neighbours, e.g. a small workspace in a big table, still fills `k`). Optional
 * hybrid: pass `ftsRank` (e.g. 3.6's full-text rank) and the two candidate lists are fused with reciprocal
 * rank fusion. Without it the ranking is vector-only and `score` is the cosine similarity.
 */
import type { EmbeddingModelV4 } from '@ai-sdk/provider';
// The provider module, not the `@oat/ai` barrel: the barrel also loads prompt/context code (and the Markdown
// parser) that the worker never needs.
import { getEmbeddingModel } from '@oat/ai/provider';
import { canReadDocument, type PermissionContext } from '@oat/core';
import { type ChunkSource, chunk, type Db, document, workspace } from '@oat/db';
import { embed } from 'ai';
import {
  and,
  asc,
  cosineDistance,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  ne,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';

export interface SearchContext {
  db: Db;
  /** The actor; `userId: null` (anonymous) finds nothing. */
  permissions: PermissionContext;
  /** Defaults to `getEmbeddingModel()` (must be the model the chunks were indexed with). */
  embeddingModel?: EmbeddingModelV4;
}

export type SearchScope = { documentId: string } | { workspaceId: string };

export interface SearchOptions {
  /** Results to return. Default 8, max 50. */
  k?: number;
  /** One document, or one workspace. Default: every workspace the actor belongs to. */
  scope?: SearchScope;
  /** Only these sources. Default both. */
  sources?: readonly ChunkSource[];
  /**
   * Hybrid hook: an SQL rank expression for `query` over the `chunk`/`document` tables (higher = better,
   * > 0 = match), e.g. `ts_rank(<tsvector>, websearch_to_tsquery(…))`. See `chunkTextFtsRank`.
   */
  ftsRank?: (query: string) => SQL<number>;
}

export type ChunkRef =
  | { source: 'notes'; blockIds: string[] }
  | { source: 'transcript'; segmentIds: string[]; startMs: number; endMs: number };

export interface ChunkHit {
  chunkId: string;
  documentId: string;
  workspaceId: string;
  documentTitle: string;
  documentKind: 'meeting' | 'page';
  ordinal: number;
  text: string;
  /** What to cite: block ids, or segment ids + time range. */
  ref: ChunkRef;
  /** Cosine similarity to the query (1 = same direction), null for FTS-only hits. */
  similarity: number | null;
  /** Ranking score: the similarity (vector-only) or the RRF score (hybrid). Higher is better. */
  score: number;
}

/** Reciprocal rank fusion constant (the usual 60). */
const RRF_K = 60;

/**
 * A ready-made `ftsRank` that needs no extra columns: `ts_rank` over `to_tsvector('simple', chunk.text)`
 * computed on the fly. Fine for tests and small data; a stored, indexed tsvector (3.6) is the real thing.
 */
export function chunkTextFtsRank(query: string): SQL<number> {
  return sql<number>`ts_rank(to_tsvector('simple', ${chunk.text}), plainto_tsquery('simple', ${query}))`;
}

const columns = {
  id: chunk.id,
  documentId: chunk.documentId,
  workspaceId: chunk.workspaceId,
  source: chunk.source,
  ordinal: chunk.ordinal,
  refIds: chunk.refIds,
  segmentStartMs: chunk.segmentStartMs,
  segmentEndMs: chunk.segmentEndMs,
  text: chunk.text,
  title: document.title,
  kind: document.kind,
  docWorkspaceId: document.workspaceId,
  ownerId: document.ownerId,
  visibility: document.visibility,
  shareToken: document.shareToken,
  deletedAt: document.deletedAt,
};

/**
 * The SQL form of "may read this live document" for a signed-in member (see file comment), for a query over
 * `chunk` joined to `document` and `workspace`. `null` = nothing is readable.
 */
export function readableChunkFilter(
  permissions: PermissionContext,
  options: Pick<SearchOptions, 'scope' | 'sources'> = {},
): SQL | null {
  const userId = permissions.userId;
  let workspaces = [...permissions.memberships.keys()];
  if (options.scope && 'workspaceId' in options.scope) {
    const only = options.scope.workspaceId;
    workspaces = workspaces.filter((w) => w === only);
  }
  if (userId === null || workspaces.length === 0) return null;
  return and(
    inArray(chunk.workspaceId, workspaces),
    eq(document.workspaceId, chunk.workspaceId),
    isNull(document.deletedAt),
    // A soft-deleted workspace (5.x) is gone for everyone, even with a stale membership list.
    isNull(workspace.deletedAt),
    or(eq(document.ownerId, userId), ne(document.visibility, 'private')),
    options.scope && 'documentId' in options.scope
      ? eq(chunk.documentId, options.scope.documentId)
      : undefined,
    options.sources ? inArray(chunk.source, [...options.sources]) : undefined,
  )!;
}

type Row = { [K in keyof typeof columns]: (typeof columns)[K]['_']['data'] } & {
  rank: number;
};

function toHit(row: Row, similarity: number | null, score: number): ChunkHit {
  const ref: ChunkRef =
    row.source === 'transcript'
      ? {
          source: 'transcript',
          segmentIds: row.refIds,
          startMs: row.segmentStartMs ?? 0,
          endMs: row.segmentEndMs ?? 0,
        }
      : { source: 'notes', blockIds: row.refIds };
  return {
    chunkId: row.id,
    documentId: row.documentId,
    workspaceId: row.workspaceId,
    documentTitle: row.title,
    documentKind: row.kind,
    ordinal: row.ordinal,
    text: row.text,
    ref,
    similarity,
    score,
  };
}

export async function searchChunks(
  ctx: SearchContext,
  query: string,
  options: SearchOptions = {},
): Promise<ChunkHit[]> {
  const k = Math.min(Math.max(Math.trunc(options.k ?? 8), 1), 50);
  const text = query.trim();
  const where = readableChunkFilter(ctx.permissions, options);
  if (!text || !where) return [];

  const model = ctx.embeddingModel ?? getEmbeddingModel();
  const { embedding } = await embed({ model, value: text, maxRetries: 2 });
  const candidates = Math.max(k * 4, 40);
  const distance = cosineDistance(chunk.embedding, embedding);

  const { vectorRows, ftsRows } = await ctx.db.transaction(async (tx) => {
    // Iterative index scans keep going until enough rows pass the filter (pgvector 0.8). Results come back
    // in approximately distance order; we re-sort below.
    await tx.execute(sql`set local hnsw.iterative_scan = relaxed_order`);
    await tx.execute(sql.raw(`set local hnsw.ef_search = ${Math.min(candidates * 2, 1000)}`));
    const vectorRows = (await tx
      .select({ ...columns, rank: sql<number>`(${distance})::float8` })
      .from(chunk)
      .innerJoin(document, eq(document.id, chunk.documentId))
      .innerJoin(workspace, eq(workspace.id, chunk.workspaceId))
      .where(where)
      .orderBy(distance)
      .limit(candidates)) as Row[];
    let ftsRows: Row[] = [];
    if (options.ftsRank) {
      const rank = options.ftsRank(text);
      ftsRows = (await tx
        .select({ ...columns, rank: sql<number>`(${rank})::float8` })
        .from(chunk)
        .innerJoin(document, eq(document.id, chunk.documentId))
        .innerJoin(workspace, eq(workspace.id, chunk.workspaceId))
        .where(and(where, gt(rank, 0)))
        .orderBy(desc(rank), asc(chunk.id))
        .limit(candidates)) as Row[];
    }
    return { vectorRows, ftsRows };
  });

  // Defence in depth: the SQL filter must agree with the one permission rule.
  const readable = (row: Row) =>
    canReadDocument(ctx.permissions, {
      workspaceId: row.docWorkspaceId,
      ownerId: row.ownerId,
      visibility: row.visibility,
      shareToken: null,
      deletedAt: row.deletedAt,
    });

  const byDistance = vectorRows
    .filter(readable)
    .sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : 1));
  if (!options.ftsRank) {
    return byDistance.slice(0, k).map((row) => toHit(row, 1 - row.rank, 1 - row.rank));
  }

  const fused = new Map<string, { row: Row; similarity: number | null; score: number }>();
  byDistance.forEach((row, i) => {
    fused.set(row.id, { row, similarity: 1 - row.rank, score: 1 / (RRF_K + i + 1) });
  });
  ftsRows.filter(readable).forEach((row, i) => {
    const entry = fused.get(row.id) ?? { row, similarity: null, score: 0 };
    entry.score += 1 / (RRF_K + i + 1);
    fused.set(row.id, entry);
  });
  return [...fused.values()]
    .sort((a, b) => b.score - a.score || (a.row.id < b.row.id ? -1 : 1))
    .slice(0, k)
    .map((e) => toHit(e.row, e.similarity, e.score));
}
