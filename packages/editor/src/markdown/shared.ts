import { isAllowedUri } from '@tiptap/extension-link';

import { isOrigin, type Origin } from '../blocks.ts';
import { CALLOUT_VARIANTS, type CalloutVariant } from '../callout.ts';

/**
 * Block annotations carried through Markdown as HTML comments: `<!-- ai id=3f2a… -->`.
 * `ai`/`me` is the block's origin (D-20), `id=` its block id. Unknown comments are plain text.
 */
export interface BlockMarker {
  origin?: Origin;
  id?: string;
}

/** Ids we can put inside a comment safely (UUIDs and similar). */
const ID_PATTERN = /^[\w.:-]{1,128}$/;
const MARKER_TOKEN = String.raw`(?:ai|me|id=[\w.:-]{1,128})`;
const MARKER_PATTERN = new RegExp(
  String.raw`^<!--[ \t]*(${MARKER_TOKEN}(?:[ \t]+${MARKER_TOKEN})*)[ \t]*-->\s*$`,
);

export function isMarkerSafeId(id: unknown): id is string {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

export function formatMarker(marker: BlockMarker): string {
  const parts: string[] = [];
  if (marker.origin) parts.push(marker.origin);
  if (marker.id) parts.push(`id=${marker.id}`);
  return parts.length ? `<!-- ${parts.join(' ')} -->` : '';
}

/** Parses `<!-- ai id=… -->`; anything else (other comments, HTML) → undefined. */
export function parseMarker(html: string): BlockMarker | undefined {
  const match = MARKER_PATTERN.exec(html);
  if (!match) return undefined;
  const marker: BlockMarker = {};
  for (const part of match[1]!.split(/[ \t]+/)) {
    if (isOrigin(part)) marker.origin = part;
    else marker.id = part.slice('id='.length);
  }
  return marker;
}

/** `[@Name](mention:<id>)` — the lossless mention form (`mentionIds` option). */
export const MENTION_SCHEME = 'mention:';

/** Mention id as a link destination: every character that could end or alter it is %-encoded. */
export const encodeMentionId = (id: string) =>
  encodeURIComponent(id).replace(
    /[!'()*~]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * Line endings CommonMark or a renderer may treat as a break. Inline strings that can't hold a
 * break (text, mention labels, link titles) get a space instead, so user-controlled strings (a
 * display name, a pasted title) can never start a new block — heading, list, table — in the output.
 */
export const LINE_BREAKS = /\r\n?|\n|\u2028|\u2029/g;

export const toSingleLine = (text: string) => text.replace(LINE_BREAKS, ' ');

/**
 * Hrefs we write or read: TipTap's `isAllowedUri` (no `javascript:` etc.) and no protocol-relative
 * `//host` or `\\host`, which would leave the app's origin.
 */
export function isSafeHref(href: unknown): href is string {
  return (
    typeof href === 'string' && href !== '' && !!isAllowedUri(href) && !/^\s*[\\/]{2}/.test(href)
  );
}

/**
 * Admonition types → callout variants. Ours serialise as themselves (`> [!warning] ⚠️`); GitHub
 * alert and common Obsidian callout types are accepted on input. Unknown types → `neutral`.
 */
const ADMONITION_ALIASES: Readonly<Record<string, CalloutVariant>> = {
  note: 'neutral',
  example: 'neutral',
  quote: 'neutral',
  cite: 'neutral',
  abstract: 'info',
  summary: 'info',
  tldr: 'info',
  important: 'info',
  question: 'info',
  todo: 'info',
  tip: 'success',
  hint: 'success',
  check: 'success',
  done: 'success',
  attention: 'warning',
  caution: 'danger',
  error: 'danger',
  failure: 'danger',
  bug: 'danger',
};

export function admonitionToVariant(type: string): CalloutVariant {
  const key = type.toLowerCase();
  return (CALLOUT_VARIANTS as readonly string[]).includes(key)
    ? (key as CalloutVariant)
    : (ADMONITION_ALIASES[key] ?? 'neutral');
}
