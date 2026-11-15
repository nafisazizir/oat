// Ambient types for the untyped plugin, referenced so apps type-checking this source (the
// package exports .ts) see them too — an `import` can't pull in an ambient declaration.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./markdown-it-mark.d.ts" />
import type { JSONContent } from '@tiptap/core';
import markdownIt, { type MarkdownIt, type StateCore, type Token } from 'markdown-it';
import markPlugin from 'markdown-it-mark';

import { generateBlockId, isBlockType, type Origin } from '../blocks.ts';
import { DEFAULT_CALLOUT, normalizeCalloutEmoji } from '../callout.ts';
import { ensureBlockIds, getEditorSchema } from '../schema.ts';
import type { TaskMeta } from '../task-meta.ts';
import {
  admonitionToVariant,
  isSafeHref,
  MENTION_SCHEME,
  parseMarker,
  parseTaskMetaSuffix,
  toSingleLine,
  type BlockMarker,
} from './shared.ts';

/**
 * How `[@Name](mention:<id>)` links are read:
 * - `'text'` (default): plain `@Name` text — no mention node, so untrusted Markdown (AI output,
 *   paste) can't mint mentions of arbitrary ids;
 * - `'off'`: no mention syntax at all — an ordinary link, which (`mention:` not being an allowed
 *   URI) leaves just its text;
 * - `{ resolve }`: a mention node with the id `resolve(id, label)` returns (e.g. only ids of the
 *   meeting's participants), or plain `@Name` text when it returns `null`.
 */
export type MentionPolicy =
  'off' | 'text' | { resolve: (id: string, label: string) => string | null | undefined };

export interface FromMarkdownOptions {
  /** Origin of every block (see `trustMarkers`). Default `'me'`. */
  origin?: Origin;
  /**
   * Honour `<!-- ai -->` / `<!-- me -->` markers (D-20). Only for Markdown we produced ourselves
   * (round-trips, evals) — in untrusted input a marker could relabel AI text as mine or my words as
   * AI. Default `false`: markers are stripped and `origin` applies to every block.
   */
  trustMarkers?: boolean;
  /** Keep block ids from `<!-- id=… -->` markers (still de-duplicated). Default `false`: fresh ids. */
  preserveIds?: boolean;
  /** Mention links → mention nodes? Default `'text'` (see `MentionPolicy`). */
  mentions?: MentionPolicy;
  /** Block id generator. Default: `generateBlockId()`. */
  generateId?: () => string;
}

type MarkJSON = NonNullable<JSONContent['marks']>[number];

/** Extra data a block node carries during conversion; removed before the doc is returned. */
const MARKER = Symbol('marker');
type Draft = JSONContent & { [MARKER]?: BlockMarker };

let parser: MarkdownIt | undefined;

function getParser(): MarkdownIt {
  if (parser) return parser;
  // `default` preset = CommonMark + GFM tables + strikethrough. HTML on so our `<!-- ai -->`
  // markers are visible; any other HTML becomes literal text. This instance is only ever used to
  // *parse* (`.parse()` → tokens) — never `.render()` — so `html: true` can't emit HTML.
  parser = markdownIt('default', { html: true, linkify: false, typographer: false });
  parser.use(markPlugin);
  // Store hrefs as written (no percent-encoding / punycode); `isSafeHref` gates them below.
  parser.normalizeLink = (url: string) => url;
  parser.normalizeLinkText = (url: string) => url;
  parser.core.ruler.after('block', 'oat_blocks', detectTasksAndCallouts);
  return parser;
}

const TASK_PREFIX = /^\[([ xX])\](?:[ \t]+|\n|$)/;
const ADMONITION = /^\[!([A-Za-z][\w-]*)\][ \t]*([^\n]*)(?:\n|$)/;

/**
 * Runs after block parsing, before inline parsing: strips `[ ] ` / `[x] ` from task items and
 * `[!type] emoji` from callout blockquotes, recording them in `token.meta`.
 */
