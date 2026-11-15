import type { Context } from 'hono';
import { Hono } from 'hono';
import type { MockProvider } from '../../provider.ts';
import { DEFAULT_EMBEDDING_DIMENSIONS, hashEmbedding } from './embedding.ts';
import { generateFromSchema, type JsonSchema, UnsupportedSchemaError } from './json-schema.ts';
import { approxTokens, type ChatMessage, streamPieces, TextPool, textReply } from './text.ts';
import { planToolTurn } from './tools.ts';

/**
 * OpenAI-compatible stand-in for the AI Gateway (D-11, D-13), mounted at `/llm`; clients use base URL
 * `${MOCKS_URL}/llm/v1`. Deterministic: the same request always gets the same content.
 *
 * - `POST /v1/chat/completions`: text replies quote the last user message; `response_format: json_schema`
 *   returns schema-valid JSON whose strings come from the prompt; `json_object` returns `{ "text": … }`.
 *   `stream: true` sends SSE chunks (word-sized deltas, `[DONE]`; a usage chunk with
 *   `stream_options.include_usage`). With `tools`, a scripted tool loop (`tools.ts`): first a tool call (the
 *   first tool taking a string `query`, or `mock:tool <name> <json>`), then an answer that quotes and cites the
 *   tool results.
 * - `POST /v1/embeddings`: feature-hashed unit vectors (see `embedding.ts`); `dimensions` honoured, default 1536.
 * - `GET /v1/models`: the model ids the app's registry uses (any model id is accepted).
 *
 * Scenario headers (resilience tests), on every POST route:
 * - `x-mock-scenario: error` → HTTP `x-mock-status` (default 500) with an OpenAI-style error body.
 * - `x-mock-scenario: slow` → waits `x-mock-delay-ms` (default 1000, max 30000) before responding.
 * - `x-mock-scenario: empty` → empty content (chat) / empty `data` (embeddings).
 * - `x-mock-chunk-delay-ms` → pause between SSE chunks (default 0, max 5000).
 */

export const MOCK_LLM_MODELS = [
  'anthropic/claude-sonnet-5.5',
  'anthropic/claude-haiku-5.5',
  'openai/text-embedding-3-small',
] as const;

const SCENARIOS = new Set(['error', 'slow', 'empty']);
const MAX_EMBEDDING_INPUTS = 2048;

type Scenario = 'error' | 'slow' | 'empty' | undefined;

function apiError(
  c: Context,
  status: number,
  message: string,
  type = 'invalid_request_error',
  code?: string,
) {
  return c.json({ error: { message, type, param: null, code: code ?? null } }, status as 400);
}

function intHeader(c: Context, name: string, fallback: number, max: number): number {
  const raw = c.req.header(name);
  const n = raw === undefined ? fallback : Number(raw);
  return Number.isFinite(n) ? Math.min(Math.max(0, Math.floor(n)), max) : fallback;
}

