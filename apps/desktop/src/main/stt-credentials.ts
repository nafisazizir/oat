/**
 * Live-transcription credentials for the desktop (2.5, D-17): the app never holds a provider key. Before
 * each (re)connect `@oat/stt` asks `getToken()`, which returns a cached short-lived token from our API
 * (`POST /api/stt/token`, bearer session) or fetches a new one. The API also says which websocket the
 * token is for (`listenUrl`): the mock in dev, Deepgram in prod, so the two can never disagree.
 */
import type { DeepgramToken, GetTokenOptions } from '@oat/stt/deepgram-config';

export interface SttGrant {
  accessToken: string;
  expiresIn: number;
  listenUrl: string;
}

export interface SttCredentialsOptions {
  /** Calls the API (`auth.sttToken()`); rejects when signed out or the API/provider is down. */
  fetchGrant: () => Promise<SttGrant>;
  now?: () => number;
}

/** Reuse a token until this long before it expires (connection setup must finish before expiry). */
const EXPIRY_MARGIN_MS = 10_000;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export class SttConfigError extends Error {
  override name = 'SttConfigError';
}

/** `wss:` anywhere, `ws:` only on loopback (the dev mock). Returns the normalised URL. */
export function checkListenUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SttConfigError('transcription URL is not a URL');
  }
  const ok = url.protocol === 'wss:' || (url.protocol === 'ws:' && LOOPBACK.has(url.hostname));
  if (!ok) throw new SttConfigError('transcription URL must be wss:// (ws:// only for localhost)');
  if (url.username || url.password)
    throw new SttConfigError('transcription URL must not carry credentials');
  return url.toString();
}

export class SttCredentials {
  readonly #fetchGrant: () => Promise<SttGrant>;
  readonly #now: () => number;
  #cached: { token: string; expiresAt: number; listenUrl: string } | undefined;
  #inflight: Promise<SttGrant> | undefined;
  #generation = 0;

  constructor(options: SttCredentialsOptions) {
    this.#fetchGrant = options.fetchGrant;
    this.#now = options.now ?? Date.now;
  }

  /** `GetDeepgramToken` for `DeepgramProvider`. `{ refresh: true }` (token rejected) skips the cache. */
  readonly getToken = async (options?: GetTokenOptions): Promise<DeepgramToken> => {
    if (options?.refresh) this.#cached = undefined;
    const cached = this.#cached;
    if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > this.#now()) {
      return { token: cached.token, scheme: 'bearer' };
    }
    const grant = await this.#fetch();
    return { token: grant.accessToken, scheme: 'bearer' };
  };

  /** Fetches (or reuses) a token and returns the websocket URL it is valid for. */
  async listenUrl(): Promise<string> {
    if (this.#cached && this.#cached.expiresAt - EXPIRY_MARGIN_MS > this.#now()) {
      return this.#cached.listenUrl;
    }
    return (await this.#fetch()).listenUrl;
  }

  /** Forget the cached token (sign-out). */
  clear(): void {
    this.#cached = undefined;
    this.#inflight = undefined;
    this.#generation += 1; // a request still in flight must not refill the cache
  }

  /** Concurrent callers (mic + system streams connecting together) share one request. */
  #fetch(): Promise<SttGrant> {
    if (this.#inflight) return this.#inflight;
    const generation = this.#generation;
    const request = this.#fetchGrant()
      .then((grant) => {
        const listenUrl = checkListenUrl(grant.listenUrl);
        if (generation === this.#generation) {
          this.#cached = {
            token: grant.accessToken,
            expiresAt: this.#now() + grant.expiresIn * 1000,
            listenUrl,
          };
        }
        return { ...grant, listenUrl };
      })
      .finally(() => {
        if (this.#inflight === request) this.#inflight = undefined;
      });
    this.#inflight = request;
    return request;
  }
}
