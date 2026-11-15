/**
 * Route handlers for `/api/sync/push` and `/api/sync/pull` (D-19, task 2.6) on the shared API layer
 * (`../api/route.ts`: CSRF check for cookie writes, session or desktop bearer → actor, JSON errors). Built
 * from injected deps so the int tests run these exact handlers against a throwaway database.
 *
 *   POST /api/sync/push   { entries: SyncPushEntry[] (1..500) } → { results: SyncPushResult[] }
 *   GET  /api/sync/pull?cursor=<opaque>&limit=<1..500>          → SyncPullResponse
 *                                                                 (409 `stale_cursor`: pull from null)
 * Protocol shapes: `@oat/core/sync`.
 */
import { MAX_PULL_LIMIT, syncPushRequestSchema } from '@oat/core';

import { badRequest } from '../api/errors';
import { type ApiDeps, apiRoute, readJson } from '../api/route';
import { pullChanges } from './pull';
import { pushChanges } from './push';

const CURSOR_MAX = 64;

export function createSyncApi(deps: ApiDeps) {
  return {
    /** `/api/sync/push` */
    push: {
      POST: apiRoute(deps, async ({ db, actor, request }) => {
        const { entries } = await readJson(request, syncPushRequestSchema);
        return pushChanges(db, actor, entries);
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
  };
}

export type SyncApi = ReturnType<typeof createSyncApi>;
