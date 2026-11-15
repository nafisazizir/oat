import { describe, expect, it } from 'vitest';

import { filterSlashItems, SLASH_ITEMS } from './slash-items.ts';

const ids = (query: string) => filterSlashItems(query).map((item) => item.id);

describe('filterSlashItems', () => {
  it('returns every block for an empty query, in menu order', () => {
    expect(ids('')).toEqual(SLASH_ITEMS.map((item) => item.id));
    expect(ids('  ')).toHaveLength(SLASH_ITEMS.length);
  });

  it('covers every block the editor offers', () => {
    expect(ids('')).toEqual([
      'text',
      'heading-1',
      'heading-2',
      'heading-3',
      'bullet-list',
      'ordered-list',
      'task-list',
      'quote',
      'code',
      'divider',
      'callout',
    ]);
  });

  it('matches title prefixes case-insensitively', () => {
    expect(ids('head')).toEqual(['heading-1', 'heading-2', 'heading-3']);
    expect(ids('HEADING 2')).toEqual(['heading-2']);
    expect(ids('call')).toEqual(['callout']);
  });

  it('ranks title matches before alias matches', () => {
    // "list" is a word in three titles and an alias of two of them.
    expect(ids('list')).toEqual(['bullet-list', 'ordered-list', 'task-list']);
    // "Code block" (title) beats nothing else; "codeblock" alias also lands on it.
    expect(ids('codeblock')).toEqual(['code']);
  });

  it('matches aliases and Markdown-ish names', () => {
    expect(ids('h2')).toEqual(['heading-2']);
    expect(ids('todo')).toEqual(['task-list']);
    expect(ids('hr')).toEqual(['divider']);
    expect(ids('ul')).toContain('bullet-list');
    expect(ids('blockquote')).toEqual(['quote']);
  });

  it('returns nothing for unknown queries', () => {
    expect(ids('zzz')).toEqual([]);
  });
});
