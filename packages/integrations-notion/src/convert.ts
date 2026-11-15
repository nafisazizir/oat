/**
 * TipTap JSON (canonical, D-4) → Notion blocks. Pure; Node and browser safe.
 *
 * Mapping:
 *   paragraph → paragraph · heading 1–3 → heading_1–3 · bulletList/orderedList items → bulleted/numbered_list_item
 *   · taskItem → to_do (checked; an owner/due (8.4) is appended as plain text: `Send deck (@Dana, due 2026-11-20)`)
 *   · blockquote → quote · callout → callout (emoji icon, variant → background
 *   colour) · codeBlock → code (language mapped to Notion's list, else "plain text") · horizontalRule → divider.
 *   A container (list item, quote, callout) takes its first paragraph/heading as its own text and the rest as
 *   children. Marks: bold, italic, strike → strikethrough, code, highlight → yellow background, link → link
 *   (absolute http(s)/mailto; relative links are resolved against `baseUrl` or dropped). Mentions become plain
 *   `@Name` text, hard breaks `\n`.
 *
 * Notion limits honoured here: text is split into ≤ 2000-character rich-text items (never inside a surrogate
 * pair); a block whose text needs more than 100 items continues in further blocks (paragraphs after a
 * heading/list item; more code blocks for code); nesting is at most two levels below the top (deeper blocks
 * are lifted to the deepest allowed level, in order), and a children array over 100 is split the same way.
 * `batchBlocks` cuts the result into requests of ≤ 100 top-level blocks / ≤ 1000 elements.
 */
import { isCalloutVariant, normalizeCalloutEmoji } from '@oat/editor/callout';
import type { JSONContent } from '@oat/editor';
import { formatTaskMeta, taskMetaOf } from '@oat/editor/task-meta';

import {
  blockData,
  NOTION_LIMITS,
  notionBlock,
  type NotionAnnotations,
  type NotionBlock,
  type NotionBlockType,
  type NotionColor,
  type NotionRichText,
} from './types.ts';

export interface ConvertOptions {
  /** Absolute origin used to resolve relative links (e.g. `/d/<id>` → `https://oat.app/d/<id>`). */
  baseUrl?: string;
}

/** Callout variants → Notion background colours. */
export const CALLOUT_COLORS: Record<string, NotionColor> = {
  neutral: 'gray_background',
  info: 'blue_background',
  success: 'green_background',
  warning: 'yellow_background',
  danger: 'red_background',
};

export const HIGHLIGHT_COLOR: NotionColor = 'yellow_background';

// ---------------------------------------------------------------------------------------------------
// Inline content

type Run = { text: string; annotations: NotionAnnotations; link: string | null };

const sameStyle = (a: Run, b: Run) =>
  a.link === b.link && JSON.stringify(a.annotations) === JSON.stringify(b.annotations);

/** A link Notion accepts: absolute http(s)/mailto URL ≤ 2000 chars. Relative ones resolve against `baseUrl`. */
export function notionLink(href: unknown, baseUrl?: string): string | null {
  if (typeof href !== 'string' || !href.trim()) return null;
  let url: URL;
  try {
    url = baseUrl ? new URL(href, baseUrl) : new URL(href);
  } catch {
    return null;
  }
  if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return null;
  const out = url.toString();
  return out.length <= NOTION_LIMITS.textContent ? out : null;
}

function annotationsFor(marks: JSONContent['marks'], baseUrl?: string): Omit<Run, 'text'> {
  const annotations: NotionAnnotations = {};
  let link: string | null = null;
  for (const mark of marks ?? []) {
    switch (mark.type) {
      case 'bold':
        annotations.bold = true;
        break;
      case 'italic':
        annotations.italic = true;
        break;
      case 'strike':
        annotations.strikethrough = true;
        break;
      case 'code':
        annotations.code = true;
        break;
      case 'highlight':
        annotations.color = HIGHLIGHT_COLOR;
        break;
      case 'link':
        link = notionLink(mark.attrs?.href, baseUrl);
        break;
    }
  }
  // Stable key order so equal styles compare equal.
  const ordered: NotionAnnotations = {};
  for (const key of ['bold', 'italic', 'strikethrough', 'code', 'color'] as const) {
    if (annotations[key] !== undefined) Object.assign(ordered, { [key]: annotations[key] });
  }
  return { annotations: ordered, link };
}