function detectTasksAndCallouts(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.type !== 'list_item_open' && token.type !== 'blockquote_open') continue;
    if (tokens[i + 1]?.type !== 'paragraph_open') continue;
    const inline = tokens[i + 2];
    if (inline?.type !== 'inline') continue;

    if (token.type === 'list_item_open') {
      if (token.markup === '.' || token.markup === ')') continue; // ordered lists have no tasks
      const match = TASK_PREFIX.exec(inline.content);
      if (!match) continue;
      token.meta = { ...token.meta, checked: match[1] !== ' ' };
      inline.content = inline.content.slice(match[0].length);
      // 8.4: `(@Owner, due 2026-11-20)` at the end of the first line → owner/due attributes.
      const suffix = parseTaskMetaSuffix(inline.content);
      if (suffix) {
        inline.content = suffix.rest;
        token.meta = { ...token.meta, ...suffix.meta };
      }
      continue;
    }

    const match = ADMONITION.exec(inline.content);
    if (!match) continue;
    const rest = match[2]!.trim();
    const emoji = isSingleEmoji(rest) ? rest : undefined;
    token.meta = {
      ...token.meta,
      callout: { variant: admonitionToVariant(match[1]!), emoji: emoji ?? DEFAULT_CALLOUT.emoji },
    };
    // A title that isn't an emoji stays as the first line of the content.
    const body = inline.content.slice(match[0].length);
    inline.content = emoji || !rest ? body : body ? `${rest}\n${body}` : rest;
    // The marker line alone (content starts with another block) leaves no paragraph behind.
    if (!inline.content.trim()) tokens[i + 1]!.meta = { ...tokens[i + 1]!.meta, drop: true };
  }
}

function isSingleEmoji(text: string): boolean {
  return !!text && normalizeCalloutEmoji(text) === text && /\p{Extended_Pictographic}/u.test(text);
}

/**
 * Markdown → TipTap JSON valid for `validateDoc`: fresh block ids, `origin` from the option (or
 * from markers with `trustMarkers`), mentions per `mentions`. Never throws on any input string. Inverse of `toMarkdown` (see the Design
 * notes in docs/tasks/3.2-markdown.md for what doesn't survive).
 */
export function fromMarkdown(markdown: string, options: FromMarkdownOptions = {}): JSONContent {
  const tokens = getParser().parse(markdown, {});
  const walker = new Walker(tokens, options);
  const blocks = walker.blocks(undefined);
  const draft: Draft = { type: 'doc', content: blocks.length ? blocks : [{ type: 'paragraph' }] };
  finalizeAttrs(draft, options);
  // Fill every attribute default (and merge adjacent text) exactly like the editor would.
  const node = getEditorSchema().nodeFromJSON(draft);
  node.check();
  return ensureBlockIds(node.toJSON() as JSONContent, options.generateId ?? generateBlockId);
}

/**
 * Origin: trusted marker → `origin` option (leaf blocks) / derived from children (containers).
 * Ids: markers with `preserveIds`.
 */
function finalizeAttrs(node: Draft, options: FromMarkdownOptions): void {
  const children = (node.content ?? []) as Draft[];
  for (const child of children) finalizeAttrs(child, options);
  if (!isBlockType(node.type)) return;
  const marker = node[MARKER];
  delete node[MARKER];
  const blockChildren = children.filter((child) => isBlockType(child.type));
  const derived: Origin =
    blockChildren.length > 0
      ? blockChildren.every((child) => child.attrs?.origin === 'ai')
        ? 'ai'
        : 'me'
      : (options.origin ?? 'me');
  node.attrs = {
    ...node.attrs,
    origin: (options.trustMarkers ? marker?.origin : undefined) ?? derived,
    ...(options.preserveIds && marker?.id ? { id: marker.id } : {}),
  };
}

/** Blocks that carry markers in Markdown; containers derive their origin from their blocks. */
const LEAF_TYPES: ReadonlySet<string> = new Set([
  'paragraph',
  'heading',
  'codeBlock',
  'horizontalRule',
]);

