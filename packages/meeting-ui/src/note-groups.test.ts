import { describe, expect, it } from 'vitest';

import { groupNotesByDate } from './note-groups.ts';

const now = Date.parse('2026-11-21T15:00:00Z');
describe('date-grouped notes', () => {
  it('sorts notes newest first and uses relative day labels', () => {
    expect(
      groupNotesByDate(
        [
          '2026-11-19T10:00:00Z',
          '2026-11-21T12:00:00Z',
          '2026-11-20T15:00:00Z',
          '2026-11-21T14:00:00Z',
        ],
        (x) => x,
        now,
        'UTC',
      ).map((g) => [g.label, g.notes.length]),
    ).toEqual([
      ['Today', 2],
      ['Yesterday', 1],
      ['Nov 19', 1],
    ]);
  });
  it('handles an empty list and missing/invalid dates without dropping notes', () => {
    expect(groupNotesByDate([], (x) => x, now)).toEqual([]);
    expect(groupNotesByDate([null, 'bad'], (x) => x, now)).toEqual([
      { label: 'Earlier', notes: [null, 'bad'] },
    ]);
  });
  it('uses calendar days across a DST change', () => {
    expect(
      groupNotesByDate(
        ['2026-11-01T06:30:00Z'],
        (x) => x,
        Date.parse('2026-11-02T05:30:00Z'),
        'America/New_York',
      )[0]?.label,
    ).toBe('Yesterday');
  });
});
