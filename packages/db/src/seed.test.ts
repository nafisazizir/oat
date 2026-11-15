import { describe, expect, it } from 'vitest';
import { UUID_V7 } from './id.ts';
import { parseSeedSegments, SEED } from './seed.ts';

describe('parseSeedSegments', () => {
  const seg = { source: 'mic', startMs: 0, endMs: 10, text: 'hi' };

  it('accepts an array or { segments }', () => {
    expect(parseSeedSegments([seg])).toEqual([{ ...seg, id: undefined, speakerLabel: null }]);
    expect(parseSeedSegments({ segments: [{ ...seg, id: 's1', speakerLabel: 'A' }] })).toEqual([
      { ...seg, id: 's1', speakerLabel: 'A' },
    ]);
  });

  it.each([
    ['not a list', { foo: 1 }],
    ['bad source', [{ ...seg, source: 'both' }]],
    ['end before start', [{ ...seg, startMs: 5, endMs: 4 }]],
    ['fractional ms', [{ ...seg, endMs: 1.5 }]],
    ['missing text', [{ source: 'mic', startMs: 0, endMs: 1 }]],
  ])('rejects %s', (_label, input) => {
    expect(() => parseSeedSegments(input)).toThrow(/segments fixture/);
  });
});

describe('SEED ids', () => {
  it('are fixed UUIDv7-shaped strings', () => {
    const ids = [
      SEED.userId,
      SEED.personalWorkspaceId,
      SEED.teamWorkspaceId,
      SEED.templateId,
      SEED.meetingId,
      ...Object.values(SEED.folders),
      ...Object.values(SEED.documents),
    ];
    for (const id of ids) expect(id).toMatch(UUID_V7);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
