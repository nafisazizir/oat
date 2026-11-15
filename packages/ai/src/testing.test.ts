import { cosineSimilarity, embed, embedMany, generateText, Output, streamText } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EMBEDDING_DIMENSIONS } from './models.ts';
import { createMockEmbeddingModel, createMockModel, promptText } from './testing.ts';

describe('createMockModel', () => {
  it('replies with responses in order, repeating the last', async () => {
    const model = createMockModel({ responses: ['one', 'two'] });
    const texts = [];
    for (let i = 0; i < 3; i++) texts.push((await generateText({ model, prompt: 'x' })).text);
    expect(texts).toEqual(['one', 'two', 'two']);
    expect(model.doGenerateCalls).toHaveLength(3);
  });

  it('streams the reply as word deltas', async () => {
    const model = createMockModel({ responses: ['Hello there, general Kenobi.'] });
    const result = streamText({ model, prompt: 'x' });
    const deltas: string[] = [];
    for await (const delta of result.textStream) deltas.push(delta);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe('Hello there, general Kenobi.');
    expect(await result.text).toBe('Hello there, general Kenobi.');
  });

  it('computes replies with a handler that sees the prompt', async () => {
    const model = createMockModel({ handler: (call) => `echo: ${promptText(call)}` });
    const { text } = await generateText({ model, system: 'sys', prompt: 'ping' });
    expect(text).toBe('echo: sys\nping');
  });

  it('serves structured output (Output.object)', async () => {
    const schema = z.object({ title: z.string(), points: z.array(z.string()) });
    const model = createMockModel({
      responses: [JSON.stringify({ title: 'T', points: ['a', 'b'] })],
    });
    const { output } = await generateText({
      model,
      output: Output.object({ schema }),
      prompt: 'x',
    });
    expect(output).toEqual({ title: 'T', points: ['a', 'b'] });
  });

  it('requires responses or a handler', () => {
    expect(() => createMockModel({})).toThrow();
    expect(() => createMockModel({ responses: [] })).toThrow();
  });
});

describe('createMockEmbeddingModel', () => {
  const model = createMockEmbeddingModel();

  it('returns deterministic EMBEDDING_DIMENSIONS-wide vectors', async () => {
    const a = await embed({ model, value: 'sprint retro notes' });
    const b = await embed({ model, value: 'sprint retro notes' });
    expect(a.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(a.embedding).toEqual(b.embedding);
    expect(
      (await embed({ model: createMockEmbeddingModel({ dimensions: 16 }), value: 'x' })).embedding,
    ).toHaveLength(16);
  });

  it('ranks similar text above unrelated text', async () => {
    const { embeddings } = await embedMany({
      model,
      values: [
        'hiring plan for the design team',
        'we discussed the design team hiring plan',
        'quarterly tax filing deadline',
      ],
    });
    const [query, similar, unrelated] = embeddings as [number[], number[], number[]];
    expect(cosineSimilarity(query, similar)).toBeGreaterThan(cosineSimilarity(query, unrelated));
  });
});
