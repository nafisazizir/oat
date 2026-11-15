/**
 * Who wrote what (D-20, D-23): after the model answers, every block's `origin` is **derived** here, never
 * trusted from the model. A block is `me` when its text matches one of the user's note lines (normalised text,
 * similarity ≥ {@link ORIGIN_MATCH_THRESHOLD}); its text then becomes the user's own line, word for word.
 * Everything else is `ai`. Note lines the model dropped are put back under an "Other notes" section, so
 * enhancing never loses the user's text.
 *
 * Pure and synchronous; runs on partial (streaming) output too, for the live preview.
 */
import { type JSONContent, taskMetaOf, type TaskOwner } from '@oat/editor';
import { fromMarkdown } from '@oat/editor/markdown';

import type { EnhanceBlock, EnhanceOutput, EnhanceSection, ListItemBlock } from './enhance.ts';

/** Heading of the section that holds note lines the model left out. */
export const OTHER_NOTES_HEADING = 'Other notes';

/**
 * Minimum similarity (bigram Dice over normalised text) for a block to count as the user's line. High on
 * purpose: a block the model reworded is AI text, and the user's original line is kept separately.
 */
export const ORIGIN_MATCH_THRESHOLD = 0.85;

/** Normalised lines shorter than this only match exactly (bigram overlap is noisy on short strings). */
const MIN_FUZZY_LENGTH = 12;

export type NoteLineKind = 'paragraph' | 'heading' | 'bullet' | 'task';

/** One line (textblock) of the user's notes. */
export interface NoteLine {
  /** Position in the notes, from 0. */
  index: number;
  kind: NoteLineKind;
  /** Plain text on one line (mentions as `@Name`). */
  text: string;
  /** {@link normalizeLine} of `text`; the matching key. */
  key: string;
  /** The line's inline content as written (marks, links, mentions), reused for `me` blocks. */
  content: JSONContent[];
  /** Task lines: whether the box was ticked. */
  checked?: boolean;
  /** Task lines: the owner / due date the user set (8.4), kept on their task. */
  owner?: TaskOwner | null;
  due?: string | null;
  /** Code-block lines: the raw code, line breaks kept (re-inserted as a code block). */
  code?: string;
}

/**
 * Lowercase, NFKC, curly quotes straightened, list/heading/checkbox markers stripped, punctuation → space,
 * whitespace collapsed. Two lines with the same key say the same thing.
 */
