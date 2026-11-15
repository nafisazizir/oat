/**
 * Deterministic "embeddings" for the mock LLM: a feature-hashing bag of words. Each lowercase word (weight 1)
 * and its character trigrams (total weight 0.5 per word, so "meeting" ~ "meetings") are hashed into one of
 * `dimensions` buckets with a hashed ±1 sign, then the vector is L2-normalised. Texts that share words get a
 * high cosine similarity, unrelated texts land near 0, and the same text always gives the same vector, so
 * retrieval tests are meaningful without a real model.
 *
 * Identical copy of `tools/mocks/src/providers/llm/embedding.ts` (the mock container's embeddings), used by the
 * in-process mock embedding model; `provider.int.test.ts` asserts both agree. Change them together. (Copied
 * rather than imported so `@oat/ai` has no runtime dependency on `@oat/mocks`.)
 */
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

/** 32-bit FNV-1a over UTF-16 code units. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function features(text: string): [feature: string, weight: number][] {
  const words =
    text
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  const out: [string, number][] = [];
  for (const word of words) {
    out.push([`w:${word}`, 1]);
    const padded = `#${word}#`;
    const grams: string[] = [];
    for (let i = 0; i + 3 <= padded.length; i++) grams.push(padded.slice(i, i + 3));
    for (const gram of grams) out.push([`g:${gram}`, 0.5 / grams.length]);
  }
  return out;
}

/** Unit-length vector of `dimensions` numbers for `text`. Empty text maps to a fixed basis vector. */
export function hashEmbedding(text: string, dimensions = DEFAULT_EMBEDDING_DIMENSIONS): number[] {
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new RangeError(`dimensions must be a positive integer, got ${dimensions}`);
  }
  const vector = new Array<number>(dimensions).fill(0);
  for (const [feature, weight] of features(text)) {
    const index = fnv1a(feature) % dimensions;
    const sign = (fnv1a(`s:${feature}`) & 1) === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign * weight;
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) {
    vector[0] = 1;
    return vector;
  }
  return vector.map((v) => v / norm);
}
