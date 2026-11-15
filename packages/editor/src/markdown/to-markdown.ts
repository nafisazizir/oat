import type { JSONContent } from '@tiptap/core';

import { isOrigin } from '../blocks.ts';
import { DEFAULT_CALLOUT, isCalloutVariant, normalizeCalloutEmoji } from '../callout.ts';
import { formatTaskMeta, taskMetaOf } from '../task-meta.ts';
import {
  encodeMentionId,
  formatMarker,
  isMarkerSafeId,
  isSafeHref,
  MENTION_SCHEME,
  taskMetaSuffixIndex,
  toSingleLine,
  type BlockMarker,
} from './shared.ts';

export interface ToMarkdownOptions {
  /**
   * Annotate AI-written blocks (`origin: 'ai'`, D-20) with an `<!-- ai -->` comment, for prompts and
   * evals that need to tell my notes from AI text. Default `false`.
   */
  includeOrigin?: boolean;
  /** Annotate blocks with `<!-- id=… -->` so AI output can cite them. Default `false`. */
  blockIds?: boolean;
  /**
   * Mentions as `[@Name](mention:<id>)` (lossless; `fromMarkdown` turns them back into mentions)
   * instead of plain `@Name`. Default `false`.
   */
  mentionIds?: boolean;
}

interface Context extends Required<ToMarkdownOptions> {
  /** Previous rendered sibling, for alternating list markers so adjacent lists stay separate. */
  previousList?: { type: string; marker: string };
  /**
   * Set while rendering a task item's first paragraph: its owner/due suffix (`(@Dana, due 2026-11-20)` or
   * `''`). The paragraph consumes it.
   */
  taskSuffix?: string;
}

/**
 * TipTap JSON (canonical, D-4) → Markdown (CommonMark + GFM task lists/strikethrough, plus
 * `==highlight==` and `> [!variant] emoji` callouts). Pure; runs in Node and the browser.
 * See docs/tasks/3.2-markdown.md (Design notes) for the mapping and the lossy cases.
 */
export function toMarkdown(doc: JSONContent, options: ToMarkdownOptions = {}): string {
  const ctx: Context = {
    includeOrigin: options.includeOrigin ?? false,
    blockIds: options.blockIds ?? false,
    mentionIds: options.mentionIds ?? false,
  };
  const blocks = doc.type === 'doc' ? (doc.content ?? []) : [doc];
  return renderBlocks(blocks, ctx);
}

// ---------------------------------------------------------------------------------------------
// Blocks

const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList']);

function renderBlocks(nodes: readonly JSONContent[], ctx: Context): string {
  const parts: string[] = [];
  const saved = ctx.previousList;
  ctx.previousList = undefined;
  for (const node of nodes) {
    const rendered = renderBlock(node, ctx);
    if (!LIST_TYPES.has(node.type ?? '') && rendered) ctx.previousList = undefined;
    if (rendered) parts.push(rendered);
  }
  ctx.previousList = saved;
  return parts.join('\n\n');
}

function markerFor(node: JSONContent, ctx: Context): string {
  const marker: BlockMarker = {};
  const { origin, id } = node.attrs ?? {};
  if (ctx.includeOrigin && isOrigin(origin) && origin === 'ai') marker.origin = origin;
  if (ctx.blockIds && isMarkerSafeId(id)) marker.id = id;
  return formatMarker(marker);
}

/** Textblocks carry their marker at the end of the line; other leaves on the line before. */
const withTrailingMarker = (text: string, marker: string) =>
  marker ? (text ? `${text} ${marker}` : marker) : text;
const withLeadingMarker = (text: string, marker: string) => (marker ? `${marker}\n${text}` : text);

