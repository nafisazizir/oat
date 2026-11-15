import type { AnyExtension, Editor, Extensions } from '@tiptap/core';
import { Highlight } from '@tiptap/extension-highlight';
import { TaskList } from '@tiptap/extension-list';
import { Mention, type MentionOptions } from '@tiptap/extension-mention';
import { UniqueID } from '@tiptap/extension-unique-id';
import { Placeholder } from '@tiptap/extensions';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { StarterKit } from '@tiptap/starter-kit';

import { BLOCK_TYPES, generateBlockId } from './blocks.ts';
import { Callout } from './callout.ts';
import { OriginAttribute } from './origin.ts';
import { OatTaskItem } from './task-item.ts';

export interface MentionItem {
  /** Stable id of the person (user id, attendee email…). Stored on the mention node. */
  id: string;
  /** Display name, stored on the node so the doc renders without a lookup. */
  label: string;
  /** Secondary line in the suggestion list (e.g. email). */
  description?: string;
}

export interface CreateExtensionsOptions {
  /**
   * Placeholder shown in an empty editor (`string`), or `false` for none. Empty headings and
   * other blocks get their own hint (see `blockPlaceholder`). Default: "Write, or type '/' for commands…".
   */
  placeholder?: string | false;
  /** Mention `@` suggestion (items + render). Omit for headless/server use — the node still parses. */
  mentionSuggestion?: MentionOptions['suggestion'];
  /** Extra extensions appended after the core set (UI-only plugins such as the slash menu). */
  extra?: Extensions;
  /** Block id generator. Default: `generateBlockId()` (UUID v4). */
  generateId?: () => string;
  /**
   * The task item node: `OatTaskItem` (default) or an extension of it that only changes rendering (the React
   * editor's node view with owner/due chips). Must keep the same name, attributes and parse rules.
   */
  taskItem?: typeof OatTaskItem;
}

export const DEFAULT_PLACEHOLDER = "Write, or type '/' for commands…";

/** Hint for an empty block that isn't the only block in the doc. */
export function blockPlaceholder(node: ProseMirrorNode): string {
  if (node.type.name === 'heading') return `Heading ${String(node.attrs.level ?? 1)}`;
  if (node.type.name === 'codeBlock') return 'Code';
  if (node.type.name === 'paragraph') return "Type '/' for commands";
  return '';
}

function isDocEmpty(editor: Editor): boolean {
  const { doc } = editor.state;
  return (
    doc.childCount === 1 && doc.firstChild?.type.name === 'paragraph' && doc.textContent === ''
  );
}

/**
 * The Oat document schema as a TipTap extension list. Safe to call in Node (no DOM/React), so the
 * server and the desktop main process use exactly the same schema as the editor:
 *
 *   getSchema(createExtensions())                         // ProseMirror schema
 *   generateHTML(json, createExtensions())                // @tiptap/html/server — the server
 *                                                         // package adds @tiptap/html + happy-dom
 */
export function createExtensions(options: CreateExtensionsOptions = {}): AnyExtension[] {
  const {
    placeholder = DEFAULT_PLACEHOLDER,
    mentionSuggestion,
    extra = [],
    generateId,
    taskItem = OatTaskItem,
  } = options;

  const extensions: AnyExtension[] = [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      // Not part of the Oat schema (no Markdown equivalent for 3.2).
      underline: false,
      link: {
        autolink: true,
        linkOnPaste: true,
        openOnClick: false,
        defaultProtocol: 'https',
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
      },
    }),
    TaskList,
    taskItem.configure({ nested: true }),
    Highlight,
    Callout,
    Mention.configure({
      HTMLAttributes: { class: 'oat-mention' },
      deleteTriggerWithBackspace: true,
      ...(mentionSuggestion ? { suggestion: mentionSuggestion } : {}),
    }),
    UniqueID.configure({
      types: [...BLOCK_TYPES],
      attributeName: 'id',
      generateID: generateId ?? generateBlockId,
    }),
    OriginAttribute,
  ];

  if (placeholder !== false) {
    extensions.push(
      Placeholder.configure({
        includeChildren: true,
        showOnlyCurrent: true,
        placeholder: ({ editor, node }) =>
          isDocEmpty(editor) ? placeholder : blockPlaceholder(node),
      }),
    );
  }

  return [...extensions, ...extra];
}
