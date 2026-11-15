/**
 * Full-text search over documents (title + note Markdown) and transcript segments (SPEC §4 Search, task 3.6).
 * Backed by the generated `search_tsv` columns and GIN/trigram indexes of migration `0006_search.sql`.
 *
 * Matching (see {@link parseSearchQuery}):
 * - Plain words → every word must match, the last one as a prefix (`plan budg` finds "planning budget"),
 *   so results appear while typing.
 * - Web-search syntax (`"exact phrase"`, `-exclude`, `or`) → `websearch_to_tsquery`.
 * - Titles also match fuzzily: queries of 3+ characters by substring (`ILIKE`) or trigram word similarity
 *   (typos); 1–2 character queries by word prefix (both served by the trigram index).
 *
 * Ranking: `ts_rank_cd` (title weight A > body B, normalised to 0..1) + title similarity + a small recency
 * boost (newer edits first among similar matches).
 *
 * Permissions: the SQL only returns live documents in live (not soft-deleted) workspaces the user is a member
 * of, that they own or that are not private (= `canReadDocument` with the memberships `loadPermissionContext`
 * loads, for live documents; share tokens never apply to search).
 * Callers re-check every row with `@oat/core` before returning it.
 *
 * Snippets/titles come back as **safe HTML**: everything is escaped and the only markup is `<mark>…</mark>`
 * ({@link toSafeHighlight}).
 */
import { type SQL, sql } from 'drizzle-orm';
import type { DocumentKind, DocumentVisibility, TranscriptSource } from '@oat/core';
import type { Db } from './client.ts';

/** The text search configuration created by the migration (english stemming, accents folded). */
const CONFIG = sql.raw(`'public.oat_search'::regconfig`);

/** Longest query we search for; anything beyond is cut. */
export const MAX_QUERY_LENGTH = 200;
export const MAX_SEARCH_LIMIT = 50;

/** Private-use sentinels marking highlights inside `ts_headline` output (stripped from the source first). */
const HL_START = '';
const HL_STOP = '';

export type ParsedQuery = {
  /** Trimmed, length-capped query text. */
  readonly text: string;
  /** `websearch` → `websearch_to_tsquery(text)`; `prefix` → `to_tsquery(tsquery)`. */
  readonly mode: 'websearch' | 'prefix';
  /** For `prefix` mode: `'word1' & 'word2':*` built from sanitised words. */
  readonly tsquery: string;
};

const WORD = /[\p{L}\p{N}]+/gu;

/**
 * Turns user input into a query plan, or `null` when there is nothing to search for (empty, or no letters
 * or digits at all). Pure; the result is passed as bind parameters, never spliced into SQL.
 */
export function parseSearchQuery(input: string): ParsedQuery | null {
  const text = input.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_LENGTH).trim();
  const words = text.match(WORD) ?? [];
  if (words.length === 0) return null;
  const websearch = /"/.test(text) || /(^|\s)-\S/.test(text) || /(^|\s)or(\s|$)/i.test(text);
  // Words are letters/digits only, so they can't carry tsquery syntax; quoting keeps them literal anyway.
  const tsquery = words.map((w, i) => `'${w}'${i === words.length - 1 ? ':*' : ''}`).join(' & ');
  return { text, mode: websearch ? 'websearch' : 'prefix', tsquery };
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * `ts_headline` output (highlights wrapped in the private-use sentinels) → safe HTML: the text is escaped,
 * whitespace collapsed, and the sentinels become `<mark>`/`</mark>`. Unbalanced sentinels are dropped.
 */
export function toSafeHighlight(raw: string): string {
  let out = '';
  let open = false;
  for (const part of raw
    .replace(/\s+/g, ' ')
    .trim()
    .split(/([])/)) {
    if (part === HL_START) {
      if (!open) out += '<mark>';
      open = true;
    } else if (part === HL_STOP) {
      if (open) out += '</mark>';
      open = false;
    } else {
      out += escapeHtml(part);
    }
  }
  return open ? `${out}</mark>` : out;
}

/** Who is searching and where. `workspaceIds` narrows the search; membership is always required. */
export type SearchScope = {
  readonly userId: string;
  /** Only these workspaces (still intersected with the user's memberships). Omit for all of them. */
  readonly workspaceIds?: readonly string[];
};

export type SearchPage = { readonly limit?: number; readonly offset?: number };

/** Document fields `canReadDocument` needs, so callers can re-check each hit. */
type AccessFields = {
  workspaceId: string;
  ownerId: string;
  visibility: DocumentVisibility;
  shareToken: string | null;
  deletedAt: Date | null;
};

export type DocumentSearchHit = AccessFields & {
  id: string;
  folderId: string | null;
  kind: DocumentKind;
  title: string;
  updatedAt: Date;
  /** Safe HTML: the title with matches in `<mark>`. */
  titleHtml: string;
  /** Safe HTML: up to two fragments of the body around the matches (or its beginning). */
  snippetHtml: string;
  rank: number;
};

