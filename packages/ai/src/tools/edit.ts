/**
 * Find/replace edits on TipTap JSON with a minimal block diff (6.2 `updateDocument`).
 *
 * Each edit must match exactly once across the document's text blocks (paragraphs, headings, code blocks —
 * any block with an `id` whose children are inline). Only the inline nodes the match touches change: text
 * before and after keeps its marks, the replacement takes the marks of the text where the match starts,
 * inline atoms (mentions, hard breaks) never match (so they are never edited), and every block keeps its `id`
 * and `origin`. Edits apply in order, each to the result of the previous one. Pure: no I/O.
 */
import type { BlockChange, TextEdit } from './types.ts';

interface JsonNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  text?: string;
  marks?: unknown[];
  [key: string]: unknown;
}

/** Stand-in character for an inline atom (mention, hard break) so positions stay aligned. */
const ATOM = '￼';

export const MAX_EDITS = 20;
export const MAX_FIND_CHARS = 2000;
export const MAX_REPLACE_CHARS = 4000;

export type EditError =
  | { code: 'not_found'; editIndex: number }
  | { code: 'ambiguous'; editIndex: number; matches: number }
  | { code: 'invalid'; editIndex: number; message: string };

export type EditResult =
  { ok: true; doc: unknown; changes: BlockChange[] } | { ok: false; error: EditError };

const isNode = (value: unknown): value is JsonNode =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isInline = (node: JsonNode) =>
  node.type === 'text' || node.type === 'mention' || node.type === 'hardBreak';

/** A block whose children are all inline (and that has an id to report the change against). */
function isTextBlock(node: JsonNode): boolean {
  return (
    typeof node.attrs?.id === 'string' &&
    Array.isArray(node.content) &&
    node.content.length > 0 &&
    node.content.every((c) => isNode(c) && isInline(c))
  );
}

function inlineText(content: readonly JsonNode[]): string {
  return content.map((n) => (n.type === 'text' ? (n.text ?? '') : ATOM)).join('');
}

/** Visible text of a block (atoms as their label/nothing), for change previews. */
export function blockPlainText(node: JsonNode): string {
  return (node.content ?? [])
    .map((n) =>
      n.type === 'text'
        ? (n.text ?? '')
        : n.type === 'mention'
          ? `@${String(n.attrs?.label ?? '')}`
          : ' ',
    )
    .join('');
}

function textBlocks(node: JsonNode, out: JsonNode[] = []): JsonNode[] {
  if (isTextBlock(node)) out.push(node);
  else for (const child of node.content ?? []) if (isNode(child)) textBlocks(child, out);
  return out;
}

function countOccurrences(haystack: string, needle: string): number[] {
  const at: number[] = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) at.push(i);
  return at;
}

/** Replaces `[start, end)` of the block's inline text with `replacement`, touching only affected nodes. */
function spliceInline(
  content: readonly JsonNode[],
  start: number,
  end: number,
  replacement: string,
): JsonNode[] {
  const out: JsonNode[] = [];
  let pos = 0;
  let inserted = false;
  const insert = (marks: unknown[] | undefined) => {
    if (inserted) return;
    inserted = true;
    if (replacement)
      out.push(
        marks?.length
          ? { type: 'text', text: replacement, marks }
          : { type: 'text', text: replacement },
      );
  };
  for (const node of content) {
    const text = node.type === 'text' ? (node.text ?? '') : ATOM;
    const nodeStart = pos;
    const nodeEnd = pos + text.length;
    pos = nodeEnd;
    if (nodeEnd <= start || nodeStart >= end) {
      // Untouched. A zero-length match at a node boundary inserts before the node that starts there.
      if (nodeStart >= end) insert(node.type === 'text' ? node.marks : undefined);
      out.push(node);
      continue;
    }
    if (node.type !== 'text') {
      // An atom inside the match is removed.
      insert(undefined);
      continue;
    }
    const keepBefore = text.slice(0, Math.max(0, start - nodeStart));
    const keepAfter = text.slice(Math.max(0, end - nodeStart));
    if (keepBefore) out.push({ ...node, text: keepBefore });
    insert(node.marks);
    if (keepAfter) out.push({ ...node, text: keepAfter });
  }
  insert(undefined);
  return out;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Applies `edits` in order. Fails on the first edit that doesn't match exactly once. */
export function applyTextEdits(doc: unknown, edits: readonly TextEdit[]): EditResult {
  if (!isNode(doc) || doc.type !== 'doc') {
    return { ok: false, error: { code: 'invalid', editIndex: 0, message: 'not a document' } };
  }
  if (edits.length === 0 || edits.length > MAX_EDITS) {
    return {
      ok: false,
      error: { code: 'invalid', editIndex: 0, message: `between 1 and ${MAX_EDITS} edits` },
    };
  }
  const next = clone(doc);
  const before = new Map<string, string>();
  const touched = new Map<string, JsonNode>();
  for (const [editIndex, edit] of edits.entries()) {
    if (
      !edit.find ||
      edit.find.length > MAX_FIND_CHARS ||
      edit.replace.length > MAX_REPLACE_CHARS
    ) {
      return {
        ok: false,
        error: { code: 'invalid', editIndex, message: 'find must be 1–2000 characters' },
      };
    }
    if (edit.find.includes(ATOM) || edit.replace.includes(ATOM)) {
      return { ok: false, error: { code: 'invalid', editIndex, message: 'unsupported character' } };
    }
    const matches: { block: JsonNode; at: number }[] = [];
    for (const block of textBlocks(next)) {
      for (const at of countOccurrences(inlineText(block.content!), edit.find)) {
        matches.push({ block, at });
      }
    }
    if (matches.length === 0) return { ok: false, error: { code: 'not_found', editIndex } };
    if (matches.length > 1) {
      return { ok: false, error: { code: 'ambiguous', editIndex, matches: matches.length } };
    }
    const { block, at } = matches[0]!;
    if (block.type !== 'codeBlock' && /[\r\n]/.test(edit.replace)) {
      return {
        ok: false,
        error: {
          code: 'invalid',
          editIndex,
          message: 'replace must be a single line (outside code blocks)',
        },
      };
    }
    const id = block.attrs!.id as string;
    if (!before.has(id)) before.set(id, blockPlainText(block));
    const content = spliceInline(block.content!, at, at + edit.find.length, edit.replace);
    // TipTap: an empty text block has no `content`.
    if (content.length) block.content = content;
    else delete block.content;
    touched.set(id, block);
  }
  const changes: BlockChange[] = [...touched].map(([blockId, block]) => ({
    blockId,
    before: before.get(blockId)!,
    after: blockPlainText(block),
  }));
  return { ok: true, doc: next, changes: changes.filter((c) => c.before !== c.after) };
}