export function normalizeLine(text: string): string {
  return (
    text
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/^\s*(?:#{1,6}\s+|[-*+•]\s+|\d+[.)]\s+)?(?:\[[ x]\]\s+)?/u, '')
      // A task's owner/due suffix as the notes show it to the model (8.4): `(@Dana, due 2026-11-20)`.
      .replace(
        /\s*\((?:@[^()\n]{1,200}?(?:,\s*due \d{4}-\d{2}-\d{2})?|due \d{4}-\d{2}-\d{2})\)\s*$/u,
        '',
      )
      .replace(/[^\p{L}\p{N}%$']+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Bigram multiset of a key. */
function bigrams(key: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < key.length - 1; i++) {
    const gram = key.slice(i, i + 2);
    out.set(gram, (out.get(gram) ?? 0) + 1);
  }
  return out;
}

function dice(a: Map<string, number>, aLen: number, b: Map<string, number>, bLen: number): number {
  if (aLen + bLen === 0) return 0;
  let overlap = 0;
  for (const [gram, n] of a) overlap += Math.min(n, b.get(gram) ?? 0);
  return (2 * overlap) / (aLen + bLen);
}

/** Similarity of two normalised keys in 0..1: 1 when equal, bigram Dice otherwise (0 for short keys). */
export function lineSimilarity(a: string, b: string): number {
  if (a === b) return a.length > 0 ? 1 : 0;
  if (Math.min(a.length, b.length) < MIN_FUZZY_LENGTH) return 0;
  return dice(bigrams(a), a.length - 1, bigrams(b), b.length - 1);
}

const TEXTBLOCKS = new Set(['paragraph', 'heading', 'codeBlock']);

function inlineText(nodes: readonly JSONContent[] | undefined): string {
  return (nodes ?? [])
    .map((n) => {
      if (n.type === 'text') return n.text ?? '';
      if (n.type === 'mention') return `@${String(n.attrs?.label ?? n.attrs?.id ?? '')}`;
      if (n.type === 'hardBreak') return ' ';
      return inlineText(n.content);
    })
    .join('');
}

/** Inline content split at hard breaks (Shift+Enter): each part is a line of its own. */
function splitAtBreaks(content: readonly JSONContent[]): JSONContent[][] {
  const parts: JSONContent[][] = [[]];
  for (const node of content) {
    if (node.type === 'hardBreak') parts.push([]);
    else parts.at(-1)!.push(node);
  }
  return parts;
}

const ITEMS = new Set(['listItem', 'taskItem']);

/**
 * Whether a textblock is the user's (D-23): neither the block itself nor the list item directly holding it is
 * `ai`. An AI block the user edited stays `ai`; a line they typed (Enter, or into an emptied AI block) is `me`.
 */
function isMine(node: JSONContent, parent: JSONContent | undefined): boolean {
  if (node.attrs?.origin === 'ai') return false;
  return !(parent && ITEMS.has(parent.type ?? '') && parent.attrs?.origin === 'ai');
}

/**
 * The user's note lines in document order: every non-empty textblock of theirs (split at hard breaks), typed
 * by where it sits. AI-written blocks (an already enhanced body) are not the user's notes and are skipped.
 */
export function noteLinesFromDoc(doc: JSONContent | null | undefined): NoteLine[] {
  const lines: NoteLine[] = [];
  const visit = (node: JSONContent, parent: JSONContent | undefined) => {
    if (node.type && TEXTBLOCKS.has(node.type)) {
      if (!isMine(node, parent)) return;
      const kind: NoteLineKind =
        parent?.type === 'taskItem'
          ? 'task'
          : parent?.type === 'listItem'
            ? 'bullet'
            : node.type === 'heading'
              ? 'heading'
              : 'paragraph';
      if (node.type === 'codeBlock') {
        const code = inlineText(node.content);
        const text = code.replace(/\s+/g, ' ').trim();
        const key = normalizeLine(text);
        if (key) {
          lines.push({
            index: lines.length,
            kind: 'paragraph',
            text,
            key,
            content: [{ type: 'text', text }],
            code,
          });
        }
        return;
      }
      // Everything else keeps its inline nodes (marks, mentions, links).
      for (const part of splitAtBreaks(node.content ?? [])) {
        const text = inlineText(part).replace(/\s+/g, ' ').trim();
        const key = normalizeLine(text);
        if (!key) continue;
        lines.push({
          index: lines.length,
          kind,
          text,
          key,
          content: structuredClone(part),
          ...(kind === 'task'
            ? { checked: parent?.attrs?.checked === true, ...taskMetaOf(parent?.attrs) }
            : {}),
        });
      }
      return;
    }
    for (const child of node.content ?? []) visit(child, node);
  };
  if (doc) visit(doc, undefined);
  return lines;
}

function hasAiBlocks(node: JSONContent): boolean {
  return node.attrs?.origin === 'ai' || (node.content ?? []).some(hasAiBlocks);
}

/**
 * The user's own notes in a body: the body itself when it has no AI blocks, else a doc rebuilt from the user's
 * lines only (in order; list lines grouped, task boxes, code and inline content kept), so a re-enhanced note
 * never feeds the previous AI output back in as "my notes". `null` when nothing of the user's is left.
 */
export function myNotesOnly(doc: JSONContent | null | undefined): JSONContent | null {
  if (!doc) return null;
  if (!hasAiBlocks(doc)) return doc;
  const lines = noteLinesFromDoc(doc);
  if (!lines.length) return null;
  const content: JSONContent[] = [];
  for (const line of lines) {
    const paragraph: JSONContent = {
      type: 'paragraph',
      attrs: { origin: 'me' },
      content: line.content,
    };
    if (line.kind === 'bullet' || line.kind === 'task') {
      const listType = line.kind === 'task' ? 'taskList' : 'bulletList';
      const item: JSONContent =
        line.kind === 'task'
          ? {
              type: 'taskItem',
              attrs: {
                origin: 'me',
                checked: line.checked === true,
                owner: line.owner ?? null,
                due: line.due ?? null,
              },
              content: [paragraph],
            }
          : { type: 'listItem', attrs: { origin: 'me' }, content: [paragraph] };
      const prev = content.at(-1);
      if (prev?.type === listType) prev.content!.push(item);
      else content.push({ type: listType, attrs: { origin: 'me' }, content: [item] });
    } else if (line.code !== undefined) {
      content.push({
        type: 'codeBlock',
        attrs: { origin: 'me' },
        content: [{ type: 'text', text: line.code }],
      });
    } else if (line.kind === 'heading') {
      content.push({ type: 'heading', attrs: { origin: 'me', level: 3 }, content: line.content });
    } else {
      content.push(paragraph);
    }
  }
  return { type: 'doc', content };
}

const BLOCK_START = /^(?:\s|[-*+]\s|\d+[.)]\s|#{1,6}\s|>|```|~~~|\|)/;

/**
 * Rough notes are typed line by line: a line break is a new line, not a soft wrap. Inserts a blank line before
 * every plain line that follows another non-blank line (outside fenced code), so Markdown keeps them apart.
 */
function separateLines(markdown: string): string {
  const out: string[] = [];
  let fenced = false;
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced;
    const prev = out.at(-1);
    if (!fenced && prev !== undefined && prev.trim() && line.trim() && !BLOCK_START.test(line)) {
      out.push('');
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Markdown notes (evals, tests) → a notes doc. Every typed line stays its own line. Untrusted input: origin
 * markers are ignored, mention links stay text, and block ids are sequential so the prompt is reproducible.
 */
export function notesDocFromMarkdown(markdown: string): JSONContent {
  let n = 0;
  return fromMarkdown(separateLines(markdown), {
    trustMarkers: false,
    mentions: 'text',
    generateId: () => `n${++n}`,
  });
}

/**
 * Finds the user's line a block's text corresponds to: lines with an equal key, else lines scoring ≥ threshold,
 * best first (candidates memoised per text). With a `used` set an unused candidate wins, so a line typed twice
 * and kept twice matches both copies (multiset matching).
 */
export class NoteLineMatcher {
  readonly lines: readonly NoteLine[];
  readonly #grams: Array<{ grams: Map<string, number>; size: number }>;
  readonly #cache = new Map<string, NoteLine[]>();

  constructor(lines: readonly NoteLine[]) {
    this.lines = lines;
    this.#grams = lines.map((l) => ({
      grams: bigrams(l.key),
      size: Math.max(0, l.key.length - 1),
    }));
  }

  #candidates(key: string): NoteLine[] {
    const cached = this.#cache.get(key);
    if (cached) return cached;
    let found: NoteLine[] = key ? this.lines.filter((l) => l.key === key) : [];
    if (!found.length && key.length >= MIN_FUZZY_LENGTH) {
      const grams = bigrams(key);
      const scored: Array<[NoteLine, number]> = [];
      this.lines.forEach((line, i) => {
        if (line.key.length < MIN_FUZZY_LENGTH) return;
        const { grams: lineGrams, size } = this.#grams[i]!;
        const score = dice(grams, key.length - 1, lineGrams, size);
        if (score >= ORIGIN_MATCH_THRESHOLD) scored.push([line, score]);
      });
      found = scored.sort((x, y) => y[1] - x[1] || x[0].index - y[0].index).map(([l]) => l);
    }
    this.#cache.set(key, found);
    return found;
  }

  match(text: string, used?: ReadonlySet<number>): NoteLine | undefined {
    const candidates = this.#candidates(normalizeLine(text));
    return (used && candidates.find((l) => !used.has(l.index))) ?? candidates[0];
  }
}

export interface Reconciled {
  /** The output with derived origins, `me` texts replaced by the user's lines, missing lines re-inserted. */
  output: EnhanceOutput;
  /** For each `me` block: the note line it keeps (the TipTap conversion reuses its inline content). */
  sourceLine: WeakMap<EnhanceBlock, NoteLine>;
  /** Note lines the model left out (re-inserted under {@link OTHER_NOTES_HEADING} when asked to). */
  missing: NoteLine[];
}

export interface ReconcileOptions {
  /** Append lines the model dropped under {@link OTHER_NOTES_HEADING}. Default `true` (off for previews). */
  insertMissing?: boolean;
}

function lineAsBlock(line: NoteLine): EnhanceBlock {
  const kind = line.kind === 'task' ? 'task' : line.kind === 'bullet' ? 'bullet' : 'paragraph';
  return { kind, text: line.text, origin: 'me' };
}

/**
 * Derives `origin` for every block (nested ones too) by matching against the user's note lines, and puts back
 * any line the output lost. Returns new objects; the input is not modified.
 */
export function reconcileWithNotes(
  output: EnhanceOutput,
  matcher: NoteLineMatcher | readonly NoteLine[],
  options: ReconcileOptions = {},
): Reconciled {
  const m = matcher instanceof NoteLineMatcher ? matcher : new NoteLineMatcher(matcher);
  const sourceLine = new WeakMap<EnhanceBlock, NoteLine>();
  const used = new Set<number>();

  const fix = (block: EnhanceBlock): EnhanceBlock => {
    const line = m.match(block.text, used);
    let next: EnhanceBlock = { ...block, origin: line ? 'me' : 'ai' };
    if (line) {
      used.add(line.index);
      next.text = line.text;
      // A task of mine stays a task (its checkbox is mine too).
      if (line.kind === 'task' && next.kind !== 'task') {
        const children = next.kind === 'paragraph' ? undefined : next.children;
        next = {
          kind: 'task',
          text: line.text,
          origin: 'me',
          ...(children?.length ? { children } : {}),
          ...(next.sources ? { sources: next.sources } : {}),
        };
      }
      sourceLine.set(next, line);
    }
    if (next.kind !== 'paragraph' && next.children) {
      next.children = next.children.map((c) => fix(c) as ListItemBlock);
    }
    return next;
  };

  const sections: EnhanceSection[] = output.sections.map((s) => ({
    heading: s.heading,
    blocks: s.blocks.map(fix),
  }));
  const missing = m.lines.filter((l) => !used.has(l.index));
  if (missing.length && options.insertMissing !== false) {
    const blocks = missing.map((line) => {
      const block = lineAsBlock(line);
      sourceLine.set(block, line);
      return block;
    });
    const existing = sections.find(
      (s) => normalizeLine(s.heading) === normalizeLine(OTHER_NOTES_HEADING),
    );
    if (existing) existing.blocks.push(...blocks);
    else sections.push({ heading: OTHER_NOTES_HEADING, blocks });
  }
  return { output: { sections }, sourceLine, missing };
}

// ---------------------------------------------------------------------------------------------------------
// Partial (streaming) output
// ---------------------------------------------------------------------------------------------------------

const KINDS = new Set(['paragraph', 'bullet', 'task']);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function partialBlock(value: unknown, depth: number): EnhanceBlock | undefined {
  if (!isRecord(value) || typeof value.text !== 'string' || !value.text.trim()) return undefined;
  const kind = typeof value.kind === 'string' && KINDS.has(value.kind) ? value.kind : 'bullet';
  const block = { kind, text: value.text, origin: 'ai' } as EnhanceBlock;
  if (block.kind !== 'paragraph' && Array.isArray(value.children) && depth < 4) {
    const children = value.children
      .map((c) => partialBlock(c, depth + 1))
      .filter(
        (c): c is EnhanceBlock => c !== undefined && c.kind !== 'paragraph',
      ) as ListItemBlock[];
    if (children.length) block.children = children;
  }
  if (block.kind === 'task') {
    if (typeof value.owner === 'string' && value.owner) block.owner = value.owner;
    if (typeof value.due === 'string' && value.due) block.due = value.due;
  }
  return block;
}

/**
 * A partial structured-output object (any shape the stream has produced so far) → a well-formed
 * {@link EnhanceOutput}: sections without a heading and blocks without text are dropped, unknown kinds become
 * bullets. Origins are placeholders; run {@link reconcileWithNotes} next.
 */
export function sanitizePartialOutput(partial: unknown): EnhanceOutput {
  const sections = isRecord(partial) && Array.isArray(partial.sections) ? partial.sections : [];
  return {
    sections: sections.flatMap((s): EnhanceSection[] => {
      if (!isRecord(s) || typeof s.heading !== 'string' || !s.heading.trim()) return [];
      const blocks = Array.isArray(s.blocks)
        ? s.blocks.map((b) => partialBlock(b, 0)).filter((b): b is EnhanceBlock => !!b)
        : [];
      return [{ heading: s.heading, blocks }];
    }),
  };
}