class Walker {
  private index = 0;
  constructor(
    private readonly tokens: readonly Token[],
    private readonly options: FromMarkdownOptions,
  ) {}

  /** Block nodes until `closeType` (consumed) or the end. */
  blocks(closeType: string | undefined): Draft[] {
    const out: Draft[] = [];
    let pending: BlockMarker | undefined;
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index]!;
      if (token.type === closeType) {
        this.index++;
        break;
      }
      if (token.type === 'html_block') {
        this.index++;
        const marker = parseMarker(token.content);
        if (marker) pending = { ...pending, ...marker };
        else out.push(literalParagraph(token.content));
        continue;
      }
      const block = this.block(token);
      if (!block) continue;
      // A marker line annotates the next leaf block (containers derive their origin, see above).
      if (pending && LEAF_TYPES.has(block.type!)) block[MARKER] = { ...pending, ...block[MARKER] };
      pending = undefined;
      out.push(...splitTaskRuns(block));
    }
    return out;
  }

  private block(token: Token): Draft | undefined {
    this.index++;
    switch (token.type) {
      case 'paragraph_open': {
        const { content, marker } = this.inlineUntil('paragraph_close');
        if ((token.meta as { drop?: boolean } | null)?.drop) return undefined;
        return withMarker({ type: 'paragraph', content }, marker);
      }
      case 'heading_open': {
        const level = Math.min(Number(token.tag.slice(1)) || 1, 3);
        const { content, marker } = this.inlineUntil('heading_close');
        // A heading is one line in Markdown (a setext heading's hard break becomes a space).
        const line = content.map((node) =>
          node.type === 'hardBreak' ? { type: 'text', text: ' ' } : node,
        );
        return withMarker({ type: 'heading', attrs: { level }, content: line }, marker);
      }
      case 'fence':
      case 'code_block': {
        const language = token.info.trim().split(/\s+/)[0] || null;
        const text = token.content.replace(/\n$/, '');
        return {
          type: 'codeBlock',
          attrs: { language },
          content: text ? [{ type: 'text', text }] : [],
        };
      }
      case 'hr':
        return { type: 'horizontalRule' };
      case 'blockquote_open': {
        const callout = (token.meta as { callout?: JSONContent['attrs'] } | null)?.callout;
        const content = this.blocks('blockquote_close');
        return {
          type: callout ? 'callout' : 'blockquote',
          ...(callout ? { attrs: callout } : {}),
          content: content.length ? content : [{ type: 'paragraph' }],
        };
      }
      case 'bullet_list_open':
        return { type: 'bulletList', content: this.blocks('bullet_list_close') };
      case 'ordered_list_open': {
        const start = Number(token.attrGet('start') ?? 1);
        return {
          type: 'orderedList',
          attrs: { start: Number.isSafeInteger(start) ? start : 1 },
          content: this.blocks('ordered_list_close'),
        };
      }
      case 'list_item_open': {
        const meta = token.meta as (Partial<TaskMeta> & { checked?: boolean }) | null;
        const checked = meta?.checked;
        const content = this.blocks('list_item_close');
        // List items must start with a paragraph.
        if (content[0]?.type !== 'paragraph') content.unshift({ type: 'paragraph' });
        return checked === undefined
          ? { type: 'listItem', content }
          : {
              type: 'taskItem',
              attrs: { checked, owner: meta?.owner ?? null, due: meta?.due ?? null },
              content,
            };
      }
      case 'table_open':
        return this.table();
      default:
        // Closing tokens of structures we don't model, or unknown blocks: skip.
        return undefined;
    }
  }

  /** GFM table → one paragraph holding the table source, one row per line ("tables as text"). */
  private table(): Draft {
    const rows: string[][] = [];
    const aligns: string[] = [];
    let row: string[] | undefined;
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index++]!;
      if (token.type === 'table_close') break;
      if (token.type === 'tr_open') rows.push((row = []));
      if (token.type === 'th_open') {
        const style = String(token.attrGet('style') ?? '');
        aligns.push(
          style.includes('center')
            ? ':-:'
            : style.includes('left')
              ? ':--'
              : style.includes('right')
                ? '--:'
                : '---',
        );
      }
      if (token.type === 'inline') row?.push(token.content);
    }
    const lines = rows.map((cells) => `| ${cells.join(' | ')} |`);
    lines.splice(1, 0, `| ${aligns.join(' | ')} |`);
    return literalParagraph(lines.join('\n'));
  }

  private inlineUntil(closeType: string): { content: JSONContent[]; marker?: BlockMarker } {
    let result: { content: JSONContent[]; marker?: BlockMarker } = { content: [] };
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index++]!;
      if (token.type === closeType) break;
      if (token.type === 'inline') result = convertInline(token.children ?? [], this.options);
    }
    return result;
  }
}

