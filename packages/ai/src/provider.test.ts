import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { embed, generateText } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODELS } from './models.ts';
import {
  AiConfigError,
  createAi,
  DEFAULT_AI_BASE_URL,
  getEmbeddingModel,
  getModel,
  resolveAiBackend,
} from './provider.ts';

// No network: every request goes through a recording fetch that answers with an error.
function recordingFetch() {
  const requests: { url: string; headers: Headers; body: string }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, headers: request.headers, body: await request.text() });
    return new Response(
      JSON.stringify({ error: { message: 'offline test', type: 'authentication_error' } }),
      {
        status: 401,
        headers: { 'content-type': 'application/json' },
      },
    );
  };
  return { fetch, requests };
}

describe('resolveAiBackend', () => {
  it('defaults to the compose mock', () => {
    expect(resolveAiBackend({})).toEqual({ kind: 'mock', baseURL: DEFAULT_AI_BASE_URL });
    expect(DEFAULT_AI_BASE_URL).toBe('http://localhost:14010/llm/v1');
  });

  it('selects the mock with the .env.example defaults', () => {
    const env = parseEnv(readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8'));
    expect(resolveAiBackend(env)).toEqual({
      kind: 'mock',
      baseURL: 'http://localhost:14010/llm/v1',
    });
  });

  it('derives the mock URL from MOCKS_URL, AI_BASE_URL wins, blanks are ignored', () => {
    expect(resolveAiBackend({ MOCKS_URL: 'http://127.0.0.1:5000/' })).toEqual({
      kind: 'mock',
      baseURL: 'http://127.0.0.1:5000/llm/v1',
    });
    expect(
      resolveAiBackend({
        MOCKS_URL: 'http://127.0.0.1:5000',
        AI_BASE_URL: 'http://llm.test/v1/',
        AI_GATEWAY_API_KEY: '',
      }),
    ).toEqual({ kind: 'mock', baseURL: 'http://llm.test/v1' });
  });

  it('switches to AI Gateway when AI_GATEWAY_API_KEY is set, without exposing the key', () => {
    const backend = resolveAiBackend({ AI_GATEWAY_API_KEY: 'k', AI_BASE_URL: 'http://ignored' });
    expect(backend).toEqual({ kind: 'gateway', auth: 'api-key' });
    expect(JSON.stringify(backend)).not.toContain('"k"');
    expect(
      resolveAiBackend({ AI_GATEWAY_API_KEY: 'k', AI_GATEWAY_BASE_URL: 'https://gw.test/v4/ai/' }),
    ).toEqual({ kind: 'gateway', auth: 'api-key', baseURL: 'https://gw.test/v4/ai' });
  });

  it('uses AI Gateway with Vercel OIDC on Vercel or with VERCEL_OIDC_TOKEN (key wins)', () => {
    expect(resolveAiBackend({ VERCEL: '1', NODE_ENV: 'production' })).toEqual({
      kind: 'gateway',
      auth: 'oidc',
    });
    expect(resolveAiBackend({ VERCEL_OIDC_TOKEN: 'jwt' })).toEqual({
      kind: 'gateway',
      auth: 'oidc',
    });
    expect(resolveAiBackend({ VERCEL_OIDC_TOKEN: 'jwt', AI_GATEWAY_API_KEY: 'k' })).toMatchObject({
      auth: 'api-key',
    });
  });

  it('refuses to fall back to the localhost mock in production', () => {
    expect(() => resolveAiBackend({ NODE_ENV: 'production' })).toThrow(AiConfigError);
    expect(() => createAi({ env: { NODE_ENV: 'production', AI_GATEWAY_API_KEY: ' ' } })).toThrow(
      /AI_GATEWAY_API_KEY/,
    );
    // An explicitly configured endpoint is a deliberate choice (e.g. e2e against `next start`).
    expect(resolveAiBackend({ NODE_ENV: 'production', AI_BASE_URL: 'http://llm.test/v1' })).toEqual(
      {
        kind: 'mock',
        baseURL: 'http://llm.test/v1',
      },
    );
    expect(
      resolveAiBackend({ NODE_ENV: 'production', MOCKS_URL: 'http://localhost:14010' }),
    ).toMatchObject({ kind: 'mock' });
  });
});

describe('createAi', () => {
  it('serves roles from the OpenAI-compatible mock by default', async () => {
    const { fetch, requests } = recordingFetch();
    const ai = createAi({ env: {}, fetch });
    const model = ai.getModel('enhance');
    expect(model.provider).toBe('oat-mock.chat');
    expect(model.modelId).toBe(DEFAULT_MODELS.enhance);
    expect(ai.getEmbeddingModel().modelId).toBe(DEFAULT_MODELS.embed);

    await expect(generateText({ model, prompt: 'hi', maxRetries: 0 })).rejects.toThrow();
    expect(requests[0]?.url).toBe('http://localhost:14010/llm/v1/chat/completions');
    expect(requests[0]?.headers.get('authorization')).toBeNull();
    expect(JSON.parse(requests[0]?.body ?? '{}')).toMatchObject({ model: DEFAULT_MODELS.enhance });
  });

  it('uses AI Gateway with the key when AI_GATEWAY_API_KEY is set', async () => {
    const { fetch, requests } = recordingFetch();
    const ai = createAi({
      env: { AI_GATEWAY_API_KEY: 'test-key', AI_MODEL_FAST: 'anthropic/claude-haiku-4.5' },
      fetch,
    });
    expect(ai.backend.kind).toBe('gateway');
    const model = ai.getModel('fast');
    expect(model.provider).toBe('gateway');
    expect(model.modelId).toBe('anthropic/claude-haiku-4.5');

    await expect(generateText({ model, prompt: 'hi', maxRetries: 0 })).rejects.toThrow();
    const url = new URL(requests[0]?.url ?? '');
    expect(url.origin).toBe('https://ai-gateway.vercel.sh');
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer test-key');

    await expect(
      embed({ model: ai.getEmbeddingModel(), value: 'x', maxRetries: 0 }),
    ).rejects.toThrow();
    expect(requests.at(-1)?.url).toMatch(/^https:\/\/ai-gateway\.vercel\.sh\//);
  });

  it('honours AI_GATEWAY_BASE_URL', async () => {
    const { fetch, requests } = recordingFetch();
    const ai = createAi({
      env: { AI_GATEWAY_API_KEY: 'k', AI_GATEWAY_BASE_URL: 'https://gw.test/v4/ai' },
      fetch,
    });
    await expect(
      generateText({ model: ai.getModel('chat'), prompt: 'hi', maxRetries: 0 }),
    ).rejects.toThrow();
    expect(requests[0]?.url).toMatch(/^https:\/\/gw\.test\/v4\/ai\//);
  });

  it('builds an OIDC gateway client without a key (the provider resolves the token per request)', () => {
    const ai = createAi({ env: { VERCEL: '1' } });
    expect(ai.backend).toEqual({ kind: 'gateway', auth: 'oidc' });
    expect(ai.getModel('chat').provider).toBe('gateway');
  });

  it('refuses the embed role (and unknown roles) for language models', () => {
    const ai = createAi({ env: {} });
    expect(() => ai.getModel('embed' as 'chat')).toThrow(/getEmbeddingModel/);
    expect(() => ai.getModel('nope' as 'chat')).toThrow(/unknown AI role/);
  });
});

describe('getModel / getEmbeddingModel (process.env)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('follows process.env, including changes after the first call', () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    vi.stubEnv('AI_MODEL_CHAT', '');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('VERCEL_OIDC_TOKEN', '');
    expect(getModel('chat').provider).toBe('oat-mock.chat');
    vi.stubEnv('AI_GATEWAY_API_KEY', 'k');
    vi.stubEnv('AI_MODEL_CHAT', 'anthropic/claude-opus-5.5');
    const model = getModel('chat');
    expect(model.provider).toBe('gateway');
    expect(model.modelId).toBe('anthropic/claude-opus-5.5');
    expect(getEmbeddingModel().provider).toBe('gateway');
  });
});
