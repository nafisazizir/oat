import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from '../../app.ts';

const messages = [
  { role: 'system', content: 'Be concise.' },
  {
    role: 'user',
    content: [
      {
        type: 'text',
        text: 'Summarise the call. The launch moves to May. Ana will update the roadmap.',
      },
      { type: 'text', text: 'Pricing stays the same.' },
    ],
  },
];

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const { app } = createApp();
  return app.request(`/llm/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

interface Completion {
  id: string;
  model: string;
  choices: { message: { role: string; content: string }; finish_reason: string }[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

function parseSse(text: string): unknown[] {
  return text
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => frame.slice('data: '.length))
    .map((data) => (data === '[DONE]' ? data : JSON.parse(data)));
}

describe('llm provider', () => {
  it('is mounted and listed at /health', async () => {
    const { app } = createApp();
    const health = (await (await app.request('/health')).json()) as {
      providers: { name: string }[];
    };
    expect(health.providers.map((p) => p.name)).toContain('llm');
  });

  it('GET /v1/models lists the registry model ids', async () => {
    const { app } = createApp();
    const body = (await (await app.request('/llm/v1/models')).json()) as {
      object: string;
      data: { id: string }[];
    };
    expect(body.object).toBe('list');
    expect(body.data.map((m) => m.id)).toContain('anthropic/claude-sonnet-5.5');
  });

  describe('POST /v1/chat/completions', () => {
    it('replies with sentences from the last user message, deterministically', async () => {
      const res = await post('/chat/completions', {
        model: 'anthropic/claude-sonnet-5.5',
        messages,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Completion;
      expect(body.model).toBe('anthropic/claude-sonnet-5.5');
      expect(body.id).toBe('chatcmpl-mock-1');
      expect(body.choices[0]?.message).toEqual({
        role: 'assistant',
        content: 'Summarise the call. The launch moves to May. Ana will update the roadmap.',
      });
      expect(body.choices[0]?.finish_reason).toBe('stop');
      expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens + body.usage.completion_tokens);

      const again = (await (
        await post('/chat/completions', { model: 'm', messages })
      ).json()) as Completion;
      expect(again.choices[0]?.message.content).toBe(body.choices[0]?.message.content);
    });

    it('returns schema-valid JSON for response_format json_schema', async () => {
      const schema = z.object({
        summary: z.string(),
        decisions: z.array(z.string()).min(1),
        confidence: z.number().min(0).max(1),
      });
      const res = await post('/chat/completions', {
        model: 'm',
        messages,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'notes', strict: true, schema: z.toJSONSchema(schema) },
        },
      });
      const body = (await res.json()) as Completion;
      const value = schema.parse(JSON.parse(body.choices[0]?.message.content ?? ''));
      expect(value.decisions).toContain('The launch moves to May.');
    });

    it('returns a JSON object for response_format json_object', async () => {
      const res = await post('/chat/completions', {
        model: 'm',
        messages,
        response_format: { type: 'json_object' },
      });
      const body = (await res.json()) as Completion;
      expect(JSON.parse(body.choices[0]?.message.content ?? '')).toHaveProperty('text');
    });

    it('400s on schemas it cannot satisfy and on bad requests', async () => {
      const bad = await post('/chat/completions', {
        model: 'm',
        messages,
        response_format: { type: 'json_schema', json_schema: { name: 'x', schema: false } },
      });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ error: { type: 'invalid_request_error' } });
      expect((await post('/chat/completions', '{not json')).status).toBe(400);
      expect((await post('/chat/completions', { model: 'm', messages: [] })).status).toBe(400);
    });

    it('streams SSE chunks that add up to the non-stream content, with usage on request', async () => {
      const plain = (await (
        await post('/chat/completions', { model: 'm', messages })
      ).json()) as Completion;
      const res = await post('/chat/completions', {
        model: 'm',
        messages,
        stream: true,
        stream_options: { include_usage: true },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
      const events = parseSse(await res.text());
      expect(events.at(-1)).toBe('[DONE]');
      const chunks = events.slice(0, -1) as {
        choices: { delta: { role?: string; content?: string }; finish_reason: string | null }[];
        usage?: { total_tokens: number };
      }[];
      expect(chunks[0]?.choices[0]?.delta.role).toBe('assistant');
      const content = chunks.map((c) => c.choices[0]?.delta.content ?? '').join('');
      expect(content).toBe(plain.choices[0]?.message.content);
      expect(
        chunks.filter((c) => (c.choices[0]?.delta.content ?? '') !== '').length,
      ).toBeGreaterThan(3);
      expect(chunks.at(-2)?.choices[0]?.finish_reason).toBe('stop');
      expect(chunks.at(-1)?.choices).toEqual([]);
      expect(chunks.at(-1)?.usage?.total_tokens).toBeGreaterThan(0);
    });

    it('omits the usage chunk without stream_options.include_usage', async () => {
      const res = await post('/chat/completions', { model: 'm', messages, stream: true });
      const events = parseSse(await res.text()) as { usage?: unknown }[];
      expect(events.some((e) => typeof e === 'object' && 'usage' in e)).toBe(false);
    });
  });

  describe('scenarios', () => {
    it('error → 500 with an OpenAI-style error, or x-mock-status', async () => {
      const res = await post(
        '/chat/completions',
        { model: 'm', messages },
        { 'x-mock-scenario': 'error' },
      );
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({
        error: { type: 'server_error', code: 'mock_error' },
      });
      const limited = await post(
        '/embeddings',
        { model: 'e', input: 'x' },
        { 'x-mock-scenario': 'error', 'x-mock-status': '429' },
      );
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({ error: { type: 'rate_limit_error' } });
    });

    it('empty → empty content / no embeddings', async () => {
      const res = await post(
        '/chat/completions',
        { model: 'm', messages },
        { 'x-mock-scenario': 'empty' },
      );
      expect(((await res.json()) as Completion).choices[0]?.message.content).toBe('');
      const stream = await post(
        '/chat/completions',
        { model: 'm', messages, stream: true },
        { 'x-mock-scenario': 'empty' },
      );
      expect(parseSse(await stream.text())).toHaveLength(3); // role chunk, finish chunk, [DONE]
      const emb = await post(
        '/embeddings',
        { model: 'e', input: 'x' },
        { 'x-mock-scenario': 'empty' },
      );
      expect(((await emb.json()) as { data: unknown[] }).data).toEqual([]);
    });

    it('slow → delays the response by x-mock-delay-ms', async () => {
      const started = performance.now();
      const res = await post(
        '/chat/completions',
        { model: 'm', messages },
        { 'x-mock-scenario': 'slow', 'x-mock-delay-ms': '80' },
      );
      expect(res.status).toBe(200);
      expect(performance.now() - started).toBeGreaterThanOrEqual(75);
    });

    it('rejects unknown scenarios', async () => {
      const res = await post(
        '/chat/completions',
        { model: 'm', messages },
        { 'x-mock-scenario': 'chaos' },
      );
      expect(res.status).toBe(400);
    });
  });

  describe('POST /v1/embeddings', () => {
    it('returns deterministic unit vectors, 1536 wide by default', async () => {
      const res = await post('/embeddings', {
        model: 'openai/text-embedding-3-small',
        input: ['alpha', 'beta'],
      });
      const body = (await res.json()) as {
        object: string;
        model: string;
        data: { index: number; embedding: number[] }[];
        usage: { prompt_tokens: number };
      };
      expect(body.object).toBe('list');
      expect(body.model).toBe('openai/text-embedding-3-small');
      expect(body.data.map((d) => d.index)).toEqual([0, 1]);
      expect(body.data[0]?.embedding).toHaveLength(1536);
      const again = (await (
        await post('/embeddings', { model: 'x', input: 'alpha' })
      ).json()) as typeof body;
      expect(again.data[0]?.embedding).toEqual(body.data[0]?.embedding);
    });

    it('honours dimensions and base64 encoding', async () => {
      const floats = (await (
        await post('/embeddings', { input: 'hello', dimensions: 8 })
      ).json()) as {
        data: { embedding: number[] }[];
      };
      expect(floats.data[0]?.embedding).toHaveLength(8);
      const b64 = (await (
        await post('/embeddings', { input: 'hello', dimensions: 8, encoding_format: 'base64' })
      ).json()) as { data: { embedding: string }[] };
      const bytes = Buffer.from(b64.data[0]?.embedding ?? '', 'base64');
      const decoded = Array.from(
        new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
      );
      expect(decoded).toHaveLength(8);
      decoded.forEach((v, i) => expect(v).toBeCloseTo(floats.data[0]?.embedding[i] ?? NaN, 6));
    });

    it('validates input', async () => {
      expect((await post('/embeddings', { input: [] })).status).toBe(400);
      expect((await post('/embeddings', { input: [1, 2] })).status).toBe(400);
      expect((await post('/embeddings', { input: 'x', dimensions: 0 })).status).toBe(400);
      expect((await post('/embeddings', { input: 'x', encoding_format: 'hex' })).status).toBe(400);
    });
  });

  it('reset() restarts completion ids', async () => {
    const { app } = createApp();
    const call = async () =>
      (
        (await (
          await app.request('/llm/v1/chat/completions', {
            method: 'POST',
            body: JSON.stringify({ model: 'm', messages }),
          })
        ).json()) as Completion
      ).id;
    expect(await call()).toBe('chatcmpl-mock-1');
    expect(await call()).toBe('chatcmpl-mock-2');
    await app.request('/_reset?provider=llm', { method: 'POST' });
    expect(await call()).toBe('chatcmpl-mock-1');
  });
});