function renderBlock(node: JSONContent, ctx: Context): string {
  const children = node.content ?? [];
  switch (node.type) {
    case 'paragraph': {
      const suffix = ctx.taskSuffix;
      ctx.taskSuffix = undefined;
      let text = renderInline(children, ctx, false);
      if (suffix !== undefined) text = withTaskSuffix(text, suffix);
      // An empty paragraph has no Markdown form (blank lines separate blocks) — dropped.
      return text ? withTrailingMarker(text, markerFor(node, ctx)) : '';
    }
    case 'heading': {
      const level = Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 6);
      const text = escapeClosingHashes(renderInline(children, ctx, true));
      const body = withTrailingMarker(text, markerFor(node, ctx));
      return body ? `${'#'.repeat(level)} ${body}` : '#'.repeat(level);
    }
    case 'codeBlock':
      return withLeadingMarker(renderCodeBlock(node), markerFor(node, ctx));
    case 'horizontalRule':
      return withLeadingMarker('---', markerFor(node, ctx));
    case 'blockquote':
      return prefixLines(renderBlocks(children, ctx), '>');
    case 'callout': {
      const variant = isCalloutVariant(node.attrs?.variant)
        ? node.attrs.variant
        : DEFAULT_CALLOUT.variant;
      const emoji = normalizeCalloutEmoji(node.attrs?.emoji);
      const body = renderBlocks(children, ctx);
      const head = `[!${variant}] ${emoji}`;
      // A first paragraph continues the marker line (GitHub alert style). Anything else starts
      // after a blank line: `---` would make the marker a setext heading, and some lists can't
      // interrupt a paragraph.
      const separator = children[0]?.type === 'paragraph' && body ? '\n' : '\n\n';
      return prefixLines(body ? head + separator + body : head, '>');
    }
    case 'bulletList':
    case 'taskList':
    case 'orderedList':
      return renderList(node, ctx);
    case 'listItem':
    case 'taskItem':
      // Outside a list (invalid doc) — render as the list it would be in.
      return renderList(
        { type: node.type === 'taskItem' ? 'taskList' : 'bulletList', content: [node] },
        ctx,
      );
    default:
      // Unknown block: keep its text rather than losing it.
      if (children.some((child) => child.type === 'text' || child.type === 'hardBreak')) {
        return renderInline(children, ctx, false);
      }
      return renderBlocks(children, ctx);
  }
}

function prefixLines(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => (line ? `${prefix} ${line}` : prefix))
    .join('\n');
}

