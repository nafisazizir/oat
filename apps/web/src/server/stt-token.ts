import { type Env, resolveDeepgramEndpoints } from '@oat/stt/deepgram-config';

import type { SttTokenResponse } from '@/lib/api-types';

import { ApiError, errorResponse, toApiError, unauthorized } from './api/errors';
import { isTrustedWrite } from './api/route';

/*
 * `POST /api/stt/token` (task 2.5, D-17): the desktop never holds a long-lived STT key. A signed-in client
 * (cookie or `Authorization: Bearer`) gets a short-lived token from the provider's grant endpoint plus the
 * live websocket URL it is valid for:
 *   - `DEEPGRAM_API_KEY` set → real Deepgram (`POST https://api.deepgram.com/v1/auth/grant`, key server-side);
 *   - otherwise the Deepgram-compatible mock at `${MOCKS_URL}/stt` (dev, tests; D-11).
 * Each call asks the provider for a fresh token: tokens are never cached or shared between users.
 *
 *   200 { accessToken, expiresIn, listenUrl, keyterms } · 401 no session · 403 cross-site cookie request
 *   · 503 stt_unavailable (no provider configured in production, or the grant failed)
 */

/** Requested lifetime. Tokens are only needed to open a connection (reconnects ask again). */
export const STT_TOKEN_TTL_SECONDS = 60;
const GRANT_TIMEOUT_MS = 5_000;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export type SttTokenDeps = {
  /** Better Auth session lookup (cookie or bearer). */
  getSession(headers: Headers): Promise<{ user: { id: string } } | null>;
  allowedOrigins(): readonly string[];
  /** `process.env` (DEEPGRAM_API_KEY, DEEPGRAM_BASE_URL, MOCKS_URL, NODE_ENV). */
  env(): Env;
  fetch?: typeof globalThis.fetch;
  onError?: (message: string, error?: unknown) => void;
  /**
   * The user's "About me" vocabulary, offered to the client as STT keyterms (4.6, D-17). Best effort: a
   * failure here never costs the user their token.
   */
  keyterms?: (userId: string) => Promise<string[]>;
};

/**
 * Keyterm budget: each term becomes a `keyterm=` query parameter on the live websocket URL, and Deepgram caps
 * keyterm prompting (~500 tokens), so a long profile vocabulary must not break the connection.
 */
export const KEYTERM_LIMITS = { terms: 50, termChars: 40, queryBytes: 2048 } as const;

/** The first terms that fit the budget (over-long terms skipped, duplicates dropped, order kept). */
export function capKeyterms(terms: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const raw of terms) {
    const term = raw.replace(/\s+/g, ' ').trim();
    const key = term.toLowerCase();
    if (!term || term.length > KEYTERM_LIMITS.termChars || seen.has(key)) continue;
    const cost = `&keyterm=${encodeURIComponent(term)}`.length;
    if (bytes + cost > KEYTERM_LIMITS.queryBytes) break;
    seen.add(key);
    out.push(term);
    bytes += cost;
    if (out.length === KEYTERM_LIMITS.terms) break;
  }
  return out;
}

const unavailable = () =>
  new ApiError(503, 'stt_unavailable', 'Live transcription is unavailable right now.');

export function createSttTokenRoute(deps: SttTokenDeps): (request: Request) => Promise<Response> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const onError = deps.onError ?? ((message, error) => console.error(message, error ?? ''));
  return async (request) => {
    try {
      if (!isTrustedWrite(request, deps.allowedOrigins())) {
        throw new ApiError(403, 'cross_site', 'Cross-site request refused.');
      }
      const session = await deps.getSession(request.headers);
      if (!session) throw unauthorized();

      const env = deps.env();
      const endpoints = resolveDeepgramEndpoints(env);
      // A production server without a key must not hand out the local mock (unless it really is local,
      // as in `pnpm dev:app`), the way `@oat/ai` refuses to fall back to localhost.
      if (
        env.NODE_ENV === 'production' &&
        endpoints.mock &&
        !LOOPBACK.has(new URL(endpoints.baseUrl).hostname)
      ) {
        onError('stt-token: no DEEPGRAM_API_KEY in production');
        throw unavailable();
      }
      const apiKey = env.DEEPGRAM_API_KEY?.trim();
      let res: Response;
      try {
        res = await doFetch(endpoints.grantUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey ? { authorization: `Token ${apiKey}` } : {}),
          },
          body: JSON.stringify({ ttl_seconds: STT_TOKEN_TTL_SECONDS }),
          redirect: 'error',
          signal: AbortSignal.timeout(GRANT_TIMEOUT_MS),
        });
      } catch (error) {
        onError('stt-token: grant request failed', error);
        throw unavailable();
      }
      if (!res.ok) {
        onError(`stt-token: grant answered HTTP ${res.status}`);
        throw unavailable();
      }
      const body = (await res.json().catch(() => null)) as {
        access_token?: unknown;
        expires_in?: unknown;
      } | null;
      if (typeof body?.access_token !== 'string' || body.access_token === '') {
        onError('stt-token: grant returned no access_token');
        throw unavailable();
      }
      const expiresIn =
        typeof body.expires_in === 'number' && body.expires_in > 0
          ? body.expires_in
          : STT_TOKEN_TTL_SECONDS;
      let keyterms: string[] = [];
      if (deps.keyterms) {
        try {
          keyterms = capKeyterms(await deps.keyterms(session.user.id));
        } catch (error) {
          onError('stt-token: could not read the profile vocabulary', error);
        }
      }
      const payload: SttTokenResponse = {
        accessToken: body.access_token,
        expiresIn,
        listenUrl: endpoints.listenUrl,
        keyterms,
      };
      return Response.json(payload, { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      const apiError = toApiError(error);
      if (apiError) return errorResponse(apiError);
      throw error;
    }
  };
}
