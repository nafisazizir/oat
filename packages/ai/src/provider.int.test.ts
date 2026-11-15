import { hashEmbedding as serverHashEmbedding, type RunningMocks, startMocks } from '@oat/mocks';
import {
  APICallError,
  cosineSimilarity,
  embed,
  embedMany,
  generateObject,
  generateText,
  Output,
  streamText,
} from 'ai';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_MODELS, EMBEDDING_DIMENSIONS } from './models.ts';
import { type AiClient, createAi, resolveAiBackend } from './provider.ts';
import { hashEmbedding } from './testing.ts';

// The real provider path (createAi → @ai-sdk/openai-compatible → HTTP) against an in-process `startMocks()`,
// so these tests exercise this checkout's `llm` mock with private state (docs/DEV.md "Container vs in-process").

const transcript = [
  'Them: The pilot with Northwind starts on March 3.',
  'Me: We still need a signed data processing agreement.',
  'Them: Legal will send the agreement by Thursday.',
  'Me: Budget for the pilot is capped at twelve thousand dollars.',
].join('\n');

const notesSchema = z.object({
  title: z.string(),
  summary: z.string().min(10),
  sections: z
    .array(z.object({ heading: z.string(), bullets: z.array(z.string()).min(1).max(5) }))
    .min(1)
    .max(4),
  actionItems: z.array(
    z.object({ owner: z.string().nullable(), task: z.string(), due: z.string().optional() }),
  ),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
});

