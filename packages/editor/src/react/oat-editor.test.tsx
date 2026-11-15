// @vitest-environment jsdom
import type { Editor, JSONContent } from '@tiptap/core';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { collectBlockIds } from '../schema.ts';
import { filterSlashItems } from '../slash-items.ts';
import { normalizeHref, OatEditor, type OatEditorProps } from './index.ts';
import { MenuList, type SuggestionMenuHandle } from './suggestion-popup.tsx';

async function mount(props: OatEditorProps = {}) {
  let editor: Editor | undefined;
  const onChange = vi.fn<(value: JSONContent) => void>();
  const utils = render(
    <OatEditor
      onChange={onChange}
      {...props}
      onReady={(e) => {
        editor = e;
      }}
    />,
  );
  await waitFor(() => expect(editor).toBeDefined());
  return { ...utils, editor: editor!, onChange };
}

/** Type text the way ProseMirror receives it from the keyboard, so input rules fire. */
function type(editor: Editor, text: string) {
  act(() => {
    for (const char of text) {
      const { from, to } = editor.state.selection;
      const handled = editor.view.someProp('handleTextInput', (f) =>
        f(editor.view, from, to, char, () => editor.state.tr.insertText(char, from, to)),
      );
      if (!handled) editor.view.dispatch(editor.state.tr.insertText(char, from, to));
    }
  });
}

function press(editor: Editor, key: string) {
  act(() => {
    fireEvent.keyDown(editor.view.dom, { key });
  });
}

