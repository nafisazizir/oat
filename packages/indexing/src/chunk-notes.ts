/**
 * Notes chunker: a TipTap document (canonical JSON, D-4) → retrieval chunks that cite the blocks they came
 * from. Pure and deterministic, so re-chunking unchanged content yields identical texts (and hashes).
 *
 * 1. Flatten the body into *units*: each top-level block rendered to Markdown (`@oat/editor/markdown`) with its
 *    block id. A block over `maxTokens` is split into its child blocks (list items, quote/callout paragraphs),
 *    and a leaf that is still too long (a huge paragraph or code block) into sentence-packed pieces that
 *    share its id.
 * 2. Pack units into chunks of about `targetTokens`, never over `maxTokens`. A heading starts a new chunk
 *    once the current one has at least `minTokens` (so tiny sections merge instead of becoming confetti).
 *    Within a section, consecutive chunks overlap by trailing units totalling ≤ `overlapTokens`.
 * 3. Each chunk's text is prefixed with its context, "<title> › <heading path>", which is embedded with it.
 */
import { isBlockType } from '@oat/editor/blocks';
// The serializer only (not the `@oat/editor/markdown` barrel): the parser side isn't needed here and isn't
// runnable with Node's type stripping, which the worker image uses.
import { toMarkdown } from '@oat/editor/markdown/to-markdown';
import { estimateTokens, splitLongText } from './text.ts';
import type { ChunkDraft } from './types.ts';

export interface NotesChunkOptions {
  /** Document title, used as the first breadcrumb of every chunk. */
  title?: string;
  /** Aim for chunks about this size (estimated tokens). Default 400. */
  targetTokens?: number;
  /** Never exceed this (except for the context prefix). Default 500. */
  maxTokens?: number;
  /** A heading only starts a new chunk once the current one has this many tokens. Default 120. */
  minTokens?: number;
  /** Repeat up to this many trailing tokens of the previous chunk (same section only). Default 60. */
  overlapTokens?: number;
}

/** TipTap JSON (`@tiptap/core` JSONContent), as stored in `document.content_json`. */
export type NotesDoc = Parameters<typeof toMarkdown>[0];
type JSONContent = NotesDoc;

interface Unit {
  /** Block ids this unit cites (one, or none for blocks without an id). */
  ids: string[];
  text: string;
  tokens: number;
  heading?: { level: number; text: string };
}

const DEFAULTS = { targetTokens: 400, maxTokens: 500, minTokens: 120, overlapTokens: 60 };

/** Breadcrumb separator in chunk prefixes. */
export const CONTEXT_SEPARATOR = ' › ';

