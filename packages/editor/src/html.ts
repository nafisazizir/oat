/**
 * `@oat/editor/html` — stored TipTap JSON → safe, static HTML for read-only views rendered on the server
 * (the public share page, 5.3; exports later). Node-safe: no DOM, no React.
 *
 * Three layers, each enough on its own for the common case, together defence in depth:
 * 1. `validateDoc`: the document must fit the editor schema and attribute contract (no unknown nodes or
 *    marks, link hrefs pass `isAllowedUri`), so only known node types ever reach the renderer.
 * 2. `@tiptap/static-renderer` renders it with the editor's own extensions (`renderHTML` of every node and
 *    mark), escaping all text and attribute values.
 * 3. `sanitize-html` with an explicit allowlist ({@link SANITIZE_OPTIONS}): only the tags/attributes the
 *    Oat schema produces survive; links are http(s)/mailto/tel only and always open with
 *    `rel="noopener noreferrer nofollow"`; task checkboxes are `disabled`. Identifiers that could leak
 *    data to a public reader are dropped: block ids and mention ids (user ids / attendee emails) — a
 *    mention keeps only its visible `@Name` text; a task's owner (8.4) only its `@Name, due …` text (the
 *    `data-owner` JSON with email/user id is not allowed).
 *
 * Wrap the output in an element with class `oat-editor` to get the editor's prose styles
 * (`@oat/editor/styles.css`).
 */
import type { JSONContent } from '@tiptap/core';
import { renderToHTMLString } from '@tiptap/static-renderer/pm/html-string';
import sanitizeHtml from 'sanitize-html';

import { createExtensions } from './extensions.ts';
import { validateDoc } from './schema.ts';

export class InvalidDocumentError extends Error {
  override readonly name = 'InvalidDocumentError';
}

/** Allowlist for {@link sanitizeDocumentHtml}: exactly what the Oat schema renders, minus identifiers. */
export const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p',
    'h1',
    'h2',
    'h3',
    'br',
    'strong',
    'em',
    's',
    'code',
    'pre',
    'mark',
    'a',
    'ul',
    'ol',
    'li',
    'blockquote',
    'hr',
    'label',
    'input',
    'span',
    'div',
  ],
  allowedAttributes: {
    '*': ['data-origin'],
    a: ['href', 'target', 'rel'],
    ol: ['start'],
    ul: ['data-type'],
    li: ['data-type', 'data-checked'],
    input: ['type', 'checked', 'disabled'],
    div: ['data-type', 'data-variant', 'data-emoji', 'data-callout-content'],
    span: ['class', 'data-type', 'data-callout-emoji', 'data-task-meta', 'aria-hidden'],
    code: ['class'],
  },
  allowedClasses: {
    span: ['oat-mention'],
    code: ['language-*'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesAppliedToAttributes: ['href'],
  allowProtocolRelative: false,
  // Unknown tags are dropped but their text is kept (escaped); script/style contents are dropped entirely.
  disallowedTagsMode: 'discard',
  nonTextTags: [
    'script',
    'style',
    'textarea',
    'option',
    'noscript',
    'iframe',
    'object',
    'template',
  ],
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: {
        ...(attribs.href ? { href: attribs.href } : {}),
        target: '_blank',
        rel: 'noopener noreferrer nofollow',
      },
    }),
    // Read-only: a task checkbox shows its state but can't be toggled. Any other input becomes a span.
    input: (_tagName, attribs) =>
      attribs.type === 'checkbox'
        ? {
            tagName: 'input',
            attribs: {
              type: 'checkbox',
              disabled: 'disabled',
              ...('checked' in attribs ? { checked: 'checked' } : {}),
            },
          }
        : { tagName: 'span', attribs: {} },
  },
};

/** The allowlist sanitiser on its own (for HTML that didn't come from {@link renderDocumentHtml}). */
export function sanitizeDocumentHtml(html: string): string {
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}

let cachedExtensions: ReturnType<typeof createExtensions> | undefined;

/**
 * Renders a stored document to sanitised HTML. Throws {@link InvalidDocumentError} when the JSON doesn't
 * pass {@link validateDoc} (stored documents always do: every write is validated).
 */
export function renderDocumentHtml(json: unknown): string {
  const checked = validateDoc(json);
  if (!checked.ok) throw new InvalidDocumentError(checked.error);
  cachedExtensions ??= createExtensions({ placeholder: false });
  const html = renderToHTMLString({ extensions: cachedExtensions, content: json as JSONContent });
  return sanitizeDocumentHtml(html);
}
