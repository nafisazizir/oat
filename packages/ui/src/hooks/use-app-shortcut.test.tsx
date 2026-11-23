import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { matchesAppShortcut, useAppShortcut } from './use-app-shortcut';

describe('shared host shortcuts', () => {
  it.each([
    ['palette', 'k'],
    ['sidebar', 'b'],
    ['assistant', 'j'],
    ['settings', ','],
  ] as const)('%s handles Cmd and Ctrl once', (shortcut, key) => {
    for (const modifier of ['metaKey', 'ctrlKey']) {
      expect(
        matchesAppShortcut(
          new KeyboardEvent('keydown', { key: key.toUpperCase(), [modifier]: true }),
          shortcut,
        ),
      ).toBe(true);
    }
    for (const flags of [{ shiftKey: true }, { altKey: true }, { repeat: true }, {}]) {
      const event = new KeyboardEvent('keydown', {
        key,
        ...(Object.keys(flags).length ? { metaKey: true } : {}),
        ...flags,
        cancelable: true,
      });
      expect(matchesAppShortcut(event, shortcut)).toBe(false);
    }
    const prevented = new KeyboardEvent('keydown', { key, ctrlKey: true, cancelable: true });
    prevented.preventDefault();
    expect(matchesAppShortcut(prevented, shortcut)).toBe(false);
    expect(
      matchesAppShortcut(new KeyboardEvent('keydown', { key: 'n', metaKey: true }), shortcut),
    ).toBe(false);
  });

  it.each([
    ['palette', 'k'],
    ['sidebar', 'b'],
    ['assistant', 'j'],
    ['settings', ','],
  ] as const)('binds %s and releases it on unmount', (shortcut, key) => {
    const action = vi.fn();
    function Host() {
      useAppShortcut(shortcut, action);
      return null;
    }
    const view = render(<Host />);
    fireEvent.keyDown(window, { key, ctrlKey: true });
    expect(action).toHaveBeenCalledOnce();
    view.unmount();
    fireEvent.keyDown(window, { key, ctrlKey: true });
    expect(action).toHaveBeenCalledOnce();
  });

  it('keeps editor link/bold shortcuts and input bold local, but allows the assistant', () => {
    const calls = { palette: vi.fn(), sidebar: vi.fn(), assistant: vi.fn() };
    function Host() {
      useAppShortcut('palette', calls.palette);
      useAppShortcut('sidebar', calls.sidebar);
      useAppShortcut('assistant', calls.assistant);
      return (
        <>
          <div className="oat-editor">
            <span data-testid="editor">Text</span>
          </div>
          <input aria-label="Title" />
        </>
      );
    }
    const view = render(<Host />);
    const editor = view.getByTestId('editor');
    editor.setAttribute('contenteditable', 'true');
    fireEvent.keyDown(editor, { key: 'k', metaKey: true });
    fireEvent.keyDown(editor, { key: 'b', metaKey: true });
    fireEvent.keyDown(editor, { key: 'j', metaKey: true });
    fireEvent.keyDown(view.getByRole('textbox'), { key: 'b', ctrlKey: true });
    expect(calls.palette).not.toHaveBeenCalled();
    expect(calls.sidebar).not.toHaveBeenCalled();
    expect(calls.assistant).toHaveBeenCalledOnce();
    fireEvent.keyDown(view.getByRole('textbox'), { key: 'k', ctrlKey: true });
    expect(calls.palette).toHaveBeenCalledOnce();
  });
});