/** Resolves after `ms`, or early when the client goes away. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

async function readJson(c: Context): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await c.req.json();
    return body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function llmProvider(): MockProvider {
  let nextId = 1;
  const app = new Hono();

  /** Applies the scenario header. Returns a Response to short-circuit, or the scenario to continue with. */
  async function scenario(c: Context): Promise<Response | Scenario> {
    const name = c.req.header('x-mock-scenario');
    if (name === undefined || name === '') return undefined;
    if (!SCENARIOS.has(name)) {
      return apiError(c, 400, `unknown x-mock-scenario "${name}" (expected error|slow|empty)`);
    }
    if (name === 'error') {
      const status = intHeader(c, 'x-mock-status', 500, 599);
      return apiError(
        c,
        status >= 400 ? status : 500,
        'Mock scenario: error',
        status === 429 ? 'rate_limit_error' : 'server_error',
        'mock_error',
      );
    }
    if (name === 'slow')
      await sleep(intHeader(c, 'x-mock-delay-ms', 1000, 30_000), c.req.raw.signal);
    return name as Scenario;
  }

  app.get('/v1/models', (c) =>
    c.json({
      object: 'list',
      data: MOCK_LLM_MODELS.map((id) => ({
        id,
        object: 'model',
        created: 0,
        owned_by: 'oat-mocks',
      })),
    }),
  );

  app.post('/v1/chat/completions', async (c) => {
    const body = await readJson(c);
    if (!body) return apiError(c, 400, 'request body must be a JSON object');
    const { messages, response_format: format } = body as {
      messages?: unknown;
      response_format?: { type?: string; json_schema?: { schema?: JsonSchema } };
    };
    const toolsOffered = body.tools;
    if (!Array.isArray(messages) || messages.length === 0) {
      return apiError(c, 400, '`messages` must be a non-empty array');
    }
    const msgs = messages.filter(
      (m): m is ChatMessage =>
        m !== null && typeof m === 'object' && typeof (m as ChatMessage).role === 'string',
    );
    const model = typeof body.model === 'string' ? body.model : 'mock-model';

    const outcome = await scenario(c);
    if (outcome instanceof Response) return outcome;

    let content = '';
    let toolCall: { id: string; name: string; arguments: string } | undefined;
    const plan =
      outcome === 'empty' || format?.type === 'json_schema' || format?.type === 'json_object'
        ? undefined
        : planToolTurn(msgs, toolsOffered, body.tool_choice);
    if (plan?.kind === 'call') {
      toolCall = { id: `call_mock_${nextId}`, name: plan.name, arguments: plan.arguments };
    } else if (plan?.kind === 'answer') {
      content = plan.content;
    } else if (outcome !== 'empty') {
      if (format?.type === 'json_schema') {
        const schema = format.json_schema?.schema;
        if (schema === undefined)
          return apiError(c, 400, '`response_format.json_schema.schema` is required');
        try {
          content = JSON.stringify(generateFromSchema(schema, new TextPool(msgs)));
        } catch (err) {
          if (err instanceof UnsupportedSchemaError)
            return apiError(c, 400, `mock cannot satisfy schema: ${err.message}`);
          throw err;
        }
      } else if (format?.type === 'json_object') {
        content = JSON.stringify({ text: textReply(msgs) });
      } else {
        content = textReply(msgs);
      }
    }

    const id = `chatcmpl-mock-${nextId++}`;
    const created = Math.floor(Date.now() / 1000);
    const promptTokens = approxTokens(msgs.map((m) => JSON.stringify(m.content ?? '')).join(''));
    const completionTokens = approxTokens(content + (toolCall?.arguments ?? ''));
    const finishReason = toolCall ? 'tool_calls' : 'stop';
    const toolCalls = toolCall
      ? [
          {
            id: toolCall.id,
            type: 'function',
            function: { name: toolCall.name, arguments: toolCall.arguments },
          },
        ]
      : undefined;
    const usage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    };

    if (body.stream !== true) {
      return c.json({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [
          {
            index: 0,
            message: toolCalls
              ? { role: 'assistant', content: null, tool_calls: toolCalls }
              : { role: 'assistant', content },
            finish_reason: finishReason,
          },
        ],
        usage,
      });
    }

    const includeUsage =
      (body.stream_options as { include_usage?: unknown } | undefined)?.include_usage === true;
    const chunkDelay = intHeader(c, 'x-mock-chunk-delay-ms', 0, 5_000);
    const signal = c.req.raw.signal;
    const chunk = (delta: object, finish: string | null = null) => ({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (data: unknown) =>
          controller.enqueue(
            encoder.encode(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`),
          );
        send(chunk({ role: 'assistant', content: '' }));
        if (toolCalls) {
          await sleep(chunkDelay, signal);
          send(chunk({ tool_calls: toolCalls.map((call, index) => ({ index, ...call })) }));
        }
        for (const piece of streamPieces(content)) {
          await sleep(chunkDelay, signal);
          if (signal.aborted) break;
          send(chunk({ content: piece }));
        }
        if (!signal.aborted) {
          send(chunk({}, finishReason));
          if (includeUsage)
            send({ id, object: 'chat.completion.chunk', created, model, choices: [], usage });
          send('[DONE]');
        }
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
  });

  app.post('/v1/embeddings', async (c) => {
    const body = await readJson(c);
    if (!body) return apiError(c, 400, 'request body must be a JSON object');
    const { input, dimensions, encoding_format: encoding } = body;
    const inputs = typeof input === 'string' ? [input] : input;
    if (
      !Array.isArray(inputs) ||
      inputs.length === 0 ||
      !inputs.every((v) => typeof v === 'string')
    ) {
      return apiError(c, 400, '`input` must be a string or a non-empty array of strings');
    }
    if (inputs.length > MAX_EMBEDDING_INPUTS) {
      return apiError(c, 400, `at most ${MAX_EMBEDDING_INPUTS} inputs per request`);
    }
    const dims = dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
    if (typeof dims !== 'number' || !Number.isInteger(dims) || dims < 1 || dims > 8192) {
      return apiError(c, 400, '`dimensions` must be an integer between 1 and 8192');
    }
    if (encoding !== undefined && encoding !== 'float' && encoding !== 'base64') {
      return apiError(c, 400, '`encoding_format` must be "float" or "base64"');
    }

    const outcome = await scenario(c);
    if (outcome instanceof Response) return outcome;

    const tokens = inputs.reduce((sum, text) => sum + approxTokens(text), 0);
    const data =
      outcome === 'empty'
        ? []
        : inputs.map((text, index) => {
            const vector = hashEmbedding(text, dims);
            const embedding =
              encoding === 'base64'
                ? Buffer.from(new Float32Array(vector).buffer).toString('base64')
                : vector;
            return { object: 'embedding', index, embedding };
          });
    return c.json({
      object: 'list',
      data,
      model: typeof body.model === 'string' ? body.model : 'mock-embedding',
      usage: { prompt_tokens: tokens, total_tokens: tokens },
    });
  });

  return {
    name: 'llm',
    description:
      'OpenAI-compatible chat completions + embeddings (stands in for Vercel AI Gateway).',
    app,
    reset: () => {
      nextId = 1;
    },
  };
}
