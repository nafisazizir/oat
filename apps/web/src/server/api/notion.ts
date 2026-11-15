import { z } from 'zod';

import { loadActor } from '../actor';
import {
  completeNotionConnect,
  disconnectNotion,
  getNotionConnection,
  getNotionDocumentStatus,
  NOTION_STATE_COOKIE,
  NotionConnectError,
  type NotionDeps,
  searchNotionTargets,
  sendToNotion,
  setNotionTarget,
  startNotionConnect,
} from '../notion';
import { badRequest, errorResponse, unauthorized } from './errors';
import { type ApiDeps, apiRoute, readJson, type RouteHandler } from './route';

/*
 * Notion routes (8.1). JSON ones go through `apiRoute` (CSRF check on writes → session → actor):
 *
 *   POST   /api/integrations/notion/connect          form/JSON { workspaceId } → 303 to Notion's consent page
 *   GET    /api/integrations/notion/callback         ?code&state | ?error → 303 /settings/integrations?…
 *   GET    /api/integrations/notion?workspaceId=     NotionConnectionInfo | null
 *   DELETE /api/integrations/notion?workspaceId=     disconnect (revoke + delete) → 204
 *   GET    /api/integrations/notion/targets?workspaceId=&q=   NotionTargetOption[] (rate limited)
 *   PUT    /api/integrations/notion/target           { workspaceId, type, id } → NotionConnectionInfo
 *   GET    /api/documents/:id/notion                 NotionDocumentStatus (needs read access)
 *   POST   /api/documents/:id/notion                 { timeZone? } → NotionPushResult (read access; rate limited)
 *
 * Errors beyond the documents API's: 409 notion_not_connected | notion_no_target | notion_reconnect |
 * notion_busy, 429 rate_limited, 502 notion_error, 503 not_configured.
 */

const Id = z.string().min(1).max(100);
const NotionId = z.string().regex(/^[0-9a-fA-F-]{32,36}$/, 'not a Notion id');

const SetTarget = z.strictObject({
  workspaceId: Id,
  type: z.enum(['page', 'database']),
  id: NotionId,
});

const timeZone = z
  .string()
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'unknown time zone');

const Send = z.strictObject({ timeZone: timeZone.optional() });

export const INTEGRATIONS_PAGE = '/settings/integrations';

function workspaceParam(url: URL): string {
  const parsed = Id.safeParse(url.searchParams.get('workspaceId'));
  if (!parsed.success) throw badRequest('workspaceId is required.');
  return parsed.data;
}

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

function serializeCookie(
  name: string,
  value: string,
  options: { maxAge: number; path: string; secure: boolean },
): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAge}`,
    'HttpOnly',
    // Lax: sent on the top-level GET back from Notion, not on cross-site subrequests.
    'SameSite=Lax',
    ...(options.secure ? ['Secure'] : []),
  ].join('; ');
}

function redirect(to: URL, cookies: string[] = []): Response {
  const headers = new Headers({ location: to.toString(), 'cache-control': 'no-store' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 303, headers });
}

export function createNotionApi(deps: ApiDeps, notion: () => NotionDeps) {
  const connect: RouteHandler<Record<string, never>> = apiRoute(
    deps,
    async ({ request, actor }) => {
      const type = request.headers.get('content-type') ?? '';
      let workspaceId: unknown;
      if (type.startsWith('application/json')) {
        workspaceId = (await readJson(request, z.object({ workspaceId: Id }))).workspaceId;
      } else {
        const form = await request.formData().catch(() => undefined);
        workspaceId = form?.get('workspaceId');
      }
      const parsed = Id.safeParse(workspaceId);
      if (!parsed.success) throw badRequest('workspaceId is required.');
      const start = startNotionConnect(notion(), actor, parsed.data);
      return redirect(new URL(start.url), [
        serializeCookie(start.cookie.name, start.cookie.value, start.cookie),
      ]);
    },
  );

  const callback: RouteHandler<Record<string, never>> = async (request) => {
    // Signed out (session expired mid-flow): 401 like every other route, before touching anything else.
    const session = await deps.getSession(request.headers);
    if (!session) return errorResponse(unauthorized());
    const url = new URL(request.url);
    const n = notion();
    const page = new URL(INTEGRATIONS_PAGE, n.appUrl);
    const clear = serializeCookie(NOTION_STATE_COOKIE, '', {
      maxAge: 0,
      path: '/api/integrations/notion',
      secure: n.appUrl.startsWith('https://'),
    });
    const actor = await loadActor(deps.db(), session.user.id);
    try {
      await completeNotionConnect(n, actor, {
        code: url.searchParams.get('code'),
        state: url.searchParams.get('state'),
        error: url.searchParams.get('error'),
        cookie: readCookie(request, NOTION_STATE_COOKIE),
      });
      page.searchParams.set('connected', 'notion');
    } catch (error) {
      if (!(error instanceof NotionConnectError)) throw error;
      page.searchParams.set('notion_error', error.code);
    }
    return redirect(page, [clear]);
  };

  return {
    /** `/api/integrations/notion/connect` */
    connect: { POST: connect },
    /** `/api/integrations/notion/callback` */
    callback: { GET: callback },
    /** `/api/integrations/notion` */
    connection: {
      GET: apiRoute(deps, async ({ actor, url }) =>
        // `null` → JSON null (connected: no row).
        Response.json(await getNotionConnection(notion(), actor, workspaceParam(url)), {
          headers: { 'cache-control': 'no-store' },
        }),
      ),
      DELETE: apiRoute(deps, async ({ actor, url }) => {
        await disconnectNotion(notion(), actor, workspaceParam(url));
      }),
    },
    /** `/api/integrations/notion/targets` */
    targets: {
      GET: apiRoute(deps, async ({ actor, url }) =>
        searchNotionTargets(
          notion(),
          actor,
          workspaceParam(url),
          (url.searchParams.get('q') ?? '').slice(0, 200),
        ),
      ),
    },
    /** `/api/integrations/notion/target` */
    target: {
      PUT: apiRoute(deps, async ({ actor, request }) => {
        const { workspaceId, ...target } = await readJson(request, SetTarget);
        return setNotionTarget(notion(), actor, workspaceId, target);
      }),
    },
    /** `/api/documents/[id]/notion` */
    document: {
      GET: apiRoute<{ id: string }>(deps, async ({ actor, params }) =>
        getNotionDocumentStatus(notion(), actor, params.id),
      ),
      POST: apiRoute<{ id: string }>(deps, async ({ actor, params, request }) => {
        const input = request.headers.get('content-type') ? await readJson(request, Send) : {};
        return sendToNotion(notion(), actor, params.id, input);
      }),
    },
  };
}

export type NotionApi = ReturnType<typeof createNotionApi>;
