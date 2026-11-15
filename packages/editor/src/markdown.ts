/**
 * `@oat/editor/markdown` — TipTap JSON ↔ Markdown (D-4: JSON is canonical, Markdown is derived).
 * Headless: Node and browser, no DOM. Mapping and lossy cases: docs/tasks/3.2-markdown.md.
 */
export {
  fromMarkdown,
  type FromMarkdownOptions,
  type MentionPolicy,
} from './markdown/from-markdown.ts';
export { escapeText, toMarkdown, type ToMarkdownOptions } from './markdown/to-markdown.ts';