describe('@oat/ai against the mock LLM (in-process)', () => {
  let mocks: RunningMocks;
  let ai: AiClient;
  beforeAll(async () => {
    mocks = await startMocks();
    ai = createAi({ env: { AI_BASE_URL: `${mocks.url}/llm/v1` } });
  });
  afterAll(() => mocks.close());
  beforeEach(() => {
    mocks.log.clear();
  });

  it('generateText returns prompt-derived text and sends the role model id', async () => {
    const { text, usage } = await generateText({
      model: ai.getModel('chat'),
      system: 'Answer briefly.',
      prompt: 'When does the pilot start? The pilot starts on March 3.',
    });
    expect(text).toContain('The pilot starts on March 3.');
    expect(usage.totalTokens).toBeGreaterThan(0);
    const [call] = mocks.log.list({ provider: 'llm' });
    expect(call?.path).toBe('/llm/v1/chat/completions');
    expect(JSON.parse(call?.body ?? '{}')).toMatchObject({ model: DEFAULT_MODELS.chat });
  });

  it('streamText streams over SSE', async () => {
    const result = streamText({ model: ai.getModel('fast'), prompt: transcript });
    const deltas: string[] = [];
    for await (const delta of result.textStream) deltas.push(delta);
    expect(deltas.length).toBeGreaterThan(3);
    expect(deltas.join('')).toBe(await result.text);
    expect(await result.text).toContain('Northwind');
    expect((await result.usage).totalTokens).toBeGreaterThan(0); // include_usage chunk
    const body = JSON.parse(mocks.log.list({ provider: 'llm' })[0]?.body ?? '{}');
    expect(body).toMatchObject({ stream: true, model: DEFAULT_MODELS.fast });
  });

  it('structured output (Output.object) returns a schema-valid object built from the prompt', async () => {
    const { output } = await generateText({
      model: ai.getModel('enhance'),
      output: Output.object({ schema: notesSchema }),
      system: 'Turn the transcript into structured notes.',
      prompt: transcript,
    });
    expect(notesSchema.parse(output).sections.length).toBeGreaterThan(0);
    expect(JSON.stringify(output)).toContain('Northwind');
    const body = JSON.parse(mocks.log.list({ provider: 'llm' })[0]?.body ?? '{}');
    expect(body.response_format).toMatchObject({ type: 'json_schema' });
  });

  it('structured output is deterministic', async () => {
    const run = async () =>
      (
        await generateText({
          model: ai.getModel('enhance'),
          output: Output.object({ schema: notesSchema }),
          prompt: transcript,
        })
      ).output;
    expect(await run()).toEqual(await run());
  });

  it('embed / embedMany: deterministic, EMBEDDING_DIMENSIONS wide, similar > unrelated', async () => {
    const model = ai.getEmbeddingModel();
    const a = await embed({ model, value: 'pilot budget approval' });
    const b = await embed({ model, value: 'pilot budget approval' });
    expect(a.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(a.embedding).toEqual(b.embedding);

    const { embeddings } = await embedMany({
      model,
      values: [
        'Who approved the pilot budget?',
        'Budget for the pilot is capped at twelve thousand dollars.',
        'The office plants need watering on Mondays.',
      ],
    });
    const [query, similar, unrelated] = embeddings as [number[], number[], number[]];
    expect(cosineSimilarity(query, similar)).toBeGreaterThan(cosineSimilarity(query, unrelated));
    const body = JSON.parse(mocks.log.list({ provider: 'llm' }).at(-1)?.body ?? '{}');
    expect(body.model).toBe(DEFAULT_MODELS.embed);
  });

  it('the in-process mock embedding model matches the server (shared algorithm)', async () => {
    const value = 'Legal will send the agreement by Thursday.';
    const { embedding } = await embed({ model: ai.getEmbeddingModel(), value });
    expect(hashEmbedding(value)).toEqual(embedding);
    expect(serverHashEmbedding(value, 64)).toEqual(hashEmbedding(value, 64));
  });

  describe('scenarios (x-mock-scenario)', () => {
    it('error surfaces as an APICallError', async () => {
      const call = generateText({
        model: ai.getModel('chat'),
        prompt: 'x',
        maxRetries: 0,
        headers: { 'x-mock-scenario': 'error', 'x-mock-status': '503' },
      });
      await expect(call).rejects.toSatisfy(
        (err) => APICallError.isInstance(err) && err.statusCode === 503,
      );
    });

    it('error is retried by the SDK when allowed', async () => {
      await expect(
        generateText({
          model: ai.getModel('chat'),
          prompt: 'x',
          maxRetries: 1,
          headers: { 'x-mock-scenario': 'error' },
        }),
      ).rejects.toThrow();
      expect(mocks.log.list({ provider: 'llm' })).toHaveLength(2);
    });

    it('empty gives empty text, and structured output fails to parse', async () => {
      const { text } = await generateText({
        model: ai.getModel('chat'),
        prompt: 'x',
        headers: { 'x-mock-scenario': 'empty' },
      });
      expect(text).toBe('');
      await expect(
        generateText({
          model: ai.getModel('enhance'),
          output: Output.object({ schema: notesSchema }),
          prompt: 'x',
          maxRetries: 0,
          headers: { 'x-mock-scenario': 'empty' },
        }),
      ).rejects.toThrow();
    });

    it('slow can be cut off with an abort signal', async () => {
      const call = generateText({
        model: ai.getModel('chat'),
        prompt: 'x',
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(100),
        headers: { 'x-mock-scenario': 'slow', 'x-mock-delay-ms': '5000' },
      });
      const started = performance.now();
      await expect(call).rejects.toThrow();
      expect(performance.now() - started).toBeLessThan(2_000);
    });
  });
});

// Acceptance #1: with only the `.env` defaults (no key, MOCKS_URL → compose), `generateObject` (kept here as
// the one deprecated-API case) returns a schema-valid object from the shared container. Read-only: no
// `/_reset`. Int tests require `pnpm dev:up`, so an unreachable mock fails the test; it is skipped only when
// the container answers 404 for `/llm` (its image predates the `llm` provider: run `pnpm dev:build` from main)
// or when a real gateway is configured (no real AI calls from tests).
describe('@oat/ai against the mocks container (env defaults)', () => {
  const backend = resolveAiBackend(process.env);

  it('generateObject returns a schema-valid object', async ({ skip }) => {
    if (backend.kind !== 'mock')
      return skip('a real AI Gateway is configured; not calling it from tests');
    const res = await fetch(`${backend.baseURL}/models`, { signal: AbortSignal.timeout(5_000) });
    if (res.status === 404) {
      return skip(
        `mocks container at ${backend.baseURL} has no llm provider yet (image built before 4.1): ` +
          'run `pnpm dev:build` from the main checkout',
      );
    }
    expect(res.status).toBe(200);
    const { object } = await generateObject({
      model: createAi().getModel('enhance'),
      schema: notesSchema,
      prompt: transcript,
    });
    expect(notesSchema.safeParse(object).success).toBe(true);
  });
});
