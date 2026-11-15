/**
 * A small fetch-based client for the Notion API (version 2022-06-28) and Notion's OAuth endpoints. Base URL
 * from config (`resolveNotionConfig`): the mock in dev/tests, `https://api.notion.com` for real Notion.
 *
 * - Every request: `Authorization: Bearer <token>`, `Notion-Version`, JSON, 15 s timeout.
 * - 429 `rate_limited` → waits `Retry-After` (capped) and retries; 502/503/504 → short backoff and retry;
 *   at most `maxRetries` retries per call.
 * - Errors: `NotionAuthError` (401: token invalid or revoked → reconnect), `NotionApiError` with Notion's
 *   `status`/`code`/`message` otherwise (`isNotFound()` for `object_not_found`, `restricted_resource`).
 */
import { z } from 'zod';

import {
  type NotionBlock,
  type NotionBlockResponse,
  type NotionDatabase,
  type NotionList,
  type NotionPage,
  NOTION_VERSION,
} from './types.ts';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class NotionApiError extends Error {
  override name = 'NotionApiError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
  /** The object doesn't exist or the integration can't see it. */
  isNotFound(): boolean {
    return (
      this.status === 404 || this.code === 'object_not_found' || this.code === 'restricted_resource'
    );
  }
}

/** 401: the token is invalid or was revoked; the user must connect Notion again. */
export class NotionAuthError extends NotionApiError {
  override name = 'NotionAuthError';
}

export interface NotionClientOptions {
  /** API origin, e.g. `https://api.notion.com` or `${MOCKS_URL}/notion` (requests go to `${baseUrl}/v1/…`). */
  baseUrl: string;
  token: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  /** Longest wait honoured from `Retry-After` (ms). */
  maxRetryAfterMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const ErrorBody = z.looseObject({ code: z.string().optional(), message: z.string().optional() });

async function errorFrom(res: Response): Promise<NotionApiError> {
  let code = 'http_error';
  let message = `Notion answered ${res.status}.`;
  try {
    const parsed = ErrorBody.safeParse(await res.json());
    if (parsed.success) {
      code = parsed.data.code ?? code;
      message = parsed.data.message ?? message;
    }
  } catch {
    // not JSON
  }
  return res.status === 401
    ? new NotionAuthError(res.status, code, message)
    : new NotionApiError(res.status, code, message);
}

export interface SearchParams {
  query?: string;
  filter?: { property: 'object'; value: 'page' | 'database' };
  sort?: { direction: 'ascending' | 'descending'; timestamp: 'last_edited_time' };
  start_cursor?: string;
  page_size?: number;
}

export class NotionClient {
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxRetryAfterMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Requests sent (retries included); handy for tests and logs. */
  requests = 0;

  constructor(private readonly options: NotionClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? 10_000;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      this.requests++;
      const res = await this.fetch(`${this.baseUrl}/v1${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.options.token}`,
          'notion-version': NOTION_VERSION,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.ok) return (await res.json()) as T;
      const retryable =
        res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
      if (!retryable || attempt >= this.maxRetries) throw await errorFrom(res);
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait =
        res.status === 429 && Number.isFinite(retryAfter) && retryAfter >= 0
          ? retryAfter * 1000
          : 250 * 2 ** attempt;
      await res.body?.cancel().catch(() => undefined);
      await this.sleep(Math.min(wait, this.maxRetryAfterMs));
    }
  }

  search(params: SearchParams): Promise<NotionList<NotionPage | NotionDatabase>> {
    return this.request('POST', '/search', params);
  }

  retrieveDatabase(id: string): Promise<NotionDatabase> {
    return this.request('GET', `/databases/${encodeURIComponent(id)}`);
  }

  retrievePage(id: string): Promise<NotionPage> {
    return this.request('GET', `/pages/${encodeURIComponent(id)}`);
  }

  createPage(body: {
    parent: { page_id: string } | { database_id: string };
    properties: Record<string, unknown>;
    children?: NotionBlock[];
  }): Promise<NotionPage> {
    return this.request('POST', '/pages', body);
  }

