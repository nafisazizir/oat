import { describe, expect, it } from 'vitest';

import { clock, conflictOrigin, snippetParts } from './search-text.ts';

describe('snippetParts', () => {
  it('splits highlighted matches from plain text', () => {
    expect(snippetParts('…we \u0001budget\u0002 for \u0001Q3\u0002')).toEqual([
      { text: '…we ', hit: false },
      { text: 'budget', hit: true },
      { text: ' for ', hit: false },
      { text: 'Q3', hit: true },
    ]);
    expect(snippetParts('plain')).toEqual([{ text: 'plain', hit: false }]);
    expect(snippetParts('open \u0001end')).toEqual([
      { text: 'open ', hit: false },
      { text: 'end', hit: true },
    ]);
    expect(snippetParts('')).toEqual([]);
  });
});

describe('clock / conflictOrigin', () => {
  it('formats positions and origins', () => {
    expect(clock(61_000)).toBe('1:01');
    expect(clock(3_725_000)).toBe('1:02:05');
    expect(conflictOrigin('Studio Mac', null)).toBe('Conflicted copy from Studio Mac');
    expect(conflictOrigin(null, null)).toBe('Conflicted copy from another device');
    expect(conflictOrigin('A', '2026-11-14T10:00:00.000Z')).toMatch(/^Conflicted copy from A · /);
  });
});
