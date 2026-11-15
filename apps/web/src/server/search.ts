import 'server-only';

import { canReadDocument } from '@oat/core';
import {
  type Db,
  MAX_SEARCH_LIMIT,
  searchDocuments,
  type SearchScope,
  searchSegments,
} from '@oat/db';
import { z } from 'zod';

import {
  decodeSearchCursor,
  encodeSearchCursor,
  MAX_SEARCH_OFFSET,
  type NoteHit,
  SEARCH_TYPES,
  type SearchResponse,
  type SearchSection,
  type SearchType,
  type TranscriptHit,
} from '@/lib/search';

import type { Actor } from './actor';
import { badRequest } from './api/errors';
import { type ApiDeps, apiRoute } from './api/route';
import { requireMember } from './folders';

/*
 * Full-text search (task 3.6, SPEC §4). `@oat/db` filters by permission in SQL (membership + owner or
 * not private, live documents only); every hit is re-checked here with `@oat/core`'s `canReadDocument`
 * before it leaves the server. Snippets are safe HTML (only `<mark>`).
 *
 *   GET /api/search?q=…[&type=all|notes|transcripts][&workspaceId=…][&limit=1..50][&cursor=…]
 *     → SearchResponse. `type=all` (default) returns both sections (no cursor); `cursor` pages one type.
 *     Without `workspaceId` it searches every workspace the user belongs to; with one, only that one
 *     (404 if the user isn't a member). An empty `q` returns empty sections.
 */

export type SearchInput = {
  q: string;
  type: SearchType;
  workspaceId?: string;
  limit: number;
  offset: number;
};

function section<T>(items: T[], hasMore: boolean, input: SearchInput): SearchSection<T> {
  return {
    items,
    // No cursor past the offset cap (it would only be refused with a 400).
    nextCursor:
      hasMore && input.offset + input.limit <= MAX_SEARCH_OFFSET
        ? encodeSearchCursor(input.offset + input.limit)
        : null,
  };
}

const scopeOf = (actor: Actor, input: SearchInput): SearchScope =>
  input.workspaceId
    ? { userId: actor.userId, workspaceIds: [input.workspaceId] }
    : { userId: actor.userId };

async function noteSection(db: Db, actor: Actor, input: SearchInput) {
  const { items, hasMore } = await searchDocuments(db, scopeOf(actor, input), input.q, {
    limit: input.limit,
    offset: input.offset,
  });
  const hits: NoteHit[] = items
    .filter((hit) => canReadDocument(actor.ctx, hit))
    .map((hit) => ({
      id: hit.id,
      workspaceId: hit.workspaceId,
      kind: hit.kind,
      title: hit.title,
      visibility: hit.visibility,
      updatedAt: hit.updatedAt.toISOString(),
      titleHtml: hit.titleHtml,
      snippetHtml: hit.snippetHtml,
    }));
  return section(hits, hasMore, input);
}

async function transcriptSection(db: Db, actor: Actor, input: SearchInput) {
  const { items, hasMore } = await searchSegments(db, scopeOf(actor, input), input.q, {
    limit: input.limit,
    offset: input.offset,
  });
  const hits: TranscriptHit[] = items
    .filter((hit) => canReadDocument(actor.ctx, hit.document))
    .map((hit) => ({
      id: hit.id,
      documentId: hit.document.id,
      documentTitle: hit.document.title,
      source: hit.source,
      speakerLabel: hit.speakerLabel,
      startMs: hit.startMs,
      endMs: hit.endMs,
      updatedAt: hit.document.updatedAt.toISOString(),
      snippetHtml: hit.snippetHtml,
    }));
  return section(hits, hasMore, input);
}

/** Notes and/or transcript hits the actor can read, best first. */
export async function search(db: Db, actor: Actor, input: SearchInput): Promise<SearchResponse> {
  if (input.workspaceId) requireMember(actor, input.workspaceId);
  const [notes, transcripts] = await Promise.all([
    input.type === 'transcripts' ? undefined : noteSection(db, actor, input),
    input.type === 'notes' ? undefined : transcriptSection(db, actor, input),
  ]);
  return { query: input.q, ...(notes && { notes }), ...(transcripts && { transcripts }) };
}

const Query = z.object({
  q: z.string().max(1000).default(''),
  type: z.enum(SEARCH_TYPES).default('all'),
  workspaceId: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_SEARCH_LIMIT).default(10),
  cursor: z.string().max(20).optional(),
});

/** Parses `/api/search` query parameters (400 on bad input). */
export function parseSearchParams(url: URL): SearchInput {
  const raw = Object.fromEntries(
    [...url.searchParams].filter(([key]) =>
      ['q', 'type', 'workspaceId', 'limit', 'cursor'].includes(key),
    ),
  );
  const parsed = Query.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw badRequest(`${issue.path.join('.') || 'query'}: ${issue.message}`);
  }
  const { q, type, workspaceId, limit, cursor } = parsed.data;
  let offset = 0;
  if (cursor !== undefined) {
    if (type === 'all') throw badRequest('cursor: page one type at a time (notes or transcripts).');
    const decoded = decodeSearchCursor(cursor);
    if (decoded === null) throw badRequest('cursor: invalid.');
    offset = decoded;
  }
  return { q: q.trim(), type, limit, offset, ...(workspaceId ? { workspaceId } : {}) };
}

/** Route handlers for `/api/search` (session auth, cookie or bearer). */
export function createSearchApi(deps: ApiDeps) {
  return {
    GET: apiRoute(deps, async ({ db, actor, url }) => search(db, actor, parseSearchParams(url))),
  };
}
