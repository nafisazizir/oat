// @vitest-environment jsdom
import type { Editor, JSONContent } from '@tiptap/core';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { localDay } from '../task-dates.ts';
import { OatEditor, type OatEditorProps } from './index.ts';

const taskDoc = (...items: Record<string, unknown>[]): JSONContent => ({
  type: 'doc',
  content: [
    {
      type: 'taskList',
      content: items.map(({ text, ...attrs }) => ({
        type: 'taskItem',
        attrs: { checked: false, ...attrs },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: String(text) }] }],
      })),
    },
  ],
});

async function mount(props: OatEditorProps) {
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
  await waitFor(() => expect(utils.container.querySelector('.oat-task')).not.toBeNull());
  return { ...utils, editor: editor!, onChange };
}

const taskAttrs = (editor: Editor, index = 0) => {
  const items: Record<string, unknown>[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'taskItem') items.push(node.attrs);
  });
  return items[index]!;
};

describe('task items in <OatEditor> (8.4)', () => {
  it('shows owner and due chips, and keeps block attributes on the <li>', async () => {
    const today = localDay();
    const { container } = await mount({
      value: taskDoc({
        text: 'Send the deck',
        id: 'block-1',
        owner: { name: 'Dana Lee', email: 'dana@example.com' },
        due: today,
      }),
    });
    const li = container.querySelector('li[data-type="taskItem"]')!;
    expect(li.getAttribute('data-id')).toBe('block-1');
    expect(li.getAttribute('data-checked')).toBe('false');
    const meta = within(li as HTMLElement).getByTestId('task-meta');
    expect(meta.textContent).toContain('Dana Lee');
    expect(meta.textContent).toContain('Today');
    expect(meta.querySelector('[data-kind="due"]')?.getAttribute('data-state')).toBe('today');
    // The meta never becomes part of the note's text.
    expect(li.querySelector('.oat-task-content')?.textContent).toBe('Send the deck');
  });

  it('toggles done from the checkbox', async () => {
    const { editor, onChange, container } = await mount({ value: taskDoc({ text: 'Do it' }) });
    const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    act(() => {
      fireEvent.click(box);
    });
    await waitFor(() => expect(taskAttrs(editor).checked).toBe(true));
    expect(onChange).toHaveBeenCalled();
    await waitFor(() =>
      expect(
        container.querySelector('li[data-type="taskItem"]')?.getAttribute('data-checked'),
      ).toBe('true'),
    );
  });

  it('sets and clears owner/due with commands; Enter does not copy them to the next task', async () => {
    const { editor } = await mount({ value: taskDoc({ text: 'Do it' }) });
    act(() => {
      editor.commands.setTextSelection(3);
      editor.commands.setTaskOwner({ name: 'Sam', userId: 'u_sam' });
      editor.commands.setTaskDue('2026-11-20');
    });
    expect(taskAttrs(editor)).toMatchObject({
      owner: { name: 'Sam', userId: 'u_sam' },
      due: '2026-11-20',
    });
    act(() => {
      editor.commands.setTaskDue('not a date');
    });
    expect(taskAttrs(editor).due).toBeNull();
    act(() => {
      editor.commands.setTaskDue('2026-11-20');
      editor.commands.setTextSelection(8); // end of "Do it"
      editor.commands.splitListItem('taskItem');
    });
    expect(taskAttrs(editor, 1)).toMatchObject({ owner: null, due: null });
    act(() => {
      editor.commands.setTaskOwner(null, 1);
    });
    expect(taskAttrs(editor).owner).toBeNull();
  });

  it('assigns from the picker (people from onTaskAssigneeQuery, or a typed name)', async () => {
    const query = vi.fn(async (q: string) =>
      [
        { name: 'Dana Lee', email: 'dana@example.com', userId: 'u_dana' },
        { name: 'Sam Park', email: 'sam@example.com' },
      ].filter((p) => p.name.toLowerCase().includes(q.toLowerCase())),
    );
    const { editor } = await mount({
      value: taskDoc({ text: 'Do it' }),
      onTaskAssigneeQuery: query,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Assign task' }));
    const picker = await screen.findByTestId('task-owner-picker');
    await waitFor(() => expect(within(picker).getByText('Dana Lee')).toBeDefined());
    fireEvent.click(within(picker).getByText('Dana Lee'));
    await waitFor(() =>
      expect(taskAttrs(editor).owner).toEqual({
        name: 'Dana Lee',
        email: 'dana@example.com',
        userId: 'u_dana',
      }),
    );

    // Change it to a typed name nobody in the list has.
    fireEvent.click(screen.getByRole('button', { name: /Assigned to Dana Lee/ }));
    const again = await screen.findByTestId('task-owner-picker');
    fireEvent.change(within(again).getByRole('combobox'), { target: { value: 'Priya' } });
    await waitFor(() => expect(query).toHaveBeenLastCalledWith('Priya'));
    fireEvent.click(await within(again).findByText(/Assign to “Priya”/));
    await waitFor(() => expect(taskAttrs(editor).owner).toEqual({ name: 'Priya' }));
  });

  it('sets a due date from the picker', async () => {
    const { editor } = await mount({ value: taskDoc({ text: 'Do it' }) });
    fireEvent.click(screen.getByRole('button', { name: 'Set due date' }));
    const picker = await screen.findByTestId('task-due-picker');
    fireEvent.change(within(picker).getByLabelText('Due date'), {
      target: { value: '2027-01-04' },
    });
    await waitFor(() => expect(taskAttrs(editor).due).toBe('2027-01-04'));
  });

  it('read-only: chips are labels, no pickers, checkbox disabled', async () => {
    const { container } = await mount({
      editable: false,
      value: taskDoc(
        { text: 'Assigned', owner: { name: 'Dana' }, due: '2026-11-20' },
        { text: 'Bare' },
      ),
    });
    expect(screen.queryByRole('button', { name: 'Assign task' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Assigned to/ })).toBeNull();
    expect(container.querySelectorAll('[data-testid="task-meta"]')).toHaveLength(1);
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(
      true,
    );
  });
});