function withMarker(node: Draft, marker: BlockMarker | undefined): Draft {
  if (marker) node[MARKER] = marker;
  return node;
}

/** Raw text (HTML, table source) as a paragraph; lines become hard breaks. */
function literalParagraph(text: string): Draft {
  const content: JSONContent[] = [];
  text
    .replace(/\n+$/, '')
    .split('\n')
    .forEach((line, index) => {
      if (index > 0) content.push({ type: 'hardBreak' });
      if (line) content.push({ type: 'text', text: line });
    });
  return { type: 'paragraph', content: trimLines(content) };
}

/** A Markdown list mixing task and plain items → separate taskList / bulletList runs. */
function splitTaskRuns(block: Draft): Draft[] {
  if (block.type !== 'bulletList') return [block];
  const items = block.content ?? [];
  if (!items.some((item) => item.type === 'taskItem')) return [block];
  const runs: Draft[] = [];
  for (const item of items) {
    const type = item.type === 'taskItem' ? 'taskList' : 'bulletList';
    const last = runs.at(-1);
    if (last?.type === type) last.content!.push(item);
    else runs.push({ type, content: [item] });
  }
  if (block[MARKER]) runs[0]![MARKER] = block[MARKER];
  return runs;
}

// ---------------------------------------------------------------------------------------------
// Inline

const MARK_TOKENS: Readonly<Record<string, string>> = {
  strong: 'bold',
  em: 'italic',
  s: 'strike',
  mark: 'highlight',
};

/**
 * `code` excludes every other mark in the schema: inside a link the code formatting is dropped
 * (the link matters more), otherwise only `code` is kept.
 */
function resolveMarks(marks: readonly MarkJSON[], code: boolean): MarkJSON[] | undefined {
  // Nested `**a **b** c**` opens the same mark twice: one of each type (outermost link wins).
  const unique = marks.filter(
    (mark, index) => marks.findIndex((m) => m.type === mark.type) === index,
  );
  if (code && !unique.some((mark) => mark.type === 'link')) return [{ type: 'code' }];
  return unique.length ? unique : undefined;
}

