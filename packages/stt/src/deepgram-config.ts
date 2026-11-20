/**
 * Where Deepgram lives and how we authenticate, selected by env (D-11, docs/DEV.md):
 * `DEEPGRAM_BASE_URL` wins; else `DEEPGRAM_API_KEY` set → real Deepgram; else the Deepgram-compatible mock
 * at `${MOCKS_URL}/stt` (default `http://localhost:14010/stt`, i.e. `ws://localhost:14010/stt/v1/listen`).
 */
export const DEEPGRAM_API_URL = 'https://api.deepgram.com';
export const DEFAULT_MOCKS_URL = 'http://localhost:14010';

export type Env = Readonly<Record<string, string | undefined>>;

export interface DeepgramEndpoints {
  /** Base URL (http/https), e.g. `https://api.deepgram.com` or `http://localhost:14010/stt`. */
  baseUrl: string;
  /** Live transcription websocket, e.g. `wss://api.deepgram.com/v1/listen`. */
  listenUrl: string;
  /** Short-lived token grant, e.g. `https://api.deepgram.com/v1/auth/grant`. */
  grantUrl: string;
  /** `true` when pointing at the local mock (no key configured). */
  mock: boolean;
}

function processEnv(): Env {
  return (globalThis as { process?: { env?: Env } }).process?.env ?? {};
}

export function resolveDeepgramEndpoints(env: Env = processEnv()): DeepgramEndpoints {
  const explicit = env.DEEPGRAM_BASE_URL?.trim();
  const key = env.DEEPGRAM_API_KEY?.trim();
  const mocks = (env.MOCKS_URL?.trim() || DEFAULT_MOCKS_URL).replace(/\/+$/, '');
  const raw = explicit || (key ? DEEPGRAM_API_URL : `${mocks}/stt`);
  const baseUrl = raw.replace(/\/+$/, '').replace(/^ws(s?):/, 'http$1:');
  return {
    baseUrl,
    listenUrl: `${baseUrl.replace(/^http(s?):/, 'ws$1:')}/v1/listen`,
    grantUrl: `${baseUrl}/v1/auth/grant`,
    mock: !explicit && !key,
  };
}

/**
 * Credential for one connection. `bearer` = short-lived token from the grant endpoint (what clients use,
 * D-17); `token` = a Deepgram API key (server-side / smoke tests only).
 */
export interface DeepgramToken {
  token: string;
  scheme?: 'bearer' | 'token';
}

export interface GetTokenOptions {
  /** The provider just rejected the previous token: do not return a cached one. */
  refresh?: boolean;
}

/**
 * Called before every (re)connect. In the desktop app this asks our backend for a short-lived token.
 * After a 401/403 it is called with `{ refresh: true }`.
 */
export type GetDeepgramToken = (options?: GetTokenOptions) => Promise<DeepgramToken>;

export interface GrantTokenSourceOptions {
  grantUrl: string;
  /** API key sent to the grant endpoint (server-side only; the mock accepts none). */
  apiKey?: string;
  /** Requested lifetime. Default: provider default (30 s on Deepgram). */
  ttlSeconds?: number;
  /** Default `globalThis.fetch`. */
  fetch?: typeof fetch;
}

/**
 * `GetDeepgramToken` that calls a Deepgram-style grant endpoint (`POST /v1/auth/grant` →
 * `{ access_token, expires_in }`) and reuses the token until 5 s before it expires, or until called with
 * `{ refresh: true }` (after the provider rejected it).
 */
export function grantTokenSource(options: GrantTokenSourceOptions): GetDeepgramToken {
  const doFetch = options.fetch ?? globalThis.fetch;
  let cached: { token: string; expiresAt: number } | undefined;
  return async (opts) => {
    if (opts?.refresh) cached = undefined;
    if (cached && cached.expiresAt - 5_000 > Date.now()) {
      return { token: cached.token, scheme: 'bearer' };
    }
    const res = await doFetch(options.grantUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.apiKey ? { authorization: `Token ${options.apiKey}` } : {}),
      },
      body: JSON.stringify(
        options.ttlSeconds !== undefined ? { ttl_seconds: options.ttlSeconds } : {},
      ),
    });
    if (!res.ok) throw new Error(`token grant failed: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string' || body.access_token === '') {
      throw new Error('token grant returned no access_token');
    }
    const ttl = typeof body.expires_in === 'number' ? body.expires_in : 30;
    cached = { token: body.access_token, expiresAt: Date.now() + ttl * 1000 };
    return { token: cached.token, scheme: 'bearer' };
  };
}

/** `GetDeepgramToken` for a raw API key (server-side and smoke tests; never ship a key to clients). */
export function apiKeyToken(apiKey: string): GetDeepgramToken {
  return () => Promise.resolve({ token: apiKey, scheme: 'token' });
}

export { buildListenUrl, type ListenParams } from './listen-url.ts';
