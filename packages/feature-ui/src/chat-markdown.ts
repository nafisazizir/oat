/**
 * Assistant answers → a small, safe render tree (6.4). The model writes Markdown with citation markers
 * (`[[seg:<id>]]`, `[[block:<id>]]`, D-27). We parse it with markdown-it (raw HTML off, so `<script>` stays
 * text) and keep only an allowlist of elements; links must be http(s), mailto or app-relative. Markers become
 * `cite` nodes the UI renders as numbered chips. Nothing here produces HTML strings: the tree is rendered as
 * React elements, so there is no `dangerouslySetInnerHTML` anywhere in the chat.
 */
import MarkdownIt, { type Token } from 'markdown-it';

export type CitationKind = 'seg' | 'block';

export type MdTag =
  | 'p'
  | 'h3'
  | 'h4'
  | 'ul'
  | 'ol'
  | 'li'
  | 'blockquote'
  | 'strong'
  | 'em'
  | 's'
  | 'code'
  | 'pre'
  | 'a'
  | 'br'
  | 'hr'
  | 'table'
  | 'thead'
  | 'tbody'
  | 'tr'
  | 'th'
  | 'td';

export type MdNode =
  | { type: 'text'; text: string }
  | { type: 'cite'; kind: CitationKind; id: string }
  | { type: 'element'; tag: MdTag; href?: string; children: MdNode[] };

/** `[[seg:<id>]]` / `[[block:<id>]]` (ids as the server's citation filter normalises them). */
export const CITATION = /\[\[(seg|block):([^\]\s]{1,200})\]\]/g;

// Private-use sentinels: markers survive Markdown parsing as plain text and can't be typed by accident.
const OPEN = '';
const CLOSE = '';
const SENTINEL = /(seg|block):([^]+)/g;

const md = new MarkdownIt('default', { html: false, linkify: false, typographer: false });

const TAGS: Record<string, MdTag> = {
  paragraph: 'p',
  bullet_list: 'ul',
  ordered_list: 'ol',
  list_item: 'li',
  blockquote: 'blockquote',
  strong: 'strong',
  em: 'em',
  s: 's',
  link: 'a',
  table: 'table',
  thead: 'thead',
  tbody: 'tbody',
  tr: 'tr',
  th: 'th',
  td: 'td',
};

/** Links the chat may render: web, mail and in-app paths. Everything else becomes plain text. */
export function safeHref(href: string | null | undefined): string | undefined {
  if (!href) return undefined;
  const value = href.trim();
  if (/^\/(?!\/)/.test(value)) return value;
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

const restoreMarkers = (text: string) =>
  text.replace(SENTINEL, (_, kind: string, id: string) => `[[${kind}:${id}]]`);

function pushText(out: MdNode[], text: string) {
  let last = 0;
  for (const match of text.matchAll(SENTINEL)) {
    if (match.index > last) out.push({ type: 'text', text: text.slice(last, match.index) });
    out.push({ type: 'cite', kind: match[1] as CitationKind, id: match[2]! });
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
}

function build(tokens: readonly Token[]): MdNode[] {
  const root: MdNode[] = [];
  // Each frame collects children; `null` element = a transparent wrapper (hidden tight-list paragraphs,
  // links with unsafe hrefs) whose children go to the parent.
  const stack: { children: MdNode[] }[] = [{ children: root }];
  const top = () => stack.at(-1)!.children;

  for (const token of tokens) {
    if (token.nesting === 1) {
      const name = token.type.replace(/_open$/, '');
      let tag: MdTag | undefined =
        name === 'heading' ? (token.tag === 'h1' || token.tag === 'h2' ? 'h3' : 'h4') : TAGS[name];
      const href = name === 'link' ? safeHref(String(token.attrGet('href') ?? '')) : undefined;
      if (token.hidden || (name === 'link' && !href)) tag = undefined;
      if (tag) {
        const element: MdNode = { type: 'element', tag, children: [], ...(href ? { href } : {}) };
        top().push(element);
        stack.push(element);
      } else {
        stack.push({ children: top() });
      }
      continue;
    }
    if (token.nesting === -1) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    switch (token.type) {
      case 'inline':
        top().push(...build(token.children ?? []));
        break;
      case 'text':
        pushText(top(), token.content);
        break;
      case 'code_inline':
        top().push({
          type: 'element',
          tag: 'code',
          children: [{ type: 'text', text: restoreMarkers(token.content) }],
        });
        break;
      case 'fence':
      case 'code_block':
        top().push({
          type: 'element',
          tag: 'pre',
          children: [
            {
              type: 'element',
              tag: 'code',
              children: [{ type: 'text', text: restoreMarkers(token.content.replace(/\n$/, '')) }],
            },
          ],
        });
        break;
      case 'softbreak':
        top().push({ type: 'text', text: '\n' });
        break;
      case 'hardbreak':
        top().push({ type: 'element', tag: 'br', children: [] });
        break;
      case 'hr':
        top().push({ type: 'element', tag: 'hr', children: [] });
        break;
      case 'image':
        // No remote images in answers: show the alt text.
        pushText(top(), token.content);
        break;
      default:
        // html_block / html_inline can't occur (html: false); anything else is dropped.
        break;
    }
  }
  return root;
}

/** Parses an answer (Markdown + citation markers) into the render tree. */
export function parseAnswer(text: string): MdNode[] {
  const marked = text
    .replace(/[]/g, '')
    .replace(CITATION, (_, kind: string, id: string) => `${OPEN}${kind}:${id}${CLOSE}`);
  return build(md.parse(marked, {}));
}

/**
 * Citations of an answer in order of first appearance, as rendered (markers inside code are text, not
 * citations). Chip numbers follow this order across the whole answer.
 */
export function citationOrder(text: string): string[] {
  const seen: string[] = [];
  const walk = (nodes: MdNode[]) => {
    for (const node of nodes) {
      if (node.type === 'cite') {
        const key = `${node.kind}:${node.id}`;
        if (!seen.includes(key)) seen.push(key);
      } else if (node.type === 'element') {
        walk(node.children);
      }
    }
  };
  walk(parseAnswer(text));
  return seen;
}