function convertInline(
  tokens: readonly Token[],
  options: FromMarkdownOptions,
): { content: JSONContent[]; marker?: BlockMarker } {
  const mentions = options.mentions ?? 'text';
  const content: JSONContent[] = [];
  let marker: BlockMarker | undefined;
  // Open marks; `null` for a link we dropped (disallowed href) so its close still pops.
  const marks: (MarkJSON | null)[] = [];
  const active = () => marks.filter((mark): mark is MarkJSON => mark !== null);
  const pushText = (text: string, code = false) => {
    if (text) content.push({ type: 'text', text, marks: resolveMarks(active(), code) });
  };

  // A trailing `<!-- ai id=… -->` annotates the block.
  let end = tokens.length;
  while (end > 0 && tokens[end - 1]!.type === 'text' && !tokens[end - 1]!.content.trim()) end--;
  const last = tokens[end - 1];
  if (last?.type === 'html_inline') {
    marker = parseMarker(last.content);
    if (marker) end--;
  }

  for (let i = 0; i < end; i++) {
    const token = tokens[i]!;
    switch (token.type) {
      case 'text':
        pushText(token.content);
        break;
      case 'softbreak':
        pushText(' ');
        break;
      case 'hardbreak':
        content.push({ type: 'hardBreak' });
        break;
      case 'code_inline':
        pushText(token.content, true);
        break;
      case 'html_inline':
        pushText(token.content);
        break;
      case 'image': {
        const src = String(token.attrGet('src') ?? '');
        const alt = token.content || src;
        const link = isSafeHref(src) ? { type: 'link', attrs: { href: src } } : null;
        marks.push(link);
        pushText(alt);
        marks.pop();
        break;
      }
      case 'link_open': {
        const href = String(token.attrGet('href') ?? '');
        if (href.startsWith(MENTION_SCHEME) && mentions !== 'off') {
          // `[@Name](mention:id)` → mention node (if the policy allows); the label is the link's text.
          let label = '';
          while (i + 1 < end && tokens[i + 1]!.type !== 'link_close') {
            const inner = tokens[++i]!;
            label += inner.type === 'softbreak' || inner.type === 'hardbreak' ? ' ' : inner.content;
          }
          i++; // link_close
          label = toSingleLine(label).replace(/^@/, '');
          let id = href.slice(MENTION_SCHEME.length);
          try {
            id = decodeURIComponent(id);
          } catch {
            // keep the raw id
          }
          const resolved = typeof mentions === 'object' ? mentions.resolve(id, label) : null;
          if (resolved) {
            content.push({
              type: 'mention',
              attrs: { id: resolved, label },
              marks: resolveMarks(active(), false),
            });
          } else {
            pushText(`@${label}`);
          }
          break;
        }
        const title = token.attrGet('title');
        const titleText = title == null ? '' : toSingleLine(String(title));
        marks.push(
          isSafeHref(href)
            ? { type: 'link', attrs: { href, ...(titleText ? { title: titleText } : {}) } }
            : null,
        );
        break;
      }
      case 'link_close':
        marks.pop();
        break;
      default: {
        const name = MARK_TOKENS[token.type.replace(/_(open|close)$/, '')];
        if (!name) break;
        if (token.type.endsWith('_open')) {
          marks.push({ type: name });
        } else {
          const at = marks.findLastIndex((mark) => mark?.type === name);
          if (at >= 0) marks.splice(at, 1);
        }
      }
    }
  }

  return { content: trimLines(content), marker };
}

/**
 * Whitespace at the start or end of a line (block edges, around hard breaks) has no stable
 * Markdown form — leading spaces would become indented code — so it is dropped (code keeps it),
 * as are hard breaks at the start or end of a block.
 */
function trimLines(content: JSONContent[]): JSONContent[] {
  const out: JSONContent[] = [];
  let lineStart = true;
  const isPlain = (node: JSONContent | undefined) =>
    node?.type === 'text' && !node.marks?.some((mark) => mark.type === 'code');
  const trimEnd = () => {
    while (isPlain(out.at(-1))) {
      const last = out.at(-1)!;
      last.text = last.text!.replace(/[ \t]+$/, '');
      if (last.text) break;
      out.pop();
    }
  };
  for (const node of content) {
    if (node.type === 'hardBreak') {
      trimEnd();
      out.push(node);
      lineStart = true;
      continue;
    }
    if (lineStart && isPlain(node)) {
      const text = node.text!.replace(/^[ \t]+/, '');
      if (!text) continue;
      out.push({ ...node, text });
    } else {
      out.push(node);
    }
    lineStart = false;
  }
  trimEnd();
  // Leading / trailing hard breaks have no Markdown form either.
  while (out[0]?.type === 'hardBreak') out.shift();
  while (out.at(-1)?.type === 'hardBreak') {
    out.pop();
    trimEnd();
  }
  return out;
}
