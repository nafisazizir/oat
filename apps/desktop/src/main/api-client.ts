/**
 * The desktop's HTTP client for apps/web, used only in the main process. The bearer token is passed in
 * per call and never leaves main.
 *
 * Uses Node's `fetch`, not Electron's `net.fetch`: `net.fetch` shares the default session's cookie jar,
 * and the token exchange answers with a session cookie we don't want stored anywhere.
 */
import { AUTH_TOKEN_HEADER, DESKTOP_TOKEN_ENDPOINT } from '@oat/auth/desktop-link';
import { type DesktopUser, desktopUserSchema } from '@oat/core/bridge';
import {
  type SyncPullChange,
  syncPullChangeSchema,
  type SyncPullResponse,
  type SyncPushRequest,
  type SyncPushResponse,
  syncPushResponseSchema,
} from '@oat/core/sync';
import { z } from 'zod';

import type { SttGrant } from './stt-credentials.ts';

const AUTH_BASE = '/api/auth';
const STT_TOKEN_PATH = '/api/stt/token';
const SYNC_PUSH_PATH = '/api/sync/push';
const SYNC_PULL_PATH = '/api/sync/pull';
/** A push carries up to 500 rows; give it longer than a plain call. */
const SYNC_TIMEOUT_MS = 30_000;

const pullEnvelopeSchema = z.object({
  changes: z.array(z.unknown()),
  cursor: z.string().nullable(),
  hasMore: z.boolean(),
  workspaceIds: z.array(z.string()),
});

const sttGrantSchema = z.object({
  accessToken: z.string().min(1).max(4096),
  expiresIn: z.number().positive().max(86_400),
  listenUrl: z.string().min(1).max(2048),
});
const TIMEOUT_MS = 10_000;

/** `<session token>.<signature>` as Better Auth's bearer plugin issues it. */
const SIGNED_TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_+/=%-]+$/;

export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    /** HTTP status, or 0 when the server couldn't be reached. */
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
  get unauthorized(): boolean {
    return this.status === 401;
  }
}

const sessionSchema = z
  .object({
    user: z.object({ id: z.string(), email: z.string(), name: z.string().nullish() }),
    session: z.object({ activeOrganizationId: z.string().nullish() }),
  })
  .nullable();

export interface MeResult {
  user: DesktopUser;
  activeWorkspaceId: string | null;
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Origin for `/api/sync/*` (dev `OAT_SYNC_URL`); defaults to `baseUrl`. */
  syncBaseUrl?: string;
  /** Changes of a pull page that don't match the protocol are skipped and reported here. */
  onSkippedChange?: (reason: string) => void;
  fetch?: typeof globalThis.fetch;
  userAgent?: string;
}

export function createApiClient({
  baseUrl,
  syncBaseUrl = baseUrl,
  onSkippedChange,
  fetch = globalThis.fetch,
  userAgent = 'Oat-Desktop',
}: ApiClientOptions) {
  async function request(
    path: string,
    init: RequestInit & { token?: string; base?: string; timeoutMs?: number } = {},
  ) {
    const { token, base = baseUrl, timeoutMs = TIMEOUT_MS, ...rest } = init;
    const headers = new Headers(rest.headers);
    headers.set('user-agent', userAgent);
    headers.set('accept', 'application/json');
    if (token) headers.set('authorization', `Bearer ${token}`);
    try {
      return await fetch(new URL(path, base), {
        ...rest,
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new ApiError(0, `Couldn’t reach ${new URL(base).host}.`);
    }
  }

  return {
    /** Redeems a one-time code from the browser (PKCE). Returns the signed bearer token and the user. */
    async exchangeDesktopCode(
      code: string,
      verifier: string,
    ): Promise<{ token: string; user: DesktopUser }> {
      const res = await request(`${AUTH_BASE}${DESKTOP_TOKEN_ENDPOINT}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, verifier }),
      });
      if (!res.ok) throw new ApiError(res.status, 'The sign-in code was refused.');
      const token = res.headers.get(AUTH_TOKEN_HEADER);
      if (!token || !SIGNED_TOKEN.test(token))
        throw new ApiError(502, 'No session token returned.');
      const body = z
        .object({ user: desktopUserSchema })
        .safeParse(await res.json().catch(() => null));
      if (!body.success) throw new ApiError(502, 'Unexpected sign-in response.');
      return { token, user: body.data.user };
    },

    /** The session behind `token`; `ApiError(401)` if it is unknown, expired or revoked. */
    async me(token: string): Promise<MeResult> {
      const res = await request(`${AUTH_BASE}/get-session`, { token });
      if (!res.ok) throw new ApiError(res.status, 'Couldn’t load your account.');
      const body = sessionSchema.safeParse(await res.json().catch(() => undefined));
      if (!body.success) throw new ApiError(502, 'Unexpected session response.');
      if (!body.data) throw new ApiError(401, 'Your session has ended.');
      const { user, session } = body.data;
      return {
        user: { id: user.id, email: user.email, name: user.name || null },
        activeWorkspaceId: session.activeOrganizationId ?? null,
      };
    },

    /** A short-lived live-transcription token and the websocket it is for (`POST /api/stt/token`, D-17). */
    async sttToken(token: string): Promise<SttGrant> {
      const res = await request(STT_TOKEN_PATH, {
        method: 'POST',
        token,
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) {
        throw new ApiError(
          res.status,
          res.status === 401 ? 'Your session has ended.' : 'Transcription is unavailable.',
        );
      }
      const body = sttGrantSchema.safeParse(await res.json().catch(() => undefined));
      if (!body.success) throw new ApiError(502, 'Unexpected transcription token response.');
      return body.data;
    },

    /** `POST /api/sync/push` (D-19): one outbox batch → a result per entry. */
    async syncPush(token: string, body: SyncPushRequest): Promise<SyncPushResponse> {
      const res = await request(SYNC_PUSH_PATH, {
        method: 'POST',
        token,
        base: syncBaseUrl,
        timeoutMs: SYNC_TIMEOUT_MS,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new ApiError(res.status, `Sync push failed (${res.status}).`);
      const parsed = syncPushResponseSchema.safeParse(await res.json().catch(() => undefined));
      if (!parsed.success) throw new ApiError(502, 'Unexpected sync push response.');
      return parsed.data;
    },

    /**
     * `GET /api/sync/pull?cursor=` (D-19). A change that doesn't match the protocol is skipped (and
     * reported) rather than failing every future pull.
     */
    async syncPull(token: string, cursor: string | null): Promise<SyncPullResponse> {
      const query = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
      const res = await request(`${SYNC_PULL_PATH}${query}`, {
        token,
        base: syncBaseUrl,
        timeoutMs: SYNC_TIMEOUT_MS,
      });
      if (!res.ok) throw new ApiError(res.status, `Sync pull failed (${res.status}).`);
      const parsed = pullEnvelopeSchema.safeParse(await res.json().catch(() => undefined));
      if (!parsed.success) throw new ApiError(502, 'Unexpected sync pull response.');
      const changes: SyncPullChange[] = [];
      for (const raw of parsed.data.changes) {
        const change = syncPullChangeSchema.safeParse(raw);
        if (change.success) changes.push(change.data);
        else onSkippedChange?.(change.error.issues[0]?.message ?? 'invalid change');
      }
      return { ...parsed.data, changes };
    },

    /** Revokes the session on the server. */
    async signOut(token: string): Promise<void> {
      const res = await request(`${AUTH_BASE}/sign-out`, {
        method: 'POST',
        token,
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) throw new ApiError(res.status, 'Sign-out failed.');
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
