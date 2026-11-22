/** React layer of @oat/editor. Import `@oat/editor/styles.css` once in the app's Tailwind entry. */
export { BlockFocus } from './block-focus.tsx';
export { BubbleToolbar, normalizeHref } from './bubble-toolbar.tsx';
export { MentionMenu, SlashMenu } from './menus.tsx';
export { OatEditor, type OatEditorProps } from './oat-editor.tsx';
export {
  createSuggestionPopup,
  MenuList,
  type SuggestionMenuHandle,
  type SuggestionMenuProps,
} from './suggestion-popup.tsx';
export { ReactTaskItem, type TaskAssigneeQuery } from './task-item-view.tsx';
