/** Small text helpers shared by the chunkers. */
import { createHash } from 'node:crypto';

/**
 * Rough token estimate (≈ 4 characters per token for English with BPE tokenizers). Only used to size chunks
 * and budget context, never to bill, so a cheap estimate beats shipping a tokenizer.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Splits text that is too long for one chunk into pieces of at most `maxTokens` (estimated), preferring
 * sentence boundaries, then whitespace, then a hard cut. Pieces are trimmed and never empty.
 */
export function splitLongText(text: string, maxTokens: number): string[] {
  const maxChars = Math.max(1, maxTokens * 4);
  const sentences = text.split(/(?<=[.!?…])\s+|\n+/u).filter((s) => s.trim() !== '');
  const pieces: string[] = [];
  let current = '';
  const push = () => {
    if (current.trim()) pieces.push(current.trim());
    current = '';
  };
  for (const sentence of sentences) {
    for (const part of hardWrap(sentence.trim(), maxChars)) {
      if (current && current.length + 1 + part.length > maxChars) push();
      current = current ? `${current} ${part}` : part;
    }
  }
  push();
  return pieces;
}

/** Cuts one sentence into ≤ maxChars parts at whitespace when possible. */
function hardWrap(sentence: string, maxChars: number): string[] {
  if (sentence.length <= maxChars) return [sentence];
  const parts: string[] = [];
  let rest = sentence;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(' ', maxChars);
    if (cut <= 0) cut = maxChars;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * Identity of a chunk's embedding: the model that embeds it plus the exact text. Same hash on re-index →
 * the stored embedding is reused; a model change re-embeds everything.
 */
export function chunkHash(modelKey: string, text: string): string {
  return createHash('sha256').update(modelKey).update('\0').update(text).digest('hex');
}
