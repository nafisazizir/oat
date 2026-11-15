/**
 * Route handlers for `/api/sync/push` and `/api/sync/pull` (D-19, task 2.6) on the shared API layer
 * (`../api/route.ts`: CSRF check for cookie writes, session or desktop bearer → actor, JSON errors). Built
 * from injected deps so the int tests run these exact handlers against a throwaway database.
 *
 *   POST /api/sync/push   { entries: SyncPushEntry[] (1..500) } → { results: SyncPushResult[] }
 *   GET  /api/sync/pull?cursor=<opaque>&limit=<1..500>          → SyncPullResponse
 *                                                                 (409 `stale_cursor`: pull from null)
 *   GET  /api/sync/backfill?document=<id>&after=<token>          → SyncBackfillResponse (3.5)
 *   GET  /api/sync/events                                         → SSE invalidation channel (3.5)
 *   GET  /api/sync/conflicts/:id                                  → the conflict of a copy (3.5)
 *   POST /api/sync/conflicts/:id  { keep, baseVersion? }          → resolve it (3.5)
 * Protocol shapes: `@oat/core/sync`.
 */
import {
  MAX_BACKFILL_LIMIT,
  MAX_PULL_LIMIT,
  syncConflictResolveSchema,
  syncPushRequestSchema,
} from '@oat/core';

import { badRequest } from '../api/errors';
import { type ApiDeps, apiRoute, readJson } from '../api/route';
import { backfillDocument } from './backfill';
import { requireConflict, resolveConflict } from './conflicts';
import type { RateLimiter } from '@oat/auth';

import { ApiError } from '../api/errors';
import { StreamRegistry, streamSyncEvents, type SyncEventsTimings } from './events';
import { pullChanges } from './pull';
import { pushChanges } from './push';

const CURSOR_MAX = 64;

/** Connects to `/api/sync/events` per user per minute (reconnects every ~270 s, tabs come and go). */
export const SYNC_EVENTS_CONNECTS_PER_MINUTE = 30;

/**
 * `events`: SSE timings (int tests poll faster); `rateLimiter`: per-user connect limit for the events
 * stream (`apiRateLimiter` in production; none = unlimited); `maxStreamsPerUser`: concurrent streams per
 * user in this process (default 5).
 */
export function createSyncApi(
  deps: ApiDeps,
  options: {
    events?: SyncEventsTimings;
    rateLimiter?: () => RateLimiter;
    connectsPerMinute?: number;
    maxStreamsPerUser?: number;
  } = {},
) {
  const eventTimings = options.events ?? {};
  const streams = new StreamRegistry(options.maxStreamsPerUser ?? 5);
  return {
    /** `/api/sync/push` */
    push: {
      POST: apiRoute(deps, async ({ db, actor, request }) => {
        const { entries, device } = await readJson(request, syncPushRequestSchema);
        return pushChanges(db, actor, entries, device ?? null);
      }),
    },
    /** `/api/sync/pull` */
    pull: {
      GET: apiRoute(deps, async ({ db, actor, url }) => {
        const cursor = url.searchParams.get('cursor') || null;
        if (cursor !== null && cursor.length > CURSOR_MAX) throw badRequest('Invalid cursor.');
        const rawLimit = url.searchParams.get('limit');
        const limit = rawLimit === null ? MAX_PULL_LIMIT : Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PULL_LIMIT) {
          throw badRequest(`limit must be 1..${MAX_PULL_LIMIT}.`);
        }
        return pullChanges(db, actor, cursor, limit);
      }),
    },
    /** `/api/sync/backfill` */
    backfill: {
      GET: apiRoute(deps, async ({ db, actor, url }) => {
        const id = url.searchParams.get('document');
        if (!id || id.length > 100) throw badRequest('document is required.');
        const after = url.searchParams.get('after') || null;
        const rawLimit = url.searchParams.get('limit');
        const limit = rawLimit === null ? MAX_BACKFILL_LIMIT : Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BACKFILL_LIMIT) {
          throw badRequest(`limit must be 1..${MAX_BACKFILL_LIMIT}.`);
        }
        return backfillDocument(db, actor, id, after, limit);
      }),
    },
    /** `/api/sync/events` */
    events: {
      GET: apiRoute(deps, async ({ db, actor, request, url }) => {
        if (options.rateLimiter) {
          const hit = await options
            .rateLimiter()
            .hit(
              `sync-events:${actor.userId}`,
              options.connectsPerMinute ?? SYNC_EVENTS_CONNECTS_PER_MINUTE,
              60,
            );
          if (!hit.allowed) {
            throw new ApiError(429, 'rate_limited', 'Too many sync connections; try again soon.', {
              retryAfter: hit.retryAfter,
            });
          }
        }
        const release = streams.acquire(actor.userId); // 429 past the per-user cap
        const headers = new Headers(request.headers);
        return streamSyncEvents(db, actor, {
          lastEventId:
            request.headers.get('last-event-id') || url.searchParams.get('lastEventId') || null,
          signal: request.signal,
          sessionValid: async () => {
            try {
              return (await deps.getSession(headers))?.user.id === actor.userId;
            } catch {
              return true; // the auth store is unreachable: not a sign-out
            }
          },
          onClose: release,
          ...eventTimings,
        });
      }),
    },
    /** `/api/sync/conflicts/[id]` */
    conflict: {
      GET: apiRoute<{ id: string }>(deps, async ({ db, actor, params }) =>
        requireConflict(db, actor, params.id),
      ),
      POST: apiRoute<{ id: string }>(deps, async ({ db, actor, params, request }) =>
        resolveConflict(db, actor, params.id, await readJson(request, syncConflictResolveSchema)),
      ),
    },
  };
}

export type SyncApi = ReturnType<typeof createSyncApi>;
