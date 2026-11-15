/**
 * Route handlers for the enhance API (contract: `src/lib/enhance.ts`) on the shared API layer
 * (`../api/route.ts`: CSRF check for the POST, session → actor, JSON errors). Built from injected deps so the
 * int tests run these exact handlers against a throwaway database, an in-memory broker and a mock model.
 */
import { z } from 'zod';

import { type ApiDeps, apiRoute, readJson } from '../api/route';
import {
  type EnhanceDeps,
  latestEnhancement,
  startEnhancement,
  streamEnhancement,
} from './service';
import {
  getEnhancementVersion,
  listEnhancementVersions,
  restoreEnhancementVersion,
} from './versions';

const Id = z.string().min(1).max(100);

const StartBody = z.strictObject({
  idempotencyKey: z
    .string()
    .min(8)
    .max(200)
    .regex(/^[\w.:-]+$/, 'Use letters, digits and -_.: only.'),
  templateId: Id.optional(),
  timeZone: z.string().min(1).max(64).optional(),
});

const RestoreBody = z.strictObject({
  baseVersion: z.number().int().min(0),
  target: z.enum(['output', 'notes']),
});

/** First language tag of `Accept-Language` (`de-CH,de;q=0.9` → `de-CH`); en-US without one. */
export function requestLocale(request: Request): string {
  const tag = request.headers.get('accept-language')?.split(',')[0]?.split(';')[0]?.trim();
  return tag && tag !== '*' && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(tag) ? tag : 'en-US';
}

/** A resume point we issued (Redis stream id `123-0`, memory `7`); anything else replays from the start. */
export function eventId(value: string | null): string | null {
  return value && /^\d{1,20}(?:-\d{1,20})?$/.test(value) ? value : null;
}

type IdParams = { id: string };

export function createEnhanceApi(deps: ApiDeps, enhance: EnhanceDeps) {
  return {
    /** `/api/documents/[id]/enhance` */
    documentEnhance: {
      GET: apiRoute<IdParams>(deps, async ({ db, actor, params }) =>
        latestEnhancement(db, enhance, actor, params.id),
      ),
      POST: apiRoute<IdParams>(deps, async ({ db, actor, params, request }) => {
        const body = await readJson(request, StartBody);
        const result = await startEnhancement(db, enhance, actor, params.id, body, {
          locale: requestLocale(request),
        });
        return Response.json(result, {
          status: result.attached ? 200 : 201,
          headers: { 'cache-control': 'no-store' },
        });
      }),
    },
    /** `/api/documents/[id]/enhancements` (4.5) */
    documentVersions: {
      GET: apiRoute<IdParams>(deps, async ({ db, actor, params }) =>
        listEnhancementVersions(db, actor, params.id),
      ),
    },
    /** `/api/enhancements/[id]` (4.5) */
    enhancementVersion: {
      GET: apiRoute<IdParams>(deps, async ({ db, actor, params }) =>
        getEnhancementVersion(db, actor, params.id),
      ),
    },
    /** `/api/enhancements/[id]/restore` (4.5) */
    enhancementRestore: {
      POST: apiRoute<IdParams>(deps, async ({ db, actor, params, request }) =>
        restoreEnhancementVersion(
          db,
          enhance,
          actor,
          params.id,
          await readJson(request, RestoreBody),
        ),
      ),
    },
    /** `/api/enhancements/[id]/stream` */
    enhancementStream: {
      GET: apiRoute<IdParams>(deps, async ({ db, actor, params, request, url }) =>
        streamEnhancement(db, enhance, actor, params.id, {
          lastEventId: eventId(
            request.headers.get('last-event-id') || url.searchParams.get('lastEventId'),
          ),
          signal: request.signal,
        }),
      ),
    },
  };
}

export type EnhanceApi = ReturnType<typeof createEnhanceApi>;