function runsOf(nodes: readonly JSONContent[], options: ConvertOptions): Run[] {
  const runs: Run[] = [];
  const push = (run: Run) => {
    if (!run.text) return;
    const last = runs.at(-1);
    if (last && sameStyle(last, run)) last.text += run.text;
    else runs.push({ ...run, annotations: { ...run.annotations } });
  };
  for (const node of nodes) {
    if (node.type === 'text') {
      push({ text: node.text ?? '', ...annotationsFor(node.marks, options.baseUrl) });
    } else if (node.type === 'hardBreak') {
      // Keep the surrounding style so a break inside bold text doesn't split the run.
      const last = runs.at(-1);
      push({ text: '\n', annotations: last?.annotations ?? {}, link: last?.link ?? null });
    } else if (node.type === 'mention') {
      const label = node.attrs?.label ?? node.attrs?.id ?? '';
      push({ text: `@${String(label)}`, ...annotationsFor(node.marks, options.baseUrl) });
    } else if (node.content) {
      for (const run of runsOf(node.content, options)) push(run);
    } else if (node.text) {
      push({ text: node.text, annotations: {}, link: null });
    }
  }
  return runs;
}

/**
 * Splits `text` into pieces of at most `max` UTF-16 code units (Notion's length), never between the two
 * halves of a surrogate pair.
 */
export function splitText(text: string, max: number = NOTION_LIMITS.textContent): string[] {
  if (text.length <= max) return [text];
  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + max, text.length);
    if (end < text.length) {
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1; // high surrogate: keep the pair together
    }
    pieces.push(text.slice(start, end));
    start = end;
  }
  return pieces;
}

function richTextOf(run: Run): NotionRichText[] {
  return splitText(run.text).map((content) => {
    const item: NotionRichText = { type: 'text', text: { content } };
    if (run.link) item.text.link = { url: run.link };
    if (Object.keys(run.annotations).length > 0) item.annotations = { ...run.annotations };
    return item;
  });
}

/** Inline TipTap nodes → Notion rich text (merged runs, each ≤ 2000 characters). */
export function toRichText(
  nodes: readonly JSONContent[],
  options: ConvertOptions = {},
): NotionRichText[] {
  return runsOf(nodes, options).flatMap(richTextOf);
}

/** Plain text → rich text items (≤ 2000 characters each). */
export function plainRichText(text: string): NotionRichText[] {
  return text ? richTextOf({ text, annotations: {}, link: null }) : [];
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Blocks

/** Notion's code languages. */
export const NOTION_CODE_LANGUAGES: ReadonlySet<string> = new Set([
  'abap', 'agda', 'arduino', 'assembly', 'bash', 'basic', 'bnf', 'c', 'c#', 'c++', 'clojure',
  'coffeescript', 'coq', 'css', 'dart', 'dhall', 'diff', 'docker', 'ebnf', 'elixir', 'elm', 'erlang',
  'f#', 'flow', 'fortran', 'gherkin', 'glsl', 'go', 'graphql', 'groovy', 'haskell', 'hcl', 'html',
  'idris', 'java', 'javascript', 'json', 'julia', 'kotlin', 'latex', 'less', 'lisp', 'livescript',
  'llvm ir', 'lua', 'makefile', 'markdown', 'markup', 'matlab', 'mathematica', 'mermaid', 'nix',
  'notion formula', 'objective-c', 'ocaml', 'pascal', 'perl', 'php', 'plain text', 'powershell',
  'prolog', 'protobuf', 'purescript', 'python', 'r', 'racket', 'reason', 'ruby', 'rust', 'sass',
  'scala', 'scheme', 'scss', 'shell', 'smalltalk', 'solidity', 'sql', 'swift', 'toml', 'typescript',
  'vb.net', 'verilog', 'vhdl', 'visual basic', 'webassembly', 'xml', 'yaml', 'java/c/c++/c#',
]); // prettier-ignore

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', python3: 'python', rb: 'ruby', rs: 'rust', golang: 'go', kt: 'kotlin', kts: 'kotlin',
  sh: 'shell', zsh: 'shell', console: 'shell', shellsession: 'shell', ps1: 'powershell', pwsh: 'powershell',
  yml: 'yaml', md: 'markdown', mdx: 'markdown', htm: 'html', svg: 'xml', xhtml: 'html',
  cpp: 'c++', cxx: 'c++', cc: 'c++', hpp: 'c++', h: 'c', cs: 'c#', csharp: 'c#', fs: 'f#', fsharp: 'f#',
  objc: 'objective-c', 'obj-c': 'objective-c', objectivec: 'objective-c', dockerfile: 'docker',
  proto: 'protobuf', tf: 'hcl', terraform: 'hcl', text: 'plain text', txt: 'plain text',
  plaintext: 'plain text', plain: 'plain text', vb: 'visual basic', vbnet: 'vb.net',
  ex: 'elixir', exs: 'elixir', erl: 'erlang', hs: 'haskell', ml: 'ocaml', pl: 'perl', jl: 'julia',
  tex: 'latex', wasm: 'webassembly', wat: 'webassembly', gql: 'graphql', make: 'makefile',
  mk: 'makefile', clj: 'clojure', coffee: 'coffeescript', sol: 'solidity', psql: 'sql',
  postgres: 'sql', postgresql: 'sql', mysql: 'sql', sqlite: 'sql', jsonc: 'json', json5: 'json',
  patch: 'diff',
}; // prettier-ignore

