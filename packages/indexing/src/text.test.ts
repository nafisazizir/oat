import { describe, expect, it } from 'vitest';
import { indexingConfig } from './env.ts';
import { capDrafts } from './indexer.ts';
import { jobKey, parseJobKey } from './queue.ts';
import { chunkHash, estimateTokens, splitLongText } from './text.ts';

describe('capDrafts', () => {
  const drafts = (source: 'notes' | 'transcript', n: number) =>
    Array.from({ length: n }, (_, ordinal) => ({
      source,
      ordinal,
      text: '',
      refIds: [],
      startMs: null,
      endMs: null,
      tokenCount: 0,
    }));
  const count = (kept: { source: string }[], source: string) =>
    kept.filter((d) => d.source === source).length;

  it('keeps everything under the cap', () => {
    expect(capDrafts(drafts('notes', 3), 5)).toMatchObject({ dropped: 0 });
  });

  it('splits the cap between notes and transcript, letting one use what the other leaves', () => {
    const both = capDrafts([...drafts('notes', 10), ...drafts('transcript', 10)], 6);
    expect([count(both.kept, 'notes'), count(both.kept, 'transcript'), both.dropped]).toEqual([
      3, 3, 14,
    ]);
    const fewNotes = capDrafts([...drafts('notes', 1), ...drafts('transcript', 10)], 6);
    expect([count(fewNotes.kept, 'notes'), count(fewNotes.kept, 'transcript')]).toEqual([1, 5]);
    const fewSegs = capDrafts([...drafts('notes', 10), ...drafts('transcript', 2)], 6);
    expect([count(fewSegs.kept, 'notes'), count(fewSegs.kept, 'transcript')]).toEqual([4, 2]);
  });
});

describe('text helpers', () => {
  it('estimates ~4 chars per token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('splits long text at sentences, then words, within the budget', () => {
    const text = `${'One two three. '.repeat(50)}${'x'.repeat(100)}`;
    const pieces = splitLongText(text, 20);
    expect(pieces.length).toBeGreaterThan(5);
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(80);
    expect(pieces.join(' ').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
  });

  it('hashes model + text', () => {
    expect(chunkHash('m', 'a')).toBe(chunkHash('m', 'a'));
    expect(chunkHash('m', 'a')).not.toBe(chunkHash('n', 'a'));
    expect(chunkHash('m', 'a')).not.toBe(chunkHash('m', 'b'));
    expect(chunkHash('m', 'a')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('job keys', () => {
  it('round-trip and reject garbage', () => {
    expect(parseJobKey(jobKey({ kind: 'meeting', id: 'a:b' }))).toEqual({
      kind: 'meeting',
      id: 'a:b',
    });
    expect(() => parseJobKey('nope:1')).toThrow();
    expect(() => parseJobKey('document:')).toThrow();
  });
});

describe('indexingConfig', () => {
  it('has defaults and validates numbers', () => {
    expect(indexingConfig({})).toEqual({
      redisUrl: 'redis://localhost:63790',
      prefix: 'oat:idx',
      debounceMs: 1500,
      concurrency: 2,
      maxChunksPerDocument: 1000,
    });
    expect(
      indexingConfig({ OAT_INDEX_DEBOUNCE_MS: '0', OAT_INDEX_CONCURRENCY: '0' }),
    ).toMatchObject({
      debounceMs: 0,
      concurrency: 1,
    });
    expect(() => indexingConfig({ OAT_INDEX_DEBOUNCE_MS: 'soon' })).toThrow(
      /OAT_INDEX_DEBOUNCE_MS/,
    );
  });
});
