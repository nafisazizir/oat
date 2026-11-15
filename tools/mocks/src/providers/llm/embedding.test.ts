import { describe, expect, it } from 'vitest';
import { DEFAULT_EMBEDDING_DIMENSIONS, hashEmbedding } from './embedding.ts';

const dot = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * (b[i] ?? 0), 0);
const norm = (a: number[]) => Math.sqrt(dot(a, a));

describe('hashEmbedding', () => {
  it('returns deterministic unit vectors of the requested size', () => {
    const v = hashEmbedding('Quarterly planning meeting');
    expect(v).toHaveLength(DEFAULT_EMBEDDING_DIMENSIONS);
    expect(norm(v)).toBeCloseTo(1, 10);
    expect(hashEmbedding('Quarterly planning meeting')).toEqual(v);
    expect(hashEmbedding('x', 8)).toHaveLength(8);
  });

  it('ignores case and punctuation', () => {
    expect(hashEmbedding('Hello, World!')).toEqual(hashEmbedding('hello world'));
  });

  it('scores similar text above unrelated text', () => {
    const query = hashEmbedding('budget review for the marketing launch');
    const similar = hashEmbedding('We reviewed the marketing budget before launch');
    const unrelated = hashEmbedding('The cat sat on a warm windowsill');
    expect(dot(query, similar)).toBeGreaterThan(0.3);
    expect(dot(query, similar)).toBeGreaterThan(dot(query, unrelated) + 0.2);
    // Trigrams make inflections close: "meetings" ~ "meeting".
    expect(dot(hashEmbedding('meetings'), hashEmbedding('meeting'))).toBeGreaterThan(
      dot(hashEmbedding('meetings'), hashEmbedding('invoice')),
    );
  });

  it('maps empty text to a fixed unit vector and rejects bad sizes', () => {
    const v = hashEmbedding('', 4);
    expect(v).toEqual([1, 0, 0, 0]);
    expect(() => hashEmbedding('x', 0)).toThrow(RangeError);
  });
});
