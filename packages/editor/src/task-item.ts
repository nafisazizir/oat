import type { CommandProps } from '@tiptap/core';
import type { DOMOutputSpec } from '@tiptap/pm/model';
import { TaskItem } from '@tiptap/extension-list';

import {
  formatTaskMeta,
  isIsoDate,
  isTaskOwner,
  normalizeTaskOwner,
  taskMetaOf,
  type TaskOwner,
} from './task-meta.ts';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    oatTaskItem: {
      /** Set (or clear with `null`) the owner of the task item at `pos` (default: the selection's). */
      setTaskOwner: (owner: TaskOwner | null, pos?: number) => ReturnType;
      /** Set (or clear with `null`) the due date (`YYYY-MM-DD`) of the task item at `pos`. */
      setTaskDue: (due: string | null, pos?: number) => ReturnType;
    };
  }
}

/**
 * TipTap's task item plus the 8.4 action-item attributes `owner` and `due` (see `task-meta.ts`). Both default
 * to `null` and don't carry over when Enter splits the item. HTML: `data-owner` (JSON) / `data-due` on the
 * `<li>` for copy-paste, plus a read-only `<span data-task-meta>` with the visible `@Name, due …` text for
 * static renderings (share view); the parser ignores that span, so pasting never turns it into note text.
 */
export const OatTaskItem = TaskItem.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      owner: {
        default: null,
        keepOnSplit: false,
        parseHTML: (element) => {
          const raw = element.getAttribute('data-owner');
          if (!raw) return null;
          try {
            return normalizeTaskOwner(JSON.parse(raw));
          } catch {
            return null;
          }
        },
        renderHTML: (attributes) =>
          isTaskOwner(attributes.owner) ? { 'data-owner': JSON.stringify(attributes.owner) } : {},
      },
      due: {
        default: null,
        keepOnSplit: false,
        parseHTML: (element) => {
          const value = element.getAttribute('data-due');
          return isIsoDate(value) ? value : null;
        },
        renderHTML: (attributes) =>
          isIsoDate(attributes.due) ? { 'data-due': attributes.due } : {},
      },
    };
  },

  parseHTML() {
    return [...(this.parent?.() ?? []), { tag: 'span[data-task-meta]', ignore: true }];
  },

  renderHTML(props) {
    const spec = this.parent!(props) as unknown as DOMOutputSpec[];
    const text = formatTaskMeta(taskMetaOf(props.node.attrs));
    if (!text) return spec as unknown as DOMOutputSpec;
    return [
      ...spec,
      ['span', { 'data-task-meta': '', contenteditable: 'false' }, text],
    ] as unknown as DOMOutputSpec;
  },

  addCommands() {
    const update =
      (attrs: Record<string, unknown>, pos?: number) =>
      ({ tr, state, dispatch }: CommandProps) => {
        let target = pos;
        if (target === undefined) {
          const { $from } = state.selection;
          for (let depth = $from.depth; depth > 0; depth--) {
            if ($from.node(depth).type.name === this.name) {
              target = $from.before(depth);
              break;
            }
          }
        }
        if (target === undefined) return false;
        const node = tr.doc.nodeAt(target);
        if (node?.type.name !== this.name) return false;
        if (dispatch) tr.setNodeMarkup(target, undefined, { ...node.attrs, ...attrs });
        return true;
      };
    return {
      ...this.parent?.(),
      setTaskOwner: (owner, pos) => update({ owner: normalizeTaskOwner(owner) }, pos),
      setTaskDue: (due, pos) => update({ due: isIsoDate(due) ? due : null }, pos),
    };
  },
});