export type SegmentSearchHit = {
  id: string;
  meetingId: string;
  source: TranscriptSource;
  speakerLabel: string | null;
  startMs: number;
  endMs: number;
  /** Safe HTML: the segment text around the match. */
  snippetHtml: string;
  rank: number;
  /** The meeting's document (title, link target, access). */
  document: AccessFields & { id: string; title: string; updatedAt: Date };
};

export type SearchResult<T> = { items: T[]; hasMore: boolean };

function pageOf(page: SearchPage) {
  const limit = Math.min(Math.max(Math.trunc(page.limit ?? 20), 1), MAX_SEARCH_LIMIT);
  const offset = Math.max(Math.trunc(page.offset ?? 0), 0);
  return { limit, offset };
}

function tsqueryOf(q: ParsedQuery): SQL {
  return q.mode === 'websearch'
    ? sql`websearch_to_tsquery(${CONFIG}, ${q.text})`
    : sql`to_tsquery(${CONFIG}, ${q.tsquery})`;
}

/**
 * `d` is readable live content for the user: member of its workspace, which is not soft-deleted (D-22), and
 * owner or not private.
 */
function readableDocument(scope: SearchScope): SQL {
  const only =
    scope.workspaceIds === undefined
      ? sql``
      : sql`and d.workspace_id in (${sql.join(
          scope.workspaceIds.map((id) => sql`${id}`),
          sql`, `,
        )})`;
  return sql`d.deleted_at is null
    ${only}
    and exists (
      select 1 from membership mb join workspace w on w.id = mb.workspace_id and w.deleted_at is null
      where mb.workspace_id = d.workspace_id and mb.user_id = ${scope.userId})
    and (d.owner_id = ${scope.userId} or d.visibility <> 'private')`;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Small boost for recently edited documents: 0.1 now, decaying with a 30-day time constant. */
const RECENCY = sql`0.1 * exp(-greatest(extract(epoch from (now() - d.updated_at)), 0) / 2592000.0)`;

const headlineOptions = (extra: string) =>
  `StartSel=${HL_START}, StopSel=${HL_STOP}, ${extra}`.replace(/'/g, '');

/** Snippets look at the first 64 KiB of a body (matches further in still rank; the snippet starts the note). */
const SNIPPET_SOURCE_CHARS = 65536;

/**
 * Markdown → plain-ish text for snippets: drop link targets, block-quote markers at line starts and
 * emphasis/heading/code/table markers. Highlight sentinels are removed first so content can't forge them.
 */
const plainBody = sql`regexp_replace(regexp_replace(regexp_replace(
  translate(left(d.content_md, ${SNIPPET_SOURCE_CHARS}), ${HL_START + HL_STOP}, ''),
  '\\]\\([^)\\s]*\\)', ' ', 'g'),
  '^[ \\t]*(>[ \\t]*)+', '', 'gn'),
  '[\\[\\]*_\`#~|\\\\]+', ' ', 'g')`;

type RawDocumentRow = {
  id: string;
  workspace_id: string;
  folder_id: string | null;
  owner_id: string;
  kind: DocumentKind;
  title: string;
  visibility: DocumentVisibility;
  share_token: string | null;
  deleted_at: string | Date | null;
  updated_at: string | Date;
  title_hl: string;
  snippet_hl: string;
  rank: number | string;
  has_more: boolean;
};

const toDate = (v: string | Date) => (v instanceof Date ? v : new Date(v));

/**
 * Documents (pages and meeting notes) matching `input`, best first. Highlights are computed only for the
 * returned page. Returns `hasMore` when another page exists (offset + limit).
 */
export async function searchDocuments(
  db: Db,
  scope: SearchScope,
  input: string,
  page: SearchPage = {},
): Promise<SearchResult<DocumentSearchHit>> {
  const q = parseSearchQuery(input);
  if (!q || (scope.workspaceIds && scope.workspaceIds.length === 0)) {
    return { items: [], hasMore: false };
  }
  const { limit, offset } = pageOf(page);
  const short = q.text.length < 3;
  const titleMatch = short
    ? sql`(d.title ilike ${`${escapeLike(q.text)}%`} or d.title ilike ${`% ${escapeLike(q.text)}%`})`
    : sql`(d.title ilike ${`%${escapeLike(q.text)}%`} or ${q.text} <% d.title)`;
  const titleScore = short
    ? sql`case when ${titleMatch} then 0.2 else 0 end`
    : sql`0.3 * word_similarity(${q.text}, d.title)`;

  const rows = await db.execute<RawDocumentRow>(sql`
    with q as (select ${tsqueryOf(q)} as tsq),
    hits as (
      select d.id, d.workspace_id, d.folder_id, d.owner_id, d.kind, d.title, d.visibility, d.share_token,
             d.deleted_at, d.updated_at,
             ts_rank_cd(d.search_tsv, q.tsq, 32) + ${titleScore} + ${RECENCY} as rank
      from document d, q
      where (d.search_tsv @@ q.tsq or ${titleMatch})
        and ${readableDocument(scope)}
      order by rank desc, d.updated_at desc, d.id
      limit ${limit + 1} offset ${offset}
    ),
    -- Headlines only for the page itself: the (limit + 1)th row is just the "has more" probe.
    top as (select * from hits order by rank desc, updated_at desc, id limit ${limit})
    select top.*,
      ts_headline(${CONFIG}, translate(top.title, ${HL_START + HL_STOP}, ''), q.tsq,
        ${headlineOptions('HighlightAll=true')}) as title_hl,
      ts_headline(${CONFIG}, ${plainBody}, q.tsq,
        ${headlineOptions('MaxFragments=2, MaxWords=18, MinWords=8, ShortWord=2, FragmentDelimiter=" … "')}) as snippet_hl,
      (select count(*) from hits) > ${limit} as has_more
    from top join document d on d.id = top.id, q
    order by top.rank desc, top.updated_at desc, top.id
  `);
  const list = [...rows];
  return {
    hasMore: list[0]?.has_more ?? false,
    items: list.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      folderId: r.folder_id,
      ownerId: r.owner_id,
      kind: r.kind,
      title: r.title,
      visibility: r.visibility,
      shareToken: r.share_token,
      deletedAt: r.deleted_at === null ? null : toDate(r.deleted_at),
      updatedAt: toDate(r.updated_at),
      titleHtml: toSafeHighlight(r.title_hl),
      snippetHtml: toSafeHighlight(r.snippet_hl),
      rank: Number(r.rank),
    })),
  };
}