/** A TipTap code-block language → one of Notion's (default "plain text"). */
export function notionLanguage(language: unknown): string {
  if (typeof language !== 'string') return 'plain text';
  const key = language.trim().toLowerCase();
  if (NOTION_CODE_LANGUAGES.has(key)) return key;
  return LANGUAGE_ALIASES[key] ?? 'plain text';
}

const MAX_LEVEL = NOTION_LIMITS.nesting;

interface Ctx {
  options: ConvertOptions;
}

/** Text-bearing children of a container: its first paragraph/heading is the container's own text. */
function splitLead(children: readonly JSONContent[]): { lead: JSONContent[]; rest: JSONContent[] } {
  const first = children[0];
  if (first && (first.type === 'paragraph' || first.type === 'heading')) {
    return { lead: first.content ?? [], rest: children.slice(1) };
  }
  return { lead: [], rest: [...children] };
}

/**
 * A block with rich text, children (converted at `level + 1`) and Notion's limits applied: text overflowing
 * 100 items continues in paragraphs right after it; children beyond the nesting limit or the 100-per-array
 * limit are lifted to follow it at `level`.
 */
function textBlock(
  type: NotionBlockType,
  richText: NotionRichText[],
  childNodes: readonly JSONContent[],
  level: number,
  ctx: Ctx,
  extra: Omit<NonNullable<NotionBlock['paragraph']>, 'rich_text' | 'children'> = {},
): NotionBlock[] {
  const [first = [], ...overflow] = chunk(richText, NOTION_LIMITS.richTextItems);
  const block = notionBlock(type, { rich_text: first, ...extra });
  const continuation = overflow.map((items) => notionBlock('paragraph', { rich_text: items }));
  if (childNodes.length === 0) return [block, ...continuation];
  const canNest =
    level < MAX_LEVEL && type !== 'heading_1' && type !== 'heading_2' && type !== 'heading_3';
  if (!canNest) return [block, ...continuation, ...convertBlocks(childNodes, level, ctx)];
  const children = convertBlocks(childNodes, level + 1, ctx);
  const kept = children.slice(0, NOTION_LIMITS.children);
  const lifted = children.slice(NOTION_LIMITS.children);
  if (kept.length > 0) blockData(block).children = kept;
  // Text overflow belongs to the block's own text, so it goes before lifted children.
  return [block, ...continuation, ...lifted];
}

function listItems(list: JSONContent, level: number, ctx: Ctx): NotionBlock[] {
  return (list.content ?? []).flatMap((item) => {
    const { lead, rest } = splitLead(item.content ?? []);
    const text = toRichText(lead, ctx.options);
    if (list.type === 'taskList' || item.type === 'taskItem') {
      const meta = formatTaskMeta(taskMetaOf(item.attrs));
      const withMeta = meta
        ? [...text, ...plainRichText(`${text.length ? ' ' : ''}(${meta})`)]
        : text;
      return textBlock('to_do', withMeta, rest, level, ctx, {
        checked: item.attrs?.checked === true,
      });
    }
    const type = list.type === 'orderedList' ? 'numbered_list_item' : 'bulleted_list_item';
    return textBlock(type, text, rest, level, ctx);
  });
}