describe('<OatEditor>', () => {
  it('renders content and assigns a unique id to every block', async () => {
    const value: JSONContent = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }],
            },
          ],
        },
      ],
    };
    const { editor, onChange } = await mount({ value });
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveProperty('textContent', 'onetwo');
    const ids = collectBlockIds(editor.getJSON());
    // p, list, item, p + the trailing paragraph TipTap keeps after a non-paragraph last block.
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    // The id assignment is reported so the stored doc picks the ids up.
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(collectBlockIds(onChange.mock.lastCall![0])).toEqual(ids);
  });

  it('renders origin as data-origin and keeps it in JSON', async () => {
    const { container, editor } = await mount({
      value: {
        type: 'doc',
        content: [
          { type: 'paragraph', attrs: { origin: 'ai' }, content: [{ type: 'text', text: 'AI' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'me' }] },
        ],
      },
    });
    const paragraphs = container.querySelectorAll('.oat-editor > p');
    expect(paragraphs[0]!.getAttribute('data-origin')).toBe('ai');
    expect(paragraphs[1]!.getAttribute('data-origin')).toBe('me');
    expect(editor.getJSON().content!.map((b) => b.attrs?.origin)).toEqual(['ai', 'me']);
  });

  it('starts a block I split off an AI block as mine, and claims an emptied AI block', async () => {
    const { editor } = await mount({
      value: {
        type: 'doc',
        content: [
          { type: 'paragraph', attrs: { origin: 'ai' }, content: [{ type: 'text', text: 'AI' }] },
        ],
      },
    });
    act(() => {
      editor.chain().focus('end').splitBlock().run();
    });
    type(editor, 'mine');
    expect(editor.getJSON().content!.map((b) => b.attrs?.origin)).toEqual(['ai', 'me']);

    // Select the AI paragraph's text and delete it: the now-empty block becomes mine.
    act(() => {
      editor.chain().setTextSelection({ from: 1, to: 3 }).deleteSelection().run();
    });
    expect(editor.getJSON().content![0]!.attrs?.origin).toBe('me');
  });

  describe('joining blocks of different origin yields me (D-23)', () => {
    const twoParagraphs = (first: 'me' | 'ai', second: 'me' | 'ai'): JSONContent => ({
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { origin: first }, content: [{ type: 'text', text: 'AAA' }] },
        { type: 'paragraph', attrs: { origin: second }, content: [{ type: 'text', text: 'BBB' }] },
      ],
    });
    const origins = (editor: Editor) =>
      (editor.getJSON() as JSONContent)
        .content!.filter((b) => b.content)
        .map((b) => `${b.attrs?.origin}:${b.content!.map((t) => t.text).join('')}`);
    // Positions: first paragraph text 1..4, boundary, second paragraph text 6..9.

    it('Backspace at the start of my paragraph after an AI one', async () => {
      const { editor } = await mount({ value: twoParagraphs('ai', 'me') });
      act(() => {
        editor.chain().focus().setTextSelection(6).run();
      });
      press(editor, 'Backspace');
      expect(origins(editor)).toEqual(['me:AAABBB']);
    });

    it('Delete at the end of an AI paragraph before mine', async () => {
      const { editor } = await mount({ value: twoParagraphs('ai', 'me') });
      act(() => {
        editor.chain().focus().setTextSelection(4).run();
      });
      press(editor, 'Delete');
      expect(origins(editor)).toEqual(['me:AAABBB']);
    });

    it('joinBackward / joinForward commands, either order', async () => {
      const a = await mount({ value: twoParagraphs('me', 'ai') });
      act(() => {
        a.editor.chain().focus().setTextSelection(6).joinBackward().run();
      });
      expect(origins(a.editor)).toEqual(['me:AAABBB']);
      a.unmount();
      const b = await mount({ value: twoParagraphs('ai', 'me') });
      act(() => {
        b.editor.chain().focus().setTextSelection(4).joinForward().run();
      });
      expect(origins(b.editor)).toEqual(['me:AAABBB']);
    });

    it('deleting a selection across the boundary', async () => {
      const { editor } = await mount({ value: twoParagraphs('ai', 'me') });
      act(() => {
        editor.chain().focus().setTextSelection({ from: 3, to: 8 }).deleteSelection().run();
      });
      expect(origins(editor)).toEqual(['me:AAB']);
    });

    it('typing over a cross-block selection', async () => {
      const { editor } = await mount({ value: twoParagraphs('ai', 'me') });
      act(() => {
        editor.chain().focus().setTextSelection({ from: 3, to: 8 }).run();
      });
      type(editor, 'z');
      expect(origins(editor)).toEqual(['me:AAzB']);
    });

    it('keeps ai when both sides are ai, and undo restores the original origins', async () => {
      const same = await mount({ value: twoParagraphs('ai', 'ai') });
      act(() => {
        same.editor.chain().focus().setTextSelection(6).joinBackward().run();
      });
      expect(origins(same.editor)).toEqual(['ai:AAABBB']);
      same.unmount();

      const { editor } = await mount({ value: twoParagraphs('ai', 'me') });
      act(() => {
        editor.chain().focus().setTextSelection(6).joinBackward().run();
      });
      expect(origins(editor)).toEqual(['me:AAABBB']);
      act(() => {
        editor.commands.undo();
      });
      expect(origins(editor)).toEqual(['ai:AAA', 'me:BBB']);
    });

    it('joining list items of different origin', async () => {
      const item = (origin: 'me' | 'ai', text: string): JSONContent => ({
        type: 'listItem',
        attrs: { origin },
        content: [{ type: 'paragraph', attrs: { origin }, content: [{ type: 'text', text }] }],
      });
      const { editor } = await mount({
        value: {
          type: 'doc',
          content: [{ type: 'bulletList', content: [item('ai', 'AAA'), item('me', 'BBB')] }],
        },
      });
      // Select from inside the AI item's text to inside mine and delete.
      act(() => {
        editor.chain().focus().setTextSelection({ from: 5, to: 11 }).deleteSelection().run();
      });
      const list = (editor.getJSON() as JSONContent).content![0]!;
      expect(list.content).toHaveLength(1);
      expect(list.content![0]!.content![0]!.attrs?.origin).toBe('me');
    });
  });

  it('de-duplicates ids in the initial value and reports the repair once', async () => {
    const value: JSONContent = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { id: 'x' }, content: [{ type: 'text', text: 'one' }] },
        { type: 'paragraph', attrs: { id: 'x' }, content: [{ type: 'text', text: 'two' }] },
      ],
    };
    const { editor, onChange } = await mount({ value });
    const ids = collectBlockIds(editor.getJSON());
    expect(ids[0]).toBe('x');
    expect(new Set(ids).size).toBe(ids.length);
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(collectBlockIds(onChange.mock.calls[0]![0]).slice(0, 2)).toEqual(ids.slice(0, 2));
    expect(value.content![1]!.attrs!.id).toBe('x'); // caller's object untouched
  });

  it('does not emit onChange just for opening a doc with valid ids', async () => {
    const paragraph = {
      type: 'paragraph',
      attrs: { id: 'p' },
      content: [{ type: 'text', text: 'x' }],
    };
    const { editor, onChange } = await mount({
      value: {
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            attrs: { id: 'l' },
            content: [{ type: 'listItem', attrs: { id: 'i' }, content: [paragraph] }],
          },
        ],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      editor.commands.focus('end');
    });
    type(editor, 'y');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['# ', 'heading', { level: 1 }],
    ['## ', 'heading', { level: 2 }],
    ['### ', 'heading', { level: 3 }],
    ['- ', 'bulletList', {}],
    ['1. ', 'orderedList', {}],
    ['[] ', 'taskList', {}],
    ['> ', 'blockquote', {}],
    ['``` ', 'codeBlock', {}],
    ['---', 'horizontalRule', {}],
  ])('turns the Markdown shortcut %j into %s', async (shortcut, nodeType, attrs) => {
    const { editor } = await mount();
    act(() => {
      editor.commands.focus();
    });
    type(editor, shortcut);
    const first = editor.getJSON().content![0]!;
    expect(first.type).toBe(nodeType);
    expect(first.attrs).toMatchObject(attrs);
  });

  it.each([
    ['**bold** ', 'bold'],
    ['*italic* ', 'italic'],
    ['~~strike~~ ', 'strike'],
    ['`code` ', 'code'],
    ['==mark== ', 'highlight'],
  ])('applies the inline Markdown shortcut %j as %s', async (input, mark) => {
    const { editor } = await mount();
    act(() => {
      editor.commands.focus();
    });
    type(editor, input);
    const text = editor.getJSON().content![0]!.content!;
    expect(text[0]!.marks?.[0]?.type).toBe(mark);
  });

  it('opens the slash menu, filters it and inserts the chosen block', async () => {
    const { editor } = await mount();
    act(() => {
      editor.commands.focus();
    });
    type(editor, '/');
    const menu = await screen.findByRole('listbox', { name: 'Insert block' });
    expect(menu.querySelectorAll('[role=option]')).toHaveLength(filterSlashItems('').length);

    type(editor, 'head');
    await waitFor(() =>
      expect(screen.getAllByRole('option').map((o) => o.textContent?.replace(/#+$/, ''))).toEqual([
        'Heading 1Big section heading',
        'Heading 2Medium section heading',
        'Heading 3Small section heading',
      ]),
    );
    expect(screen.getAllByRole('option')[0]!.getAttribute('aria-selected')).toBe('true');

    // Combobox wiring: the focused editor points at the listbox and its active option.
    const dom = editor.view.dom;
    const options = () => screen.getAllByRole('option');
    expect(dom.getAttribute('aria-expanded')).toBe('true');
    expect(dom.getAttribute('aria-autocomplete')).toBe('list');
    expect(dom.getAttribute('aria-controls')).toBe(menu.id);
    expect(menu.id).not.toBe('');
    expect(options().every((o) => o.id.startsWith(menu.id))).toBe(true);
    expect(new Set(options().map((o) => o.id)).size).toBe(3);
    expect(dom.getAttribute('aria-activedescendant')).toBe(options()[0]!.id);

    press(editor, 'ArrowDown');
    await waitFor(() => expect(options()[1]!.getAttribute('aria-selected')).toBe('true'));
    expect(options()[0]!.getAttribute('aria-selected')).toBe('false');
    expect(dom.getAttribute('aria-activedescendant')).toBe(options()[1]!.id);
    press(editor, 'Enter');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    for (const name of ['aria-expanded', 'aria-controls', 'aria-activedescendant']) {
      expect(dom.hasAttribute(name), name).toBe(false);
    }
    const first = editor.getJSON().content![0]!;
    expect(first).toMatchObject({ type: 'heading', attrs: { level: 2 } });
    expect(first.content).toBeUndefined(); // the "/head" text was removed
  });

  it('inserts a callout from the slash menu', async () => {
    const { editor, container } = await mount();
    act(() => {
      editor.commands.focus();
    });
    type(editor, '/callout');
    await screen.findByRole('option', { name: /Callout/ });
    press(editor, 'Enter');
    await waitFor(() => expect(container.querySelector('[data-type=callout]')).not.toBeNull());
    type(editor, 'Heads up');
    expect(editor.getJSON().content![0]).toMatchObject({
      type: 'callout',
      attrs: { emoji: '💡', variant: 'neutral' },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Heads up' }] }],
    });
  });

  it('closes the slash menu on Escape and shows "no results" for unknown queries', async () => {
    const { editor } = await mount();
    act(() => {
      editor.commands.focus();
    });
    type(editor, '/zzz');
    await screen.findByText('No matching blocks');
    press(editor, 'Escape');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(editor.getText()).toBe('/zzz');
  });

  it('mentions people from the onMentionQuery callback', async () => {
    const people = [
      { id: 'u1', label: 'Priya Natarajan', description: 'priya@example.com' },
      { id: 'u2', label: 'Marco Rossi' },
    ];
    const onMentionQuery = vi.fn((query: string) =>
      people.filter((p) => p.label.toLowerCase().includes(query.toLowerCase())),
    );
    const { editor } = await mount({ onMentionQuery });
    act(() => {
      editor.commands.focus();
    });
    type(editor, '@mar');
    const marco = await screen.findByRole('option', { name: /Marco Rossi/ });
    expect(onMentionQuery).toHaveBeenLastCalledWith('mar');
    expect(editor.view.dom.getAttribute('aria-activedescendant')).toBe(marco.id);
    expect(editor.view.dom.getAttribute('aria-controls')).toBe(
      screen.getByRole('listbox', { name: 'Mention a person' }).id,
    );
    press(editor, 'Enter');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    const content = editor.getJSON().content![0]!.content!;
    expect(content[0]).toMatchObject({
      type: 'mention',
      attrs: { id: 'u2', label: 'Marco Rossi' },
    });
  });

  it('syncs external value changes without echoing onChange', async () => {
    const first: JSONContent = {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { id: 'a' }, content: [{ type: 'text', text: 'A' }] }],
    };
    const second: JSONContent = {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { id: 'b' }, content: [{ type: 'text', text: 'B' }] }],
    };
    let editor: Editor | undefined;
    const onChange = vi.fn();
    const { rerender } = render(
      <OatEditor value={first} onChange={onChange} onReady={(e) => (editor = e)} />,
    );
    await waitFor(() => expect(editor?.getText()).toBe('A'));
    onChange.mockClear();
    rerender(<OatEditor value={second} onChange={onChange} onReady={(e) => (editor = e)} />);
    await waitFor(() => expect(editor!.getText()).toBe('B'));
    expect(onChange).not.toHaveBeenCalled();
    expect(collectBlockIds(editor!.getJSON())).toEqual(['b']);
  });

  it('respects editable={false}', async () => {
    const { editor, rerender } = await mount({ editable: false });
    expect(editor.isEditable).toBe(false);
    rerender(<OatEditor editable />);
    await waitFor(() => expect(editor.isEditable).toBe(true));
  });
});

