/**
 * Search wire shapes (`GET /api/search`) and pure helpers shared by the server, the ⌘K palette and the
 * `/search` page. Highlights arrive as safe HTML whose only markup is `<mark>` (escaped by `@oat/db`);
 * the UI never injects it as HTML, it splits it into text parts with {@link highlightParts}.
 */
import type { TranscriptHit } from '@oat/services/dto/search';
export { SEARCH_TYPES } from '@oat/services/dto/search';
export type {
  SearchType,
  NoteHit,
  TranscriptHit,
  SearchSection,
  SearchResponse,
} from '@oat/services/dto/search';

export const MAX_SEARCH_OFFSET = 1000;

/** Opaque page cursor (an offset today). */
export function encodeSearchCursor(offset: number): string {
  return `o${offset}`;
}

/** The offset in a cursor, or `null` when it is malformed or out of range. */
export function decodeSearchCursor(cursor: string): number | null {
  const match = /^o(\d{1,4})$/.exec(cursor);
  if (!match) return null;
  const offset = Number(match[1]);
  return offset <= MAX_SEARCH_OFFSET ? offset : null;
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' };
const unescape = (s: string) => s.replace(/&(amp|lt|gt|quot);/g, (e) => ENTITIES[e]!);

export type HighlightPart = { text: string; mark: boolean };

/**
 * Safe highlight HTML → text parts. Only `<mark>`/`</mark>` are treated as markup; everything else is
 * text (entities decoded, React escapes it again on render).
 */
export function highlightParts(html: string): HighlightPart[] {
  const parts: HighlightPart[] = [];
  let mark = false;
  for (const piece of html.split(/(<mark>|<\/mark>)/)) {
    if (piece === '<mark>') mark = true;
    else if (piece === '</mark>') mark = false;
    else if (piece) parts.push({ text: unescape(piece), mark });
  }
  return parts;
}

/** Recording offset as `m:ss` (or `h:mm:ss`). */
export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Where a transcript hit opens: its meeting note, at the segment's time (seconds). */
export function transcriptHref(
  hit: Pick<TranscriptHit, 'documentId' | 'startMs'>,
): `/d/${string}?t=${number}` {
  return `/d/${hit.documentId}?t=${Math.floor(hit.startMs / 1000)}`;
}

export function searchPageHref(query: string, tab?: 'notes' | 'transcripts'): `/search?${string}` {
  const params = new URLSearchParams({ q: query });
  if (tab && tab !== 'notes') params.set('tab', tab);
  return `/search?${params.toString()}`;
}
