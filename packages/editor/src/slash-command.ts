import { Extension } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { Suggestion, type SuggestionOptions } from '@tiptap/suggestion';

import { filterSlashItems, SLASH_ITEMS, type SlashItem } from './slash-items.ts';

export const slashCommandPluginKey = new PluginKey('slashCommand');

export interface SlashCommandOptions {
  items: readonly SlashItem[];
  /** Renders the menu (the React layer passes its popup renderer). */
  render?: SuggestionOptions<SlashItem, SlashItem>['render'];
}

/**
 * `/` opens a filterable block menu. Only triggers at the start of a word, and not inside code
 * blocks. Selecting an item deletes the `/query` text and runs the item's command.
 */
export const SlashCommand = Extension.create<SlashCommandOptions>({
  name: 'slashCommand',

  addOptions() {
    return { items: SLASH_ITEMS, render: undefined };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        pluginKey: slashCommandPluginKey,
        char: '/',
        allowedPrefixes: [' ', ' '],
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          return !$from.parent.type.spec.code;
        },
        items: ({ query }) => filterSlashItems(query, this.options.items),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: this.options.render,
      }),
    ];
  },
});
