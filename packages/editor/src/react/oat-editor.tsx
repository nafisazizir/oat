'use client';

import type { Editor, JSONContent } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';

import { cn } from '@oat/ui/lib/utils';

import { createExtensions, type MentionItem } from '../extensions.ts';
import { collectBlockIds, ensureBlockIds } from '../schema.ts';
import { SlashCommand } from '../slash-command.ts';
import type { SlashItem } from '../slash-items.ts';
import { BubbleToolbar } from './bubble-toolbar.tsx';
import { MentionMenu, SlashMenu } from './menus.tsx';
import { createSuggestionPopup } from './suggestion-popup.tsx';

export interface OatEditorProps {
  /**
   * Document as TipTap JSON (canonical, D-4). Missing/duplicate block ids are repaired. Changing it
   * from outside replaces the content, except when it equals what the editor last emitted. Don't
   * feed back older snapshots of this editor's own output (e.g. a debounced save re-read).
   */
  value?: JSONContent;
  /**
   * Called with the new JSON after every edit — and once right after mount if block ids had to
   * be assigned or de-duplicated, so the stored doc picks them up. Opening a doc emits nothing else.
   */
  onChange?: (value: JSONContent, editor: Editor) => void;
  /** Default true. Read-only mode hides menus and placeholders. */
  editable?: boolean;
  /** Text shown while the document is empty. `false` for none. */
  placeholder?: string | false;
  /** People for `@` mentions. Called on every query change; may be async. */
  onMentionQuery?: (query: string) => MentionItem[] | Promise<MentionItem[]>;
  /** Block list for the `/` menu (default: all blocks). */
  slashItems?: readonly SlashItem[];
  autoFocus?: boolean;
  /** Receives the TipTap editor once it exists (tests, toolbars, imperative commands). */
  onReady?: (editor: Editor) => void;
  className?: string;
  'aria-label'?: string;
}

type MentionQuery = NonNullable<OatEditorProps['onMentionQuery']>;

/** Latest `onMentionQuery` per editor (the suggestion plugin is created once, the prop changes). */
const mentionSources = new WeakMap<Editor, MentionQuery>();

function buildExtensions(
  placeholder: OatEditorProps['placeholder'],
  slashItems: OatEditorProps['slashItems'],
) {
  return createExtensions({
    placeholder,
    mentionSuggestion: {
      char: '@',
      items: async ({ query, editor }) => (await mentionSources.get(editor)?.(query)) ?? [],
      render: createSuggestionPopup<MentionItem>(MentionMenu),
    },
    extra: [
      SlashCommand.configure({
        ...(slashItems ? { items: slashItems } : {}),
        render: createSuggestionPopup<SlashItem>(SlashMenu),
      }),
    ],
  });
}

function withBlockIds(value: JSONContent | undefined) {
  if (!value) return { source: value, content: undefined, idsChanged: false };
  const content = ensureBlockIds(value);
  const idsChanged = collectBlockIds(content).join() !== collectBlockIds(value).join();
  return { source: value, content, idsChanged };
}

/**
 * Oat's block editor. Uncontrolled internally (TipTap owns the state) but syncs to `value` when it
 * changes to something other than what the editor last emitted.
 */
export function OatEditor({
  value,
  onChange,
  editable = true,
  placeholder,
  onMentionQuery,
  slashItems,
  autoFocus = false,
  onReady,
  className,
  'aria-label': ariaLabel = 'Note',
}: OatEditorProps) {
  // Latest callbacks, read from handlers that are created once.
  const onChangeRef = useRef(onChange);
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onChangeRef.current = onChange;
    onReadyRef.current = onReady;
  });
  const lastEmitted = useRef<JSONContent | undefined>(undefined);

  // Extensions are fixed for the editor's lifetime (TipTap only reads them at creation).
  const [extensions] = useState(() => buildExtensions(placeholder, slashItems));
  // Initial content with every block id present and unique (UniqueID only fills null ids).
  const [initial] = useState(() => withBlockIds(value));

  const emit = (e: Editor) => {
    const json = e.getJSON();
    lastEmitted.current = json;
    onChangeRef.current?.(json, e);
  };

  const editor = useEditor({
    immediatelyRender: false,
    editable,
    autofocus: autoFocus ? 'end' : false,
    content: initial.content,
    extensions,
    editorProps: {
      attributes: {
        class: 'oat-editor',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': ariaLabel,
      },
    },
    // Report repaired ids once, so the stored doc picks them up.
    onCreate: ({ editor: e }) => {
      if (initial.idsChanged) emit(e);
    },
    onUpdate: ({ editor: e, transaction }) => {
      // A step-less root transaction means only plugins changed the doc (e.g. the trailing
      // paragraph TipTap adds on open) — not an edit worth saving.
      if (transaction.steps.length === 0) return;
      emit(e);
    },
  });

  useEffect(() => {
    if (editor) onReadyRef.current?.(editor);
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    if (onMentionQuery) mentionSources.set(editor, onMentionQuery);
    else mentionSources.delete(editor);
  }, [editor, onMentionQuery]);

  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable, false);
  }, [editor, editable]);

  // External value changes (e.g. sync, restore) replace the doc without echoing onChange — unless
  // ids had to be repaired. A copy of what we last emitted (e.g. a parent re-reading its store) is
  // ignored, so it can't overwrite newer typing; anything else is treated as authoritative.
  useEffect(() => {
    if (!editor || value === undefined) return;
    if (value === lastEmitted.current || value === initial.source) return;
    const incoming = JSON.stringify(value);
    if (lastEmitted.current && incoming === JSON.stringify(lastEmitted.current)) return;
    if (incoming === JSON.stringify(editor.getJSON())) return;
    const { content, idsChanged } = withBlockIds(value);
    editor.commands.setContent(content!, { emitUpdate: idsChanged });
  }, [editor, value, initial.source]);

  return (
    <div className={cn('oat-editor-root', className)} data-editable={editable || undefined}>
      <EditorContent editor={editor} />
      {editor && editable ? <BubbleToolbar editor={editor} /> : null}
    </div>
  );
}