function blockId(node: JSONContent): string | undefined {
  const id = node.attrs?.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList']);
/** Belt and braces: nesting deeper than this is split as text instead of recursed into. */
const MAX_DEPTH = 32;

/**
 * Units of one block. Every recursive call is on a strictly smaller subtree (a multi-item list is re-wrapped
 * one item per list, and a one-item list is never re-wrapped, only descended into), so this terminates even
 * for a single huge list item. `inherited` = the nearest ancestor's id, cited by children without one.
 */
function unitsOf(
  node: JSONContent,
  maxTokens: number,
  depth = 0,
  inherited: string[] = [],
): Unit[] {
  const text = toMarkdown(node).trim();
  if (!text) return [];
  const id = blockId(node);
  const ids = id ? [id] : inherited;
  const tokens = estimateTokens(text);
  if (node.type === 'heading') {
    const level = Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 6);
    const plain = text.replace(/^#+\s*/, '').trim();
    return [{ ids, text, tokens, heading: { level, text: plain } }];
  }
  if (tokens <= maxTokens) return [{ ids, text, tokens }];
  const blockChildren = (node.content ?? []).filter((child) => isBlockType(child.type));
  if (depth < MAX_DEPTH && LIST_TYPES.has(node.type ?? '') && blockChildren.length > 1) {
    // One single-item list per item, so each keeps its "- item" markup and cites the item id.
    return blockChildren.flatMap((child) =>
      unitsOf(
        { ...node, content: [child], attrs: { ...node.attrs, id: blockId(child) } },
        maxTokens,
        depth + 1,
        ids,
      ),
    );
  }
  if (depth < MAX_DEPTH && blockChildren.length > 0) {
    // A one-item list → its item; an item, quote or callout → its blocks (paragraphs, nested lists).
    return blockChildren.flatMap((child) => unitsOf(child, maxTokens, depth + 1, ids));
  }
  return splitLongText(text, maxTokens).map((piece) => ({
    ids,
    text: piece,
    tokens: estimateTokens(piece),
  }));
}

/** Units of a whole document, in order. */
function documentUnits(doc: JSONContent, maxTokens: number): Unit[] {
  const blocks = doc.type === 'doc' ? (doc.content ?? []) : [doc];
  return blocks.flatMap((block) => unitsOf(block, maxTokens));
}

export function chunkNotes(doc: JSONContent, options: NotesChunkOptions = {}): ChunkDraft[] {
  const { targetTokens, maxTokens, minTokens, overlapTokens } = { ...DEFAULTS, ...options };
  const title = options.title?.replace(/\s+/g, ' ').trim() ?? '';
  const units = documentUnits(doc, maxTokens);

  const chunks: ChunkDraft[] = [];
  /** Open headings above the current position. */
  const headings: { level: number; text: string }[] = [];
  let current: Unit[] = [];
  let tokens = 0;
  /** Units added since the chunk started (overlap units don't count): a chunk of only overlap is dropped. */
  let fresh = 0;
  let context: string[] = [];

  const begin = (carry: Unit[]) => {
    current = carry;
    tokens = carry.reduce((sum, u) => sum + u.tokens, 0);
    fresh = 0;
    context = headings.map((h) => h.text);
  };
  const flush = (withOverlap: boolean): Unit[] => {
    if (fresh > 0) {
      const body = current.map((u) => u.text).join('\n\n');
      const prefix = [title, ...context].filter(Boolean).join(CONTEXT_SEPARATOR);
      const text = prefix ? `${prefix}\n\n${body}` : body;
      chunks.push({
        source: 'notes',
        ordinal: chunks.length,
        text,
        refIds: [...new Set(current.flatMap((u) => u.ids))],
        startMs: null,
        endMs: null,
        tokenCount: estimateTokens(text),
      });
    }
    if (!withOverlap || fresh === 0) return [];
    const carry: Unit[] = [];
    let carried = 0;
    // Trailing non-heading units, newest first, but never the whole chunk (that would not advance).
    for (let i = current.length - 1; i > 0; i--) {
      const unit = current[i]!;
      if (unit.heading || carried + unit.tokens > overlapTokens) break;
      carry.unshift(unit);
      carried += unit.tokens;
    }
    return carry;
  };

  begin([]);
  for (const unit of units) {
    if (unit.heading && tokens >= minTokens) {
      flush(false);
      begin([]);
    } else if (fresh > 0 && tokens + unit.tokens > targetTokens) {
      let carry = flush(true);
      // No overlap into a new section, or when it would push the chunk over the limit.
      if (unit.heading || carry.reduce((sum, u) => sum + u.tokens, 0) + unit.tokens > maxTokens) {
        carry = [];
      }
      begin(carry);
    }
    if (unit.heading) {
      while (headings.length > 0 && headings.at(-1)!.level >= unit.heading.level) headings.pop();
      // The context of a chunk is what's above its first unit; a heading inside it is in its body.
      if (fresh === 0 && current.length === 0) context = headings.map((h) => h.text);
      headings.push(unit.heading);
    }
    current.push(unit);
    tokens += unit.tokens;
    fresh += 1;
  }
  flush(false);
  return chunks;
}