function codeBlocks(node: JSONContent): NotionBlock[] {
  const text = (node.content ?? []).map((child) => child.text ?? '').join('');
  const language = notionLanguage(node.attrs?.language);
  const pieces = chunk(plainRichText(text), NOTION_LIMITS.richTextItems);
  if (pieces.length === 0) pieces.push([]);
  return pieces.map((rich_text) => notionBlock('code', { rich_text, language }));
}

function convertBlock(node: JSONContent, level: number, ctx: Ctx): NotionBlock[] {
  const children = node.content ?? [];
  switch (node.type) {
    case 'paragraph':
      return textBlock('paragraph', toRichText(children, ctx.options), [], level, ctx);
    case 'heading': {
      const n = Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 3);
      return textBlock(
        `heading_${n}` as NotionBlockType,
        toRichText(children, ctx.options),
        [],
        level,
        ctx,
      );
    }
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return listItems(node, level, ctx);
    case 'listItem':
    case 'taskItem':
      // Outside a list (not valid in a stored doc): treat as a one-item list.
      return listItems(
        { type: node.type === 'taskItem' ? 'taskList' : 'bulletList', content: [node] },
        level,
        ctx,
      );
    case 'blockquote': {
      const { lead, rest } = splitLead(children);
      return textBlock('quote', toRichText(lead, ctx.options), rest, level, ctx);
    }
    case 'callout': {
      const { lead, rest } = splitLead(children);
      const variant = isCalloutVariant(node.attrs?.variant) ? node.attrs.variant : 'neutral';
      return textBlock('callout', toRichText(lead, ctx.options), rest, level, ctx, {
        icon: { type: 'emoji', emoji: normalizeCalloutEmoji(node.attrs?.emoji) },
        color: CALLOUT_COLORS[variant] ?? 'gray_background',
      });
    }
    case 'codeBlock':
      return codeBlocks(node);
    case 'horizontalRule':
      return [notionBlock('divider', {})];
    default: {
      // Unknown block: keep its text rather than losing it.
      const inline = children.some(
        (c) => c.type === 'text' || c.type === 'hardBreak' || c.type === 'mention',
      );
      if (inline) return textBlock('paragraph', toRichText(children, ctx.options), [], level, ctx);
      return convertBlocks(children, level, ctx);
    }
  }
}

function convertBlocks(nodes: readonly JSONContent[], level: number, ctx: Ctx): NotionBlock[] {
  return nodes.flatMap((node) => convertBlock(node, level, ctx));
}

const isEmptyParagraph = (block: NotionBlock) =>
  block.type === 'paragraph' &&
  !blockData(block).rich_text?.length &&
  !blockData(block).children?.length;

/** A TipTap document (or a single block) → Notion blocks, trailing empty paragraphs dropped. */
export function toNotionBlocks(doc: JSONContent, options: ConvertOptions = {}): NotionBlock[] {
  const nodes = doc.type === 'doc' ? (doc.content ?? []) : [doc];
  const blocks = convertBlocks(nodes, 0, { options });
  while (blocks.length > 0 && isEmptyParagraph(blocks.at(-1)!)) blocks.pop();
  return blocks;
}

// ---------------------------------------------------------------------------------------------------
// Batching

/** Number of block elements in a block, its nested children included. */
export function countBlocks(block: NotionBlock): number {
  return 1 + (blockData(block).children ?? []).reduce((n, child) => n + countBlocks(child), 0);
}

/**
 * Cuts top-level blocks into requests Notion accepts: ≤ 100 blocks, ≤ 1000 elements (nested included) and a
 * bounded JSON size per request. Order is preserved.
 */
export function batchBlocks(blocks: readonly NotionBlock[]): NotionBlock[][] {
  const batches: NotionBlock[][] = [];
  let current: NotionBlock[] = [];
  let elements = 0;
  let chars = 0;
  for (const block of blocks) {
    const n = countBlocks(block);
    const size = JSON.stringify(block).length;
    if (
      current.length > 0 &&
      (current.length >= NOTION_LIMITS.children ||
        elements + n > NOTION_LIMITS.blocksPerRequest ||
        chars + size > NOTION_LIMITS.payloadChars)
    ) {
      batches.push(current);
      current = [];
      elements = 0;
      chars = 0;
    }
    current.push(block);
    elements += n;
    chars += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
