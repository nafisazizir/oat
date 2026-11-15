import { getSchema, type JSONContent } from '@tiptap/core';
import { isAllowedUri } from '@tiptap/extension-link';
import type { Schema } from '@tiptap/pm/model';

import { generateBlockId, isBlockType, isOrigin } from './blocks.ts';
import { isCalloutVariant, normalizeCalloutEmoji } from './callout.ts';
import { createExtensions } from './extensions.ts';

let cachedSchema: Schema | undefined;

/** The ProseMirror schema for Oat documents (cached; identical to the editor's). */
export function getEditorSchema(): Schema {
  cachedSchema ??= getSchema(createExtensions({ placeholder: false }));
  return cachedSchema;
}

/** A new document: one empty paragraph. */
export function emptyDoc(): JSONContent {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

/**
 * The server's gate for stored documents. Checks the doc against the Oat schema (unknown
 * nodes/marks, invalid nesting) and the attribute contract TipTap itself doesn't enforce, because
 * stored docs are also rendered outside TipTap (Markdown, share view, exports):
 * - link `href` must pass TipTap's `isAllowedUri` (no `javascript:` etc.);
 * - `origin` is `me` | `ai` when present;
 * - callout `variant` is one of `CALLOUT_VARIANTS`, `emoji` is a single short grapheme.
 */
export function validateDoc(json: unknown): ValidationResult {
  try {
    if (typeof json !== 'object' || json === null || (json as JSONContent).type !== 'doc') {
      return { ok: false, error: 'Root node must be { type: "doc" }' };
    }
    getEditorSchema().nodeFromJSON(json).check();
    const error = checkAttributes(json as JSONContent, 'doc');
    return error ? { ok: false, error } : { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function checkAttributes(node: JSONContent, path: string): string | undefined {
  const attrs = node.attrs ?? {};
  if ('origin' in attrs && attrs.origin != null && !isOrigin(attrs.origin)) {
    return `${path}: invalid origin ${JSON.stringify(attrs.origin)}`;
  }
  if (node.type === 'callout') {
    if (attrs.variant != null && !isCalloutVariant(attrs.variant)) {
      return `${path}: invalid callout variant ${JSON.stringify(attrs.variant)}`;
    }
    if (attrs.emoji != null && normalizeCalloutEmoji(attrs.emoji) !== attrs.emoji) {
      return `${path}: callout emoji must be a single emoji`;
    }
  }
  for (const mark of node.marks ?? []) {
    if (mark.type !== 'link') continue;
    const href: unknown = mark.attrs?.href;
    if (typeof href !== 'string' || !href || !isAllowedUri(href)) {
      return `${path}: disallowed link href ${JSON.stringify(href)}`;
    }
  }
  for (const [index, child] of (node.content ?? []).entries()) {
    const error = checkAttributes(child, `${path}.${child.type ?? '?'}[${index}]`);
    if (error) return error;
  }
  return undefined;
}

/**
 * Give every block node a unique `id` — fills missing ids and replaces duplicates (keeps the
 * first occurrence). Pure JSON transform for server-side use (e.g. AI output → TipTap, 4.4); the
 * editor does the same live via the UniqueID extension. Returns a new object.
 */
export function ensureBlockIds(
  doc: JSONContent,
  generateId: () => string = generateBlockId,
): JSONContent {
  const seen = new Set<string>();
  const visit = (node: JSONContent): JSONContent => {
    const next: JSONContent = { ...node };
    if (isBlockType(node.type)) {
      const id = node.attrs?.id;
      const valid = typeof id === 'string' && id.length > 0 && !seen.has(id);
      const finalId = valid ? id : generateId();
      seen.add(finalId);
      next.attrs = { ...node.attrs, id: finalId };
    }
    if (node.content) next.content = node.content.map(visit);
    return next;
  };
  return visit(doc);
}

/** Every block id in document order (for citations / diffing). */
export function collectBlockIds(doc: JSONContent): string[] {
  const ids: string[] = [];
  const visit = (node: JSONContent) => {
    if (isBlockType(node.type) && typeof node.attrs?.id === 'string') ids.push(node.attrs.id);
    node.content?.forEach(visit);
  };
  visit(doc);
  return ids;
}
