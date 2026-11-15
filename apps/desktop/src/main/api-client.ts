/**
 * The desktop's HTTP client for apps/web, used only in the main process. The bearer token is passed in
 * per call and never leaves main.
 *
 * Uses Node's `fetch`, not Electron's `net.fetch`: `net.fetch` shares the default session's cookie jar,
 * and the token exchange answers with a session cookie we don't want stored anywhere.
 */
import { AUTH_TOKEN_HEADER, DESKTOP_TOKEN_ENDPOINT } from '@oat/auth/desktop-link';
import { type CalendarEvent, CalendarEventSchema } from '@oat/core';
import {
  type DesktopUser,
  desktopUserSchema,
  type PipelineStatus,
  pipelineStatusSchema,
} from '@oat/core/bridge';
import {
  type SyncBackfillResponse,
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
const SYNC_BACKFILL_PATH = '/api/sync/backfill';
const SYNC_EVENTS_PATH = '/api/sync/events';
const CALENDAR_UPCOMING_PATH = '/api/calendar/upcoming';
const pipelinePath = (documentId: string) =>
  `/api/documents/${encodeURIComponent(documentId)}/pipeline`;
/** A push carries up to 500 rows; give it longer than a plain call. */
const SYNC_TIMEOUT_MS = 30_000;

const pullEnvelopeSchema = z.object({
  changes: z.array(z.unknown()),
  cursor: z.string().nullable(),
  hasMore: z.boolean(),
  workspaceIds: z.array(z.string()),
  lagging: z.boolean().optional(),
});

const backfillEnvelopeSchema = z.object({
  changes: z.array(z.unknown()),
  next: z.string().nullable(),
});

const sttGrantSchema = z.object({
  accessToken: z.string().min(1).max(4096),
  expiresIn: z.number().positive().max(86_400),
  listenUrl: z.string().min(1).max(2048),
});
const upcomingSchema = z.object({
  connected: z.boolean(),
  sources: z.array(z.object({ state: z.enum(['ok', 'reconnect', 'error']) })),
  events: z.array(z.unknown()),
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
    const { token, base = baseUrl, timeoutMs = TIMEOUT_MS, signal, ...rest } = init;
    const headers = new Headers(rest.headers);
    headers.set('user-agent', userAgent);
    headers.set('accept', 'application/json');
    if (token) headers.set('authorization', `Bearer ${token}`);
    try {
      return await fetch(new URL(path, base), {
        ...rest,
        headers,
        redirect: 'error',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
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

    /** `GET /api/sync/backfill` (3.5): a document's subtree, a page at a time. Same skipping as pulls. */
    async syncBackfill(
      token: string,
      documentId: string,
      after: string | null,
    ): Promise<SyncBackfillResponse> {
      const q = new URLSearchParams({ document: documentId });
      if (after !== null) q.set('after', after);
      const res = await request(`${SYNC_BACKFILL_PATH}?${q}`, {
        token,
        base: syncBaseUrl,
        timeoutMs: SYNC_TIMEOUT_MS,
      });
      if (!res.ok) throw new ApiError(res.status, `Sync backfill failed (${res.status}).`);
      const parsed = backfillEnvelopeSchema.safeParse(await res.json().catch(() => undefined));
      if (!parsed.success) throw new ApiError(502, 'Unexpected sync backfill response.');
      const changes: SyncPullChange[] = [];
      for (const raw of parsed.data.changes) {
        const change = syncPullChangeSchema.safeParse(raw);
        if (change.success) changes.push(change.data);
        else onSkippedChange?.(change.error.issues[0]?.message ?? 'invalid change');
      }
      return { changes, next: parsed.data.next };
    },

    /**
     * Opens `GET /api/sync/events` (3.5, SSE) — no timeout: the caller reads the stream until it ends or
     * aborts it. 401 rejects with an `ApiError` (so the session wrapper signs out); other statuses are
     * returned for the caller to retry.
     */
    async openSyncEvents(
      token: string,
      lastEventId: string | null,
      signal: AbortSignal,
    ): Promise<Response> {
      const headers = new Headers({
        'user-agent': userAgent,
        accept: 'text/event-stream',
        authorization: `Bearer ${token}`,
      });
      if (lastEventId) headers.set('last-event-id', lastEventId);
      let res: Response;
      try {
        res = await fetch(new URL(SYNC_EVENTS_PATH, syncBaseUrl), {
          headers,
          redirect: 'error',
          signal,
        });
      } catch {
        throw new ApiError(0, `Couldn’t reach ${new URL(syncBaseUrl).host}.`);
      }
      if (res.status === 401) {
        await res.body?.cancel().catch(() => {});
        throw new ApiError(401, 'Not signed in.');
      }
      return res;
    },

    /**
     * Google Calendar events through the web app (`GET /api/calendar/upcoming`, 7.4): in progress and upcoming
     * within `days`. Events that don't parse are skipped.
     */
    async calendarUpcoming(
      token: string,
      { days, limit, signal }: { days: number; limit: number; signal?: AbortSignal },
    ): Promise<{
      connected: boolean;
      state: 'ok' | 'reconnect' | 'error' | null;
      events: CalendarEvent[];
    }> {
      const res = await request(`${CALENDAR_UPCOMING_PATH}?days=${days}&limit=${limit}`, {
        token,
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) {
        throw new ApiError(
          res.status,
          res.status === 401 ? 'Your session has ended.' : 'Couldn’t load your calendar.',
        );
      }
      const body = upcomingSchema.safeParse(await res.json().catch(() => undefined));
      if (!body.success) throw new ApiError(502, 'Unexpected calendar response.');
      const events: CalendarEvent[] = [];
      for (const raw of body.data.events) {
        const event = CalendarEventSchema.safeParse(raw);
        if (event.success) events.push(event.data);
      }
      return {
        connected: body.data.connected,
        state: body.data.sources[0]?.state ?? null,
        events,
      };
    },

    /**
     * The note's post-meeting run (8.3, `GET /api/documents/:id/pipeline`), or with `retry` a start/retry
     * (`POST`, owner/editor). Only what the meeting header shows is kept.
     */
    async pipeline(
      token: string,
      documentId: string,
      { retry = false }: { retry?: boolean } = {},
    ): Promise<PipelineStatus> {
      const res = await request(pipelinePath(documentId), {
        token,
        ...(retry
          ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }
          : {}),
      });
      if (!res.ok) {
        throw new ApiError(
          res.status,
          res.status === 401
            ? 'Your session has ended.'
            : res.status === 404
              ? 'This note isn’t on the server yet.'
              : res.status === 403
                ? 'Only people who can edit this note can run its post-meeting steps.'
                : 'Couldn’t load the post-meeting status.',
        );
      }
      const body = pipelineStatusSchema.safeParse(await res.json().catch(() => undefined));
      if (!body.success) throw new ApiError(502, 'Unexpected post-meeting status response.');
      return body.data;
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
