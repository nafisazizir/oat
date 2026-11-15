import { createHash } from 'node:crypto';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { EmbeddingModelV4, LanguageModelV4 } from '@ai-sdk/provider';
import { createGateway } from 'ai';
import { type AiEnv, type AiRole, isAiRole, type LanguageRole, resolveModels } from './models.ts';

/**
 * The one place that decides which backend serves AI calls (D-3, D-11, D-13), in this order:
 *
 * 1. `AI_GATEWAY_API_KEY` set → Vercel AI Gateway with that key (`AI_GATEWAY_BASE_URL` overrides its URL).
 * 2. `VERCEL_OIDC_TOKEN` or `VERCEL` set → AI Gateway with Vercel OIDC. The gateway provider resolves the token
 *    per request (`@vercel/oidc`: env in builds/`vercel env pull`, request header in Vercel Functions), so
 *    a missing token surfaces as a gateway authentication error, never as a silent fallback.
 * 3. Otherwise → the OpenAI-compatible mock LLM at `AI_BASE_URL`, else `${MOCKS_URL}/llm/v1`, else
 *    `http://localhost:14010/llm/v1` (the compose `mocks` service). With `NODE_ENV=production` and none of
 *    those set, `AiConfigError` is thrown instead of quietly pointing production at localhost.
 *
 * Blank variables count as unset, so `.env.example` as-is selects the mock. Code never branches on the
 * backend: it asks for a role (`getModel('enhance')`) and passes the model to the AI SDK.
 */

export const DEFAULT_AI_BASE_URL = 'http://localhost:14010/llm/v1';

/** Where AI calls go. Holds no secrets (the key stays inside the client), so it is safe to log. */
export type AiBackend =
  | { kind: 'gateway'; auth: 'api-key' | 'oidc'; baseURL?: string }
  | { kind: 'mock'; baseURL: string };

export class AiConfigError extends Error {
  override name = 'AiConfigError';
}

export interface AiClient {
  readonly backend: AiBackend;
  /** Role → model id in effect (defaults merged with `AI_MODEL_<ROLE>` overrides). */
  readonly models: Readonly<Record<AiRole, string>>;
  getModel(role: LanguageRole): LanguageModelV4;
  getEmbeddingModel(): EmbeddingModelV4;
}

export interface CreateAiOptions {
  /** Defaults to `process.env`. */
  env?: AiEnv;
  /** Custom fetch for the provider (tests). */
  fetch?: typeof globalThis.fetch;
}

const value = (env: AiEnv, name: string) => env[name]?.trim() || undefined;
const trimSlash = (url: string) => url.replace(/\/+$/, '');

export function resolveAiBackend(env: AiEnv = process.env): AiBackend {
  const auth = value(env, 'AI_GATEWAY_API_KEY')
    ? 'api-key'
    : value(env, 'VERCEL_OIDC_TOKEN') || value(env, 'VERCEL')
      ? 'oidc'
      : undefined;
  if (auth) {
    const baseURL = value(env, 'AI_GATEWAY_BASE_URL');
    return baseURL
      ? { kind: 'gateway', auth, baseURL: trimSlash(baseURL) }
      : { kind: 'gateway', auth };
  }
  const explicit = value(env, 'AI_BASE_URL');
  const mocks = value(env, 'MOCKS_URL');
  if (!explicit && !mocks && value(env, 'NODE_ENV') === 'production') {
    throw new AiConfigError(
      'No AI backend configured for production: set AI_GATEWAY_API_KEY (or run on Vercel with OIDC), ' +
        'or set AI_BASE_URL to use an OpenAI-compatible endpoint explicitly.',
    );
  }
  const baseURL = explicit ?? (mocks ? `${trimSlash(mocks)}/llm/v1` : DEFAULT_AI_BASE_URL);
  return { kind: 'mock', baseURL: trimSlash(baseURL) };
}

export function createAi(options: CreateAiOptions = {}): AiClient {
  const env = options.env ?? process.env;
  const backend = resolveAiBackend(env);
  const models = Object.freeze(resolveModels(env));

  let language: (id: string) => LanguageModelV4;
  let embedding: (id: string) => EmbeddingModelV4;
  if (backend.kind === 'gateway') {
    // The key only lives in this closure. Without one (OIDC), the provider resolves the Vercel OIDC token.
    const gateway = createGateway({
      apiKey: backend.auth === 'api-key' ? value(env, 'AI_GATEWAY_API_KEY') : undefined,
      baseURL: backend.baseURL,
      fetch: options.fetch,
    });
    language = (id) => gateway.languageModel(id);
    embedding = (id) => gateway.embeddingModel(id);
  } else {
    // Dev/e2e only (mock backend): `AI_MOCK_CHUNK_DELAY_MS` slows the mock's streams down, to watch or test
    // streaming UIs (the mock's `x-mock-chunk-delay-ms` scenario header).
    const chunkDelay = Math.min(
      5000,
      Math.round(Number(value(env, 'AI_MOCK_CHUNK_DELAY_MS')) || 0),
    );
    const mock = createOpenAICompatible({
      name: 'oat-mock',
      baseURL: backend.baseURL,
      // The mock implements `response_format: json_schema`, so structured output takes the same path as a
      // real structured-output provider.
      supportsStructuredOutputs: true,
      includeUsage: true,
      fetch: options.fetch,
      ...(chunkDelay > 0 ? { headers: { 'x-mock-chunk-delay-ms': String(chunkDelay) } } : {}),
    });
    language = (id) => mock.chatModel(id);
    embedding = (id) => mock.embeddingModel(id);
  }

  return {
    backend,
    models,
    getModel(role) {
      // Guards untyped callers: `embed` is not a language model, anything else is not a role.
      if ((role as string) === 'embed')
        throw new Error('use getEmbeddingModel() for the embed role');
      if (!isAiRole(role)) throw new Error(`unknown AI role "${String(role)}"`);
      return language(models[role]);
    },
    getEmbeddingModel: () => embedding(models.embed),
  };
}

let cached: { key: string; client: AiClient } | undefined;

/** Variables that affect backend/model selection; a change rebuilds the process-wide client. */
const SELECTION_VARS = (name: string) =>
  name.startsWith('AI_') || ['MOCKS_URL', 'VERCEL', 'NODE_ENV'].includes(name);

/** Process-wide client for `process.env`; rebuilt when the relevant variables change (cheap to call). */
export function getAi(): AiClient {
  const env = process.env;
  const selection = Object.entries(env)
    .filter(([name]) => SELECTION_VARS(name))
    .sort(([a], [b]) => a.localeCompare(b));
  // Hashed so the cache key never holds the API key itself; the OIDC token rotates, so only its presence counts.
  const key = createHash('sha256')
    .update(JSON.stringify([selection, Boolean(value(env, 'VERCEL_OIDC_TOKEN'))]))
    .digest('hex');
  if (cached?.key !== key) cached = { key, client: createAi({ env }) };
  return cached.client;
}

/** Language model for a role, from `process.env`. */
export function getModel(role: LanguageRole): LanguageModelV4 {
  return getAi().getModel(role);
}

/** The embedding model (`embed` role), from `process.env`. Vectors are `EMBEDDING_DIMENSIONS` wide. */
export function getEmbeddingModel(): EmbeddingModelV4 {
  return getAi().getEmbeddingModel();
}
