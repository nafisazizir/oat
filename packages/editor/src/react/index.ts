/** React layer of @oat/editor. Import `@oat/editor/styles.css` once in the app's Tailwind entry. */
export { BubbleToolbar, normalizeHref } from './bubble-toolbar.tsx';
export { MentionMenu, SlashMenu } from './menus.tsx';
export { OatEditor, type OatEditorProps } from './oat-editor.tsx';
export {
  createSuggestionPopup,
  MenuList,
  type SuggestionMenuHandle,
  type SuggestionMenuProps,
} from './suggestion-popup.tsx';
