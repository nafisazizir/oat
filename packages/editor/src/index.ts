/**
 * @oat/editor — the Oat document model (TipTap JSON is canonical, D-4) and block editor.
 *
 * - Headless (Node-safe): `createExtensions`, `getEditorSchema`, `validateDoc`, `ensureBlockIds`
 *   from here. Server code builds/validates documents with exactly the editor's schema.
 * - React: `OatEditor` from `@oat/editor/react`. Styles: import `@oat/editor/styles.css` after
 *   `@oat/ui/styles.css` in the app's Tailwind entry.
 */
export const packageName = '@oat/editor';

export type { JSONContent } from '@tiptap/core';
export {
  BLOCK_TYPES,
  generateBlockId,
  isBlockType,
  isOrigin,
  ORIGINS,
  type BlockType,
  type Origin,
} from './blocks.ts';
export {
  Callout,
  CALLOUT_VARIANTS,
  DEFAULT_CALLOUT,
  isCalloutVariant,
  MAX_EMOJI_LENGTH,
  normalizeCalloutEmoji,
  type CalloutAttributes,
  type CalloutVariant,
} from './callout.ts';
export {
  blockPlaceholder,
  createExtensions,
  DEFAULT_PLACEHOLDER,
  type CreateExtensionsOptions,
  type MentionItem,
} from './extensions.ts';
export { KEEP_ORIGIN_META, OriginAttribute } from './origin.ts';
export {
  collectBlockIds,
  emptyDoc,
  ensureBlockIds,
  getEditorSchema,
  validateDoc,
  type ValidationResult,
} from './schema.ts';
export { SlashCommand, slashCommandPluginKey, type SlashCommandOptions } from './slash-command.ts';
export { filterSlashItems, SLASH_ITEMS, type SlashIcon, type SlashItem } from './slash-items.ts';