function renderCodeBlock(node: JSONContent): string {
  const text = (node.content ?? []).map((child) => child.text ?? '').join('');
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  const language = typeof node.attrs?.language === 'string' ? node.attrs.language : '';
  // Info string: first word only, and no backticks (they would end a backtick fence's info).
  const info = language.trim().split(/\s+/)[0]!.replace(/`/g, '');
  return `${fence}${info}\n${text ? `${text}\n` : ''}${fence}`;
}

function renderList(node: JSONContent, ctx: Context): string {
  const type = node.type ?? 'bulletList';
  const ordered = type === 'orderedList';
  // Two adjacent lists of the same kind would merge into one; alternate the marker instead.
  const previous = ctx.previousList;
  const sameKind = previous && (previous.type === 'orderedList') === ordered;
  const marker = ordered
    ? sameKind && previous.marker === '.'
      ? ')'
      : '.'
    : sameKind && previous.marker === '-'
      ? '*'
      : '-';
  ctx.previousList = { type, marker };

  const start = Number(node.attrs?.start ?? 1);
  const items = (node.content ?? []).map((item, index) => {
    let bullet: string;
    let indent: number;
    if (ordered) {
      bullet = `${Number.isSafeInteger(start) && start >= 0 ? start + index : index + 1}${marker}`;
      indent = bullet.length + 1;
    } else if (item.type === 'taskItem') {
      bullet = `${marker} [${item.attrs?.checked ? 'x' : ' '}]`;
      indent = 2;
    } else {
      bullet = marker;
      indent = 2;
    }
    const lines = renderListItemBody(item, ctx).split('\n');
    const pad = ' '.repeat(indent);
    const first = lines[0] ? `${bullet} ${lines[0]}` : bullet;
    return [first, ...lines.slice(1).map((line) => (line ? pad + line : ''))].join('\n');
  });
  // Tight unless an item already contains a blank line (then the list is loose anyway).
  const loose = items.some((item) => item.includes('\n\n'));
  const result = items.join(loose ? '\n\n' : '\n');
  ctx.previousList = { type, marker };
  return result;
}

/**
 * A task's text with its owner/due suffix (8.4). Text that already ends like a suffix gets its `(` escaped, so
 * it reads back as text, not as attributes.
 */
function withTaskSuffix(text: string, suffix: string): string {
  let out = text;
  const open = taskMetaSuffixIndex(out);
  if (open >= 0) out = `${out.slice(0, open)}\\${out.slice(open)}`;
  if (!suffix) return out;
  return out ? `${out} ${suffix}` : suffix;
}

/** `(@Dana Lee, due 2026-11-20)`; the name escaped so it can't end the suffix or add structure. */
function taskSuffixFor(item: JSONContent): string {
  const meta = taskMetaOf(item.attrs);
  if (!meta.owner && !meta.due) return '';
  const owner = meta.owner && {
    ...meta.owner,
    name: escapeText(meta.owner.name, false).replace(/[(),]/g, '\\$&'),
  };
  return `(${formatTaskMeta({ owner, due: meta.due })})`;
}

function renderListItemBody(item: JSONContent, ctx: Context): string {
  const saved = ctx.previousList;
  ctx.previousList = undefined;
  let body = '';
  let previousEmpty = true;
  let children = item.content ?? [];
  // An empty first paragraph followed by another paragraph can't be expressed: that paragraph
  // becomes the item's first line.
  const isTask = item.type === 'taskItem';
  if (children[0]?.type === 'paragraph' && children[1]?.type === 'paragraph') {
    const first = renderBlock(children[0], ctx);
    if (!first) children = children.slice(1);
  }
  for (const [index, child] of children.entries()) {
    if (isTask)
      ctx.taskSuffix = index === 0 && child.type === 'paragraph' ? taskSuffixFor(item) : undefined;
    const rendered = renderBlock(child, ctx);
    ctx.taskSuffix = undefined;
    if (!LIST_TYPES.has(child.type ?? '') && rendered) ctx.previousList = undefined;
    if (index === 0) {
      body = rendered;
      previousEmpty = !rendered;
      continue;
    }
    if (!rendered) continue;
    // After the item's first line a nested list needs no blank line — unless it can't interrupt
    // a paragraph (ordered not starting at 1, or an empty first item, which would turn the line
    // above into a setext heading). An empty first line must be followed directly.
    const tight =
      previousEmpty ||
      (LIST_TYPES.has(child.type ?? '') &&
        !(child.type === 'orderedList' && Number(child.attrs?.start ?? 1) !== 1) &&
        !/^(?:[-*]|\d+[.)])(?:\n|$)/.test(rendered));
    body += (tight ? '\n' : '\n\n') + rendered;
    previousEmpty = false;
  }
  ctx.previousList = saved;
  return body;
}

// ---------------------------------------------------------------------------------------------
// Inline

type MarkJSON = NonNullable<JSONContent['marks']>[number];

/** Outer → inner preference for marks that start together. */
const MARK_ORDER = ['link', 'bold', 'italic', 'strike', 'highlight'] as const;
const DELIMITERS: Readonly<Record<string, string>> = {
  bold: '**',
  italic: '*',
  strike: '~~',
  highlight: '==',
};

/** Used for bold / italic opening right after a closing `*`, where `*` would merge into one run. */
const ALT_DELIMITERS: Readonly<Record<string, string>> = { bold: '__', italic: '_' };

interface OpenMark {
  key: string;
  mark: MarkJSON;
  /** The delimiter written (`**` or `__`, …). */
  delimiter: string;
  openStart: number;
  openEnd: number;
}

function markKey(mark: MarkJSON): string {
  return mark.type === 'link'
    ? `link\u0000${String(mark.attrs?.href)}\u0000${String(mark.attrs?.title ?? '')}`
    : mark.type;
}

function markSetKey(node: JSONContent): string {
  return (node.marks ?? [])
    .map((mark) => (mark.type === 'link' ? markKey(mark) : mark.type))
    .sort()
    .join('\u0001');
}

/**
 * Marks we render around content (code is rendered as the content itself). A link whose href
 * isn't safe (`javascript:`, protocol-relative…) is dropped and only its text is written.
 */
function outerMarks(node: JSONContent): MarkJSON[] {
  return (node.marks ?? []).filter(
    (mark) => mark.type in DELIMITERS || (mark.type === 'link' && isSafeHref(mark.attrs?.href)),
  );
}

function renderInline(nodes: readonly JSONContent[], ctx: Context, heading: boolean): string {
  // Hard breaks split the content into lines; marks are closed and reopened around them.
  const lines: JSONContent[][] = [[]];
  for (const original of nodes) {
    // Headings are one line in Markdown: breaks become spaces.
    const node: JSONContent =
      heading && original.type === 'hardBreak' ? { type: 'text', text: ' ' } : original;
    const line = lines.at(-1)!;
    const previous = line.at(-1);
    if (node.type === 'hardBreak') lines.push([]);
    else if (
      // Merge adjacent text with the same marks (as ProseMirror does), so escaping decisions at
      // node edges don't depend on how the text happens to be split.
      node.type === 'text' &&
      previous?.type === 'text' &&
      markSetKey(previous) === markSetKey(node)
    ) {
      line[line.length - 1] = { ...previous, text: (previous.text ?? '') + (node.text ?? '') };
    } else line.push(node);
  }
  const rendered = lines.map((line) => renderLine(line, ctx));
  while (rendered.length && !rendered[0]) rendered.shift();
  while (rendered.length && !rendered.at(-1)) rendered.pop();
  return rendered.join('\\\n');
}

/**
 * One line of inline content. Marks become delimiters around the text; CommonMark only treats a
 * delimiter run as opening / closing depending on the characters next to it ("flanking"), so:
 * - whitespace at the inside edge of a mark moves outside it;
 * - a letter/digit that would stop a delimiter from opening or closing because the other side
 *   is punctuation is written as a character reference (`&#x61;`);
 * - bold/italic opening right after a closing `*` use `__`/`_`, so the runs don't merge.
 */
function renderLine(nodes: readonly JSONContent[], ctx: Context): string {
  let out = '';
  const stack: OpenMark[] = [];
  // The last thing written was a closing delimiter that only closes if no letter/digit follows.
  let closerNeedsBoundary = false;
  // The last thing written was a closing `*` run.
  let afterStarCloser = false;

  const closeTo = (depth: number) => {
    while (stack.length > depth) {
      const open = stack.pop()!;
      if (open.mark.type === 'link') {
        out += `](${linkDestination(open.mark)})`;
        closerNeedsBoundary = afterStarCloser = false;
        continue;
      }
      const trailing = trailingBlanks(out);
      if (trailing) out = out.slice(0, out.length - trailing.length);
      if (out.length === open.openEnd) {
        out = out.slice(0, open.openStart) + trailing; // nothing inside — drop the mark
        closerNeedsBoundary = afterStarCloser = false;
        continue;
      }
      const { delimiter } = open;
      const before = lastChar(out.slice(0, runStart(out, delimiter[0]!)));
      out += delimiter + trailing;
      // A closer after punctuation needs a non-letter after it; `_` never closes inside a word.
      closerNeedsBoundary = !trailing && (delimiter[0] === '_' || charClass(before) === 'punct');
      afterStarCloser = !trailing && delimiter[0] === '*';
    }
  };

  // runs[i].get(key): how many consecutive nodes from i on carry that mark.
  const nodeMarks = nodes.map(outerMarks);
  const runs: Map<string, number>[] = [];
  for (let i = nodes.length - 1; i >= 0; i--) {
    const run = new Map<string, number>();
    for (const mark of nodeMarks[i]!) {
      const key = markKey(mark);
      run.set(key, 1 + (runs[i + 1]?.get(key) ?? 0));
    }
    runs[i] = run;
  }

  for (const [index, node] of nodes.entries()) {
    const marks = nodeMarks[index]!;
    const keys = new Set(marks.map(markKey));
    let keep = 0;
    while (keep < stack.length && keys.has(stack[keep]!.key)) keep++;
    closeTo(keep);

    const inLink =
      stack.some((open) => open.mark.type === 'link') || marks.some((m) => m.type === 'link');
    let content = renderInlineNode(node, ctx, out === '', inLink);
    if (!content) continue;

    const toOpen = marks
      .filter((mark) => !stack.some((open) => open.key === markKey(mark)))
      .map((mark) => ({ mark, key: markKey(mark), run: runs[index]!.get(markKey(mark)) ?? 0 }))
      .sort(
        (a, b) =>
          b.run - a.run ||
          MARK_ORDER.indexOf(a.mark.type as (typeof MARK_ORDER)[number]) -
            MARK_ORDER.indexOf(b.mark.type as (typeof MARK_ORDER)[number]),
      );
    if (toOpen.some(({ mark }) => mark.type !== 'link')) {
      // Emphasis can't start on whitespace.
      const leading = /^[ \t]+/.exec(content)?.[0] ?? '';
      if (leading) closerNeedsBoundary = afterStarCloser = false;
      out += leading;
      content = content.slice(leading.length);
    }
    if (closerNeedsBoundary && !toOpen.length && charClass(firstChar(content)) === 'other') {
      const first = firstChar(content)!;
      content = characterReference(first) + content.slice(first.length);
    }
    const defaults = toOpen.map(({ mark }) =>
      mark.type === 'link' ? '[' : DELIMITERS[mark.type]!,
    );
    // `!` right before a link would make it an image.
    if (
      (defaults.join('') + content).startsWith('[') &&
      out.endsWith('!') &&
      runStart(out, '!') < out.length
    ) {
      out = `${out.slice(0, -1)}\\!`;
    }
    toOpen.forEach(({ mark, key }, i) => {
      let delimiter = defaults[i]!;
      const next = firstChar(defaults.slice(i + 1).join('') + content);
      if (mark.type in ALT_DELIMITERS) {
        const starOpen = stack.some((open) => open.delimiter[0] === '*');
        if (i === 0 && afterStarCloser) {
          delimiter = ALT_DELIMITERS[mark.type]!; // `*` would merge with the closer before it
        } else if (starOpen && isBothFlanking(lastChar(out), next)) {
          // A `*` that can also close would close the `*` mark that is still open.
          if (charClass(lastChar(out)) === 'punct') delimiter = ALT_DELIMITERS[mark.type]!;
          else out = encodeLastChar(out);
        }
      }
      // An opener followed by punctuation only opens if it isn't preceded by a letter/digit.
      if (
        delimiter !== '[' &&
        charClass(next) === 'punct' &&
        charClass(lastChar(out)) === 'other'
      ) {
        out = encodeLastChar(out);
      }
      const openStart = out.length;
      out += delimiter;
      stack.push({ key, mark, delimiter, openStart, openEnd: out.length });
    });
    out += content;
    closerNeedsBoundary = afterStarCloser = false;
  }
  closeTo(0);
  return out.slice(0, out.length - trailingBlanks(out).length);
}

/** Trailing spaces / tabs (scanned from the end; `/[ \t]+$/` is linear in the whole string). */
function trailingBlanks(text: string): string {
  let start = text.length;
  while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) start--;
  return text.slice(start);
}

/** A delimiter run between these characters could both open and close. */
function isBothFlanking(before: string | undefined, after: string | undefined): boolean {
  const b = charClass(before);
  const a = charClass(after);
  const left = a !== 'space' && (a !== 'punct' || b !== 'other');
  const right = b !== 'space' && (b !== 'punct' || a !== 'other');
  return left && right;
}

/** CommonMark character classes for delimiter flanking (markdown-it: Unicode P and S = punctuation). */
function charClass(char: string | undefined): 'space' | 'punct' | 'other' {
  if (char === undefined || /\s/u.test(char)) return 'space';
  return /[\p{P}\p{S}]/u.test(char) ? 'punct' : 'other';
}

const firstChar = (text: string): string | undefined => Array.from(text.slice(0, 2))[0];
const lastChar = (text: string): string | undefined => Array.from(text.slice(-2)).at(-1);
const characterReference = (char: string) =>
  `&#x${char.codePointAt(0)!.toString(16).toUpperCase()};`;

/**
 * Where the run of `char` delimiters ending `text` starts (`text.length` if none). An escaped
 * `\*` is literal text, not part of the run.
 */
function runStart(text: string, char: string): number {
  let start = text.length;
  while (start > 0 && text[start - 1] === char) start--;
  if (start < text.length) {
    let backslashes = 0;
    while (text[start - 1 - backslashes] === '\\') backslashes++;
    if (backslashes % 2 === 1) start++;
  }
  return start;
}

function encodeLastChar(text: string): string {
  const char = lastChar(text)!;
  return text.slice(0, -char.length) + characterReference(char);
}

function renderInlineNode(
  node: JSONContent,
  ctx: Context,
  lineStart: boolean,
  inLink: boolean,
): string {
  if (node.type === 'mention') {
    const label = String(node.attrs?.label ?? node.attrs?.id ?? '');
    const id: unknown = node.attrs?.id;
    const text = escapeText(`@${label}`, lineStart);
    if (!ctx.mentionIds || inLink || typeof id !== 'string' || !id) return text;
    return `[${text}](${MENTION_SCHEME}${encodeMentionId(id)})`;
  }
  if (node.type !== 'text' || !node.text) return '';
  // No line breaks inside inline text (in a code span a blank line would end the paragraph too).
  const text = toSingleLine(node.text);
  if (node.marks?.some((mark) => mark.type === 'code')) return codeSpan(text);
  return escapeText(text, lineStart);
}

function codeSpan(text: string): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longestRun + 1);
  const pad =
    text.startsWith('`') ||
    text.endsWith('`') ||
    (text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '')
      ? ' '
      : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

function linkDestination(mark: MarkJSON): string {
  const href = String(mark.attrs?.href ?? '');
  const destination =
    /[\s<>()\\]/.test(href) || !href
      ? `<${href.replace(/[<>\\]/g, '\\$&').replace(/[\r\n\u2028\u2029]/g, encodeURIComponent)}>`
      : href;
  const title: unknown = mark.attrs?.title;
  return typeof title === 'string' && title
    ? `${destination} "${toSingleLine(title).replace(/["\\]/g, '\\$&')}"`
    : destination;
}

const isWordChar = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}]/u.test(char);