  updatePage(
    id: string,
    body: { properties?: Record<string, unknown>; archived?: boolean },
  ): Promise<NotionPage> {
    return this.request('PATCH', `/pages/${encodeURIComponent(id)}`, body);
  }

  appendChildren(id: string, children: NotionBlock[]): Promise<NotionList<NotionBlockResponse>> {
    return this.request('PATCH', `/blocks/${encodeURIComponent(id)}/children`, { children });
  }

  /** Every (live) child block of a page or block, following `next_cursor`. */
  async listChildren(id: string): Promise<NotionBlockResponse[]> {
    const out: NotionBlockResponse[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : '';
      const page: NotionList<NotionBlockResponse> = await this.request(
        'GET',
        `/blocks/${encodeURIComponent(id)}/children?page_size=100${query}`,
      );
      out.push(...page.results);
      cursor = page.has_more ? page.next_cursor : null;
    } while (cursor);
    return out;
  }

  deleteBlock(id: string): Promise<NotionBlockResponse> {
    return this.request('DELETE', `/blocks/${encodeURIComponent(id)}`);
  }
}

// ---------------------------------------------------------------------------------------------------
// OAuth (public integration)

export interface OAuthClientConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  fetch?: FetchLike;
}

/** Where to send the user to approve access (`owner=user`, authorization code flow). */
export function notionAuthorizeUrl(
  config: Pick<OAuthClientConfig, 'baseUrl' | 'clientId'>,
  params: { redirectUri: string; state: string },
): string {
  const url = new URL(`${config.baseUrl.replace(/\/+$/, '')}/v1/oauth/authorize`);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('owner', 'user');
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('state', params.state);
  return url.toString();
}

export const NotionTokenResponse = z.looseObject({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  bot_id: z.string(),
  workspace_id: z.string(),
  workspace_name: z.string().nullish(),
  workspace_icon: z.string().nullish(),
  owner: z.unknown().optional(),
});
export type NotionTokenResponse = z.infer<typeof NotionTokenResponse>;

/** Notion's OAuth endpoints answer errors as `{ error, error_description }`. */
export class NotionOAuthError extends Error {
  override name = 'NotionOAuthError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const basicAuth = (config: OAuthClientConfig) =>
  `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;

/** Exchanges an authorization code for the integration's access token. */
export async function exchangeNotionCode(
  config: OAuthClientConfig,
  params: { code: string; redirectUri: string },
): Promise<NotionTokenResponse> {
  const res = await (config.fetch ?? fetch)(
    `${config.baseUrl.replace(/\/+$/, '')}/v1/oauth/token`,
    {
      method: 'POST',
      headers: { authorization: basicAuth(config), 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: params.code,
        redirect_uri: params.redirectUri,
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  const json: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const body = (json ?? {}) as {
      error?: string;
      error_description?: string;
      code?: string;
      message?: string;
    };
    throw new NotionOAuthError(
      res.status,
      body.error ?? body.code ?? 'oauth_error',
      body.error_description ?? body.message ?? `Token exchange failed (${res.status}).`,
    );
  }
  const parsed = NotionTokenResponse.safeParse(json);
  if (!parsed.success)
    throw new NotionOAuthError(502, 'bad_response', 'Unexpected token response from Notion.');
  return parsed.data;
}

/** Best-effort token revocation (`POST /v1/oauth/revoke`). Never throws; `true` when Notion confirmed. */
export async function revokeNotionToken(
  config: OAuthClientConfig,
  token: string,
): Promise<boolean> {
  try {
    const res = await (config.fetch ?? fetch)(
      `${config.baseUrl.replace(/\/+$/, '')}/v1/oauth/revoke`,
      {
        method: 'POST',
        headers: { authorization: basicAuth(config), 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    await res.body?.cancel().catch(() => undefined);
    return res.ok;
  } catch {
    return false;
  }
}