type RawSegmentRow = {
  id: string;
  meeting_id: string;
  source: TranscriptSource;
  speaker_label: string | null;
  start_ms: number;
  end_ms: number;
  document_id: string;
  workspace_id: string;
  owner_id: string;
  visibility: DocumentVisibility;
  share_token: string | null;
  deleted_at: string | Date | null;
  title: string;
  updated_at: string | Date;
  snippet_hl: string;
  rank: number | string;
  has_more: boolean;
};

/**
 * Final transcript segments matching `input` in meetings whose document the user can read, best first
 * (rank, then newer meetings, then earlier in the meeting). Full-text only (no title fuzziness).
 */
export async function searchSegments(
  db: Db,
  scope: SearchScope,
  input: string,
  page: SearchPage = {},
): Promise<SearchResult<SegmentSearchHit>> {
  const q = parseSearchQuery(input);
  if (!q || (scope.workspaceIds && scope.workspaceIds.length === 0)) {
    return { items: [], hasMore: false };
  }
  const { limit, offset } = pageOf(page);
  const rows = await db.execute<RawSegmentRow>(sql`
    with q as (select ${tsqueryOf(q)} as tsq),
    hits as (
      select s.id, s.meeting_id, s.source, s.speaker_label, s.start_ms, s.end_ms,
             d.id as document_id, d.workspace_id, d.owner_id, d.visibility, d.share_token, d.deleted_at,
             d.title, d.updated_at,
             ts_rank_cd(s.search_tsv, q.tsq, 32) + ${RECENCY} as rank
      from transcript_segment s
        join meeting m on m.id = s.meeting_id
        join document d on d.id = m.document_id,
        q
      where s.search_tsv @@ q.tsq
        and s.is_final
        and ${readableDocument(scope)}
      order by rank desc, d.updated_at desc, s.start_ms, s.id
      limit ${limit + 1} offset ${offset}
    ),
    top as (select * from hits order by rank desc, updated_at desc, start_ms, id limit ${limit})
    select top.*,
      ts_headline(${CONFIG}, translate(left(s.text, ${SNIPPET_SOURCE_CHARS}), ${HL_START + HL_STOP}, ''), q.tsq,
        ${headlineOptions('MaxWords=24, MinWords=10, ShortWord=2')}) as snippet_hl,
      (select count(*) from hits) > ${limit} as has_more
    from top join transcript_segment s on s.id = top.id, q
    order by top.rank desc, top.updated_at desc, top.start_ms, top.id
  `);
  const list = [...rows];
  return {
    hasMore: list[0]?.has_more ?? false,
    items: list.map((r) => ({
      id: r.id,
      meetingId: r.meeting_id,
      source: r.source,
      speakerLabel: r.speaker_label,
      startMs: Number(r.start_ms),
      endMs: Number(r.end_ms),
      snippetHtml: toSafeHighlight(r.snippet_hl),
      rank: Number(r.rank),
      document: {
        id: r.document_id,
        workspaceId: r.workspace_id,
        ownerId: r.owner_id,
        visibility: r.visibility,
        shareToken: r.share_token,
        deletedAt: r.deleted_at === null ? null : toDate(r.deleted_at),
        title: r.title,
        updatedAt: toDate(r.updated_at),
      },
    })),
  };
}