/**
 * Escape inline text so it parses back as the same text and can't create structure. Line breaks
 * (`\r`, `\n`, U+2028/9) become spaces. Always escaped: `\ ` * [ ] < ~ |` (`|` so lines joined by
 * hard breaks can't form a GFM table); `_` and `=` unless they can't form a delimiter; `&` before an
 * entity. At the start of a line also block syntax (`# > - + =`, `1.`), and leading whitespace is
 * dropped (it would be indented code).
 */
export function escapeText(text: string, lineStart: boolean): string {
  let out = toSingleLine(text).replace(/[\\`*[\]<~|]/g, '\\$&');
  out = out.replace(/&(?=#?[0-9A-Za-z]+;)/g, '\\&');
  out = out.replace(/_/g, (char, offset: number, all: string) =>
    isWordChar(all[offset - 1]) && isWordChar(all[offset + 1]) ? char : '\\_',
  );
  out = out.replace(/=/g, (char, offset: number, all: string) =>
    offset > 0 && offset < all.length - 1 && all[offset - 1] !== '=' && all[offset + 1] !== '='
      ? char
      : '\\=',
  );
  if (lineStart) {
    out = out.replace(/^[ \t]+/, '');
    if (/^[#>+-]/.test(out)) out = `\\${out}`;
    else out = out.replace(/^(\d{1,9})([.)])/, '$1\\$2');
  }
  return out;
}

/** `# Title #` would lose its trailing `#`s as a closing sequence. */
function escapeClosingHashes(text: string): string {
  return text.replace(
    /(^|[ \t])(#+)$/,
    (_match, space: string, hashes: string) => space + hashes.replace(/#/g, '\\#'),
  );
}