describe('<MenuList>', () => {
  it('wraps keyboard navigation and selects with Enter', () => {
    const onSelect = vi.fn();
    const ref = createRef<SuggestionMenuHandle>();
    render(
      <MenuList
        handleRef={ref}
        items={['a', 'b', 'c']}
        onSelect={onSelect}
        getKey={(item) => item}
        renderItem={(item) => item}
        label="Test"
        empty="none"
      />,
    );
    const key = (k: string) =>
      act(() => void ref.current!.onKeyDown(new KeyboardEvent('keydown', { key: k })));
    key('ArrowUp'); // wraps to the last item
    expect(screen.getByRole('option', { name: 'c' }).getAttribute('aria-selected')).toBe('true');
    key('ArrowDown');
    key('ArrowDown');
    key('Enter');
    expect(onSelect).toHaveBeenCalledWith('b');
    expect(ref.current!.onKeyDown(new KeyboardEvent('keydown', { key: 'x' }))).toBe(false);
  });
});

describe('normalizeHref', () => {
  it.each([
    ['example.com', 'https://example.com'],
    ['  https://oat.app/x ', 'https://oat.app/x'],
    ['mailto:a@b.co', 'mailto:a@b.co'],
    ['a@b.co', 'mailto:a@b.co'],
    ['/notes/1', '/notes/1'],
    ['#section', '#section'],
    ['', ''],
  ])('%j → %j', (input, output) => {
    expect(normalizeHref(input)).toBe(output);
  });
});
