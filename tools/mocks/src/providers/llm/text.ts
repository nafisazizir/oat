/** OpenAI chat message as the mock reads it: only roles and text content matter. */
export interface ChatMessage {
  role: string;
  content?: unknown;
}

/** Text of a message: a string, or the `text` parts of a content-part array. */
export function messageText(message: ChatMessage): string {
  const { content } = message;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: unknown) =>
      part !== null &&
      typeof part === 'object' &&
      (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : '',
    )
    .filter(Boolean)
    .join('\n');
}

/** Splits text into trimmed sentences (one per line or `.`/`!`/`?`), dropping list/heading markers. */
export function splitSentences(text: string): string[] {
  return text
    .split(/\r?\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((s) =>
      s
        .replace(/^\s*(?:[-*•>#]+|\d+[.)])\s*/, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((s) => /[\p{L}\p{N}]/u.test(s));
}

const FALLBACK = 'This is a mock response from @oat/mocks.';

/**
 * Deterministic source of prompt-derived strings. Built from the user messages (falling back to every message),
 * so generated output quotes the transcript/notes rather than the instructions. Cycles in order; a fresh pool
 * per request keeps responses reproducible.
 */
export class TextPool {
  readonly sentences: string[];
  #cursor = 0;

  constructor(messages: ChatMessage[]) {
    const fromUsers = messages
      .filter((m) => m.role === 'user')
      .flatMap((m) => splitSentences(messageText(m)));
    const sentences =
      fromUsers.length > 0 ? fromUsers : messages.flatMap((m) => splitSentences(messageText(m)));
    this.sentences = sentences.length > 0 ? sentences : [FALLBACK];
  }

  /** Next sentence, cycling. */
  sentence(): string {
    const s = this.sentences[this.#cursor % this.sentences.length] ?? FALLBACK;
    this.#cursor++;
    return s;
  }

  /** First few words of the next sentence, without trailing punctuation. */
  title(maxWords = 6): string {
    return this.sentence()
      .split(' ')
      .slice(0, maxWords)
      .join(' ')
      .replace(/[\s.,;:!?]+$/, '');
  }

  /** A small non-negative integer that advances with the pool (for picking enum values etc.). */
  tick(): number {
    return this.#cursor++;
  }
}

/** Plain-text reply: up to three sentences from the last user message (else the whole prompt). */
export function textReply(messages: ChatMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const sentences = lastUser ? splitSentences(messageText(lastUser)) : [];
  const pool = sentences.length > 0 ? sentences : new TextPool(messages).sentences;
  return pool.slice(0, 3).join(' ');
}

/** Rough token count (≈4 chars per token), for `usage`. */
export function approxTokens(text: string): number {
  return text.length === 0 ? 0 : Math.max(1, Math.ceil(text.length / 4));
}

/** Splits text into word-sized stream deltas whose concatenation is exactly `text`. */
export function streamPieces(text: string): string[] {
  const pieces: string[] = text.match(/\s*\S+/g) ?? [];
  const rest = text.slice(pieces.join('').length);
  if (rest) pieces.push(rest);
  return pieces;
}
