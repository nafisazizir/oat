import { describe, expect, it } from 'vitest';

import { canRebase, jsonEqual } from './json-equal';

describe('jsonEqual', () => {
  it('ignores key order and undefined keys, not array order', () => {
    expect(jsonEqual({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
    expect(jsonEqual({ a: 1, x: undefined }, { a: 1 })).toBe(true);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonEqual({ a: null }, { a: undefined })).toBe(false);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEqual([], {})).toBe(false);
    expect(jsonEqual('x', 'x')).toBe(true);
  });
});

describe('canRebase', () => {
  const base = { title: 'Plan', contentJson: { type: 'doc', content: [{ type: 'paragraph' }] } };
  const renamed = { ...base, title: 'Plan v2' };
  const edited = { ...base, contentJson: { content: [], type: 'doc' } };

  it('re-sends a body edit over a rename, and a rename over a body edit', () => {
    expect(canRebase({ contentJson: { type: 'doc' } }, base, renamed)).toBe(true);
    expect(canRebase({ title: 'Plan!' }, base, edited)).toBe(true);
  });

  it('refuses when the server changed a field the patch writes', () => {
    expect(canRebase({ title: 'Plan!' }, base, renamed)).toBe(false);
    expect(canRebase({ contentJson: { type: 'doc' } }, base, edited)).toBe(false);
    expect(canRebase({ title: 'x', contentJson: { type: 'doc' } }, base, renamed)).toBe(false);
  });

  it('compares content regardless of key order (jsonb)', () => {
    const reordered = { ...base, contentJson: { content: [{ type: 'paragraph' }], type: 'doc' } };
    expect(canRebase({ contentJson: { type: 'doc' } }, base, reordered)).toBe(true);
  });
});
