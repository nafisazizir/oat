import { describe, expect, it } from 'vitest';

import { escapeClosesView, ESC_OWNER_SELECTOR, isNewNoteShortcut } from './keyboard.ts';

const keys = (over: Partial<KeyboardEvent>) => ({
  key: 'n',
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  repeat: false,
  ...over,
});

describe('isNewNoteShortcut', () => {
  it('accepts ⌘N and Ctrl+N, either case', () => {
    expect(isNewNoteShortcut(keys({ metaKey: true }))).toBe(true);
    expect(isNewNoteShortcut(keys({ ctrlKey: true, key: 'N' }))).toBe(true);
  });

  it('ignores a bare N, extra modifiers and key repeat', () => {
    expect(isNewNoteShortcut(keys({}))).toBe(false);
    expect(isNewNoteShortcut(keys({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isNewNoteShortcut(keys({ metaKey: true, altKey: true }))).toBe(false);
    expect(isNewNoteShortcut(keys({ metaKey: true, repeat: true }))).toBe(false);
    expect(isNewNoteShortcut(keys({ metaKey: true, key: 'm' }))).toBe(false);
  });
});

/** A document stand-in holding elements as `[role, open]` pairs, matched like ESC_OWNER_SELECTOR. */
const doc = (...els: [role: string, open: boolean][]) => ({
  querySelector: (selector: string) => {
    expect(selector).toBe(ESC_OWNER_SELECTOR);
    const hit = els.find(
      ([role, open]) => role === 'menu' || role === 'listbox' || (role.endsWith('dialog') && open),
    );
    return (hit ?? null) as Element | null;
  },
});

describe('escapeClosesView', () => {
  const esc = { key: 'Escape', defaultPrevented: false };

  it('closes on Esc with nothing open over the view', () => {
    expect(escapeClosesView(esc, doc())).toBe(true);
  });

  it('closes when only a non-modal banner (role=alertdialog without data-open) is showing', () => {
    expect(escapeClosesView(esc, doc(['alertdialog', false]))).toBe(true);
  });

  it('leaves Esc to an open dialog, alert dialog, menu or listbox', () => {
    expect(escapeClosesView(esc, doc(['dialog', true]))).toBe(false);
    expect(escapeClosesView(esc, doc(['alertdialog', true]))).toBe(false);
    expect(escapeClosesView(esc, doc(['menu', true]))).toBe(false);
    expect(escapeClosesView(esc, doc(['listbox', true]))).toBe(false);
  });

  it('ignores other keys and an Esc already handled', () => {
    expect(escapeClosesView({ key: 'Enter', defaultPrevented: false }, doc())).toBe(false);
    expect(escapeClosesView({ key: 'Escape', defaultPrevented: true }, doc())).toBe(false);
  });
});
