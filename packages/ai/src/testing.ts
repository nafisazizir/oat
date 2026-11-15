/**
 * In-process test doubles for unit tests (`@oat/ai/testing`): no network, no mocks container. Integration tests
 * use the real provider path against `startMocks()` instead (see `provider.int.test.ts`).
 */
import type {
  EmbeddingModelV4CallOptions,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { simulateReadableStream } from 'ai';
import { MockEmbeddingModelV4, MockLanguageModelV4 } from 'ai/test';
import { hashEmbedding } from './hash-embedding.ts';
import { EMBEDDING_DIMENSIONS } from './models.ts';

export { hashEmbedding } from './hash-embedding.ts';

export interface CreateMockModelOptions {
  /** Replies in call order (generate and stream share the counter); the last one repeats. */
  responses?: string[];
  /** Computes the reply from the call (prompt, response format, …). Wins over `responses`. */
  handler?: (call: LanguageModelV4CallOptions) => string | Promise<string>;
  modelId?: string;
  /** Delay between streamed chunks (default 0). */
  chunkDelayInMs?: number;
}

/** Plain text of a call's prompt (system + messages, text parts only), for handlers. */
export function promptText(call: LanguageModelV4CallOptions): string {
  return call.prompt
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
    )
    .filter(Boolean)
    .join('\n');
}

function usage(input: string, output: string): LanguageModelV4Usage {
  const tokens = (s: string) => Math.ceil(s.length / 4);
  return {
    inputTokens: {
      total: tokens(input),
      noCache: tokens(input),
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: tokens(output), text: tokens(output), reasoning: undefined },
  };
}

/**
 * A `MockLanguageModelV4` that replies with fixed `responses` or a `handler`'s output, for both
 * `generateText` (incl. `Output.object`) and `streamText` (word-sized deltas). For structured output, return JSON text.
 * Inspect calls with `model.doGenerateCalls` / `model.doStreamCalls`.
 */
export function createMockModel(options: CreateMockModelOptions): MockLanguageModelV4 {
  const { responses, handler } = options;
  if (!handler && (!responses || responses.length === 0)) {
    throw new Error('createMockModel needs `responses` (non-empty) or `handler`');
  }
  let calls = 0;
  const reply = async (call: LanguageModelV4CallOptions): Promise<string> => {
    const index = calls++;
    if (handler) return handler(call);
    return responses![Math.min(index, responses!.length - 1)]!;
  };

  return new MockLanguageModelV4({
    provider: 'oat-test',
    modelId: options.modelId ?? 'mock-model',
    doGenerate: async (call): Promise<LanguageModelV4GenerateResult> => {
      const text = await reply(call);
      return {
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: usage(promptText(call), text),
        warnings: [],
      };
    },
    doStream: async (call) => {
      const text = await reply(call);
      const deltas: string[] = text.match(/\s*\S+/g) ?? [];
      const rest = text.slice(deltas.join('').length);
      if (rest) deltas.push(rest);
      const chunks: LanguageModelV4StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'text-1' },
        ...deltas.map((delta): LanguageModelV4StreamPart => ({
          type: 'text-delta',
          id: 'text-1',
          delta,
        })),
        { type: 'text-end', id: 'text-1' },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: undefined },
          usage: usage(promptText(call), text),
        },
      ];
      return {
        stream: simulateReadableStream({ chunks, chunkDelayInMs: options.chunkDelayInMs ?? 0 }),
      };
    },
  });
}

export interface CreateMockEmbeddingModelOptions {
  /** Vector width when the call doesn't ask for one. Default `EMBEDDING_DIMENSIONS`. */
  dimensions?: number;
}

/**
 * Deterministic embedding model: the same feature-hashing vectors as the mock LLM service, so similar texts
 * score higher cosine similarity than unrelated ones, in unit tests too.
 */
export function createMockEmbeddingModel(
  options: CreateMockEmbeddingModelOptions = {},
): MockEmbeddingModelV4 {
  return new MockEmbeddingModelV4({
    provider: 'oat-test',
    modelId: 'mock-embedding',
    maxEmbeddingsPerCall: 2048,
    supportsParallelCalls: true,
    doEmbed: async ({ values, dimensions }: EmbeddingModelV4CallOptions) => ({
      embeddings: values.map((v) =>
        hashEmbedding(v, dimensions ?? options.dimensions ?? EMBEDDING_DIMENSIONS),
      ),
      usage: { tokens: values.reduce((sum, v) => sum + Math.ceil(v.length / 4), 0) },
      warnings: [],
    }),
  });
}
