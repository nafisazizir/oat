'use client';

import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import {
  BoldIcon,
  CheckIcon,
  CodeIcon,
  HighlighterIcon,
  ItalicIcon,
  LinkIcon,
  type LucideIcon,
  StrikethroughIcon,
  UnlinkIcon,
} from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';

import { Button } from '@oat/ui/components/button';
import { Input } from '@oat/ui/components/input';
import { Separator } from '@oat/ui/components/separator';

type MarkName = 'bold' | 'italic' | 'strike' | 'code' | 'highlight';

const MARKS: { name: MarkName; label: string; shortcut: string; icon: LucideIcon }[] = [
  { name: 'bold', label: 'Bold', shortcut: '⌘B', icon: BoldIcon },
  { name: 'italic', label: 'Italic', shortcut: '⌘I', icon: ItalicIcon },
  { name: 'strike', label: 'Strikethrough', shortcut: '⌘⇧S', icon: StrikethroughIcon },
  { name: 'code', label: 'Inline code', shortcut: '⌘E', icon: CodeIcon },
  { name: 'highlight', label: 'Highlight', shortcut: '⌘⇧H', icon: HighlighterIcon },
];

/** `example.com` → `https://example.com`; keeps explicit schemes, `mailto:`, relative and `#` links. */
export function normalizeHref(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('/') || value.startsWith('#')) {
    return value;
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return `mailto:${value}`;
  return `https://${value}`;
}

function toggleMark(editor: Editor, name: MarkName) {
  const chain = editor.chain().focus();
  switch (name) {
    case 'bold':
      return chain.toggleBold().run();
    case 'italic':
      return chain.toggleItalic().run();
    case 'strike':
      return chain.toggleStrike().run();
    case 'code':
      return chain.toggleCode().run();
    case 'highlight':
      return chain.toggleHighlight().run();
  }
}

/**
 * Floating toolbar over a text selection: marks + link editing. ⌘K opens the link field.
 * Hidden in code blocks and for node selections.
 */
export function BubbleToolbar({ editor }: { editor: Editor }) {
  const [linkMode, setLinkMode] = useState(false);
  const [href, setHref] = useState('');
  // shouldShow is registered with the plugin once; it reads link mode through this ref.
  const linkModeRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    linkModeRef.current = linkMode;
    if (!linkMode) return;
    // Focus on the next frame: TipTap's focus() command re-focuses the editor in a rAF, which
    // would otherwise steal focus back from an autofocused field right after a toolbar click.
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [linkMode]);

  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      highlight: e.isActive('highlight'),
      link: e.isActive('link'),
      href: (e.getAttributes('link').href as string | undefined) ?? '',
    }),
  });

  const openLink = () => {
    setHref(active.href);
    setLinkMode(true);
  };

  // ⌘K / Ctrl+K inside the editor opens the link field for the current selection.
  useEffect(() => {
    const dom = editor.view.dom;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
      if (editor.state.selection.empty || !editor.isEditable) return;
      event.preventDefault();
      setHref((editor.getAttributes('link').href as string | undefined) ?? '');
      setLinkMode(true);
    };
    dom.addEventListener('keydown', onKeyDown);
    return () => dom.removeEventListener('keydown', onKeyDown);
  }, [editor]);

  const closeLink = () => {
    setLinkMode(false);
    editor.commands.focus();
  };

  const applyLink = () => {
    const value = normalizeHref(href);
    const chain = editor.chain().focus().extendMarkRange('link');
    if (value) chain.setLink({ href: value }).run();
    else chain.unsetLink().run();
    setLinkMode(false);
  };

  const onLinkKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyLink();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeLink();
    }
  };

  return (
    <BubbleMenu
      editor={editor}
      options={{ placement: 'top', offset: 8, flip: true, shift: { padding: 8 } }}
      shouldShow={({ editor: e, state, from, to, element }) => {
        if (linkModeRef.current) return true;
        if (!e.isEditable || from === to) return false;
        if (state.selection instanceof NodeSelection || e.isActive('codeBlock')) return false;
        if (!state.doc.textBetween(from, to, ' ').trim()) return false;
        return e.view.hasFocus() || element.contains(document.activeElement);
      }}
      className="oat-editor-popup z-50 flex items-center gap-0.5 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
      role="toolbar"
      aria-label="Text formatting"
    >
      {linkMode ? (
        <div className="flex items-center gap-1">
          <Input
            ref={inputRef}
            aria-label="Link URL"
            placeholder="Paste or type a link…"
            className="h-7 w-64"
            value={href}
            onChange={(event) => setHref(event.target.value)}
            onKeyDown={onLinkKeyDown}
          />
          <Button size="icon-sm" variant="ghost" aria-label="Apply link" onClick={applyLink}>
            <CheckIcon />
          </Button>
        </div>
      ) : (
        <>
          {MARKS.map(({ name, label, shortcut, icon: Icon }) => (
            <Button
              key={name}
              size="icon-sm"
              variant="ghost"
              aria-label={label}
              title={`${label} (${shortcut})`}
              aria-pressed={active[name]}
              className="aria-pressed:bg-accent aria-pressed:text-accent-foreground"
              onClick={() => toggleMark(editor, name)}
            >
              <Icon />
            </Button>
          ))}
          <Separator orientation="vertical" className="mx-0.5 h-5 data-vertical:self-center" />
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={active.link ? 'Edit link' : 'Add link'}
            title="Link (⌘K)"
            aria-pressed={active.link}
            className="aria-pressed:bg-accent aria-pressed:text-accent-foreground"
            onClick={openLink}
          >
            <LinkIcon />
          </Button>
          {active.link ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Remove link"
              title="Remove link"
              onClick={() => editor.chain().focus().extendMarkRange('link').unsetLink().run()}
            >
              <UnlinkIcon />
            </Button>
          ) : null}
        </>
      )}
    </BubbleMenu>
  );
}
