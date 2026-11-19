type Keys = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'repeat'>;

/** ⌘N / Ctrl+N, held keys and other modifiers excluded. */
export function isNewNoteShortcut(event: Keys): boolean {
  if (event.key.toLowerCase() !== 'n' || !(event.metaKey || event.ctrlKey)) return false;
  return !event.shiftKey && !event.altKey && !event.repeat;
}

/**
 * Open modal popups, menus and listboxes handle Esc themselves. Base UI marks an open popup with
 * `data-open`; the in-page meeting banners also use `role="alertdialog"` but are not modal.
 */
export const ESC_OWNER_SELECTOR =
  '[role="dialog"][data-open], [role="alertdialog"][data-open], [role="menu"], [role="listbox"]';

/** Whether Esc should close the current view, rather than an open popup over it. */
export function escapeClosesView(
  event: Pick<KeyboardEvent, 'key' | 'defaultPrevented'>,
  root: Pick<ParentNode, 'querySelector'>,
): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented) return false;
  return root.querySelector(ESC_OWNER_SELECTOR) === null;
}
