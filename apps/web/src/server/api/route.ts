import type { Db } from '@oat/db';
import type { z } from 'zod';

import { type Actor, loadActor } from '../actor';
import { ApiError, badRequest, errorResponse, toApiError, unauthorized } from './errors';

/**
 * What the API needs from the app: the database, the session lookup (Better Auth: cookie or
 * `Authorization: Bearer`) and the origins allowed to send cookie-authenticated writes. Injected so the
 * int tests run the exact handlers against a throwaway database and an in-process auth instance.
 */
export type ApiDeps = {
  db(): Db;
  getSession(headers: Headers): Promise<{ user: { id: string } } | null>;
  /** e.g. `["http://localhost:3000"]` (BETTER_AUTH_URL + trusted origins). */
  allowedOrigins(): readonly string[];
};

/** Next.js passes `{ params: Promise<…> }` as the second argument of every route handler. */
export type HandlerContext<P> = { params: Promise<P> };
export type RouteHandler<P> = (request: Request, context: HandlerContext<P>) => Promise<Response>;

type HandlerArgs<P> = { request: Request; actor: Actor; params: P; db: Db; url: URL };

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Largest JSON body accepted (a long note is a few hundred KB of TipTap JSON). */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * CSRF guard for writes. Bearer requests (desktop) carry no ambient credentials, so they pass. Cookie
 * requests must come from one of our origins: browsers always send `Origin` on POST/PATCH/DELETE, or at
 * least `Sec-Fetch-Site`. A request with neither (a non-browser client using a cookie) is refused too.
 */
export function isTrustedWrite(request: Request, allowedOrigins: readonly string[]): boolean {
  // Only a bearer request *without* cookies: Better Auth falls back to the cookie on a bad token.
  const bearer = request.headers.get('authorization')?.toLowerCase().startsWith('bearer ');
  if (bearer && !request.headers.has('cookie')) return true;
  const origin = request.headers.get('origin');
  if (origin && origin !== 'null') return allowedOrigins.includes(origin);
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

/**
 * Wraps a handler: CSRF check for writes → session (401 without one) → actor with memberships →
 * handler. A returned value is sent as JSON (`status`, default 200), `undefined` as 204. `ApiError` and
 * `@oat/core` `ForbiddenError` become JSON error responses; anything else propagates (500).
 */
export function apiRoute<P = Record<string, never>>(
  deps: ApiDeps,
  handler: (args: HandlerArgs<P>) => Promise<unknown>,
  options: { status?: number } = {},
): RouteHandler<P> {
  return async (request, context) => {
    try {
      if (MUTATING.has(request.method) && !isTrustedWrite(request, deps.allowedOrigins())) {
        throw new ApiError(403, 'cross_site', 'Cross-site request refused.');
      }
      const session = await deps.getSession(request.headers);
      if (!session) throw unauthorized();
      const db = deps.db();
      const actor = await loadActor(db, session.user.id);
      const params = await context.params;
      const result = await handler({ request, actor, params, db, url: new URL(request.url) });
      if (result instanceof Response) return result;
      if (result === undefined) {
        return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
      }
      return Response.json(result, {
        status: options.status ?? 200,
        headers: { 'cache-control': 'no-store' },
      });
    } catch (error) {
      const apiError = toApiError(error);
      if (apiError) return errorResponse(apiError);
      throw error;
    }
  };
}

/** Parses a JSON body against `schema` (400 with the first issue on failure). */
export async function readJson<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<z.infer<S>> {
  const type = request.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) {
    throw badRequest('Send a JSON body (content-type: application/json).');
  }
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_BODY_BYTES) throw new ApiError(413, 'bad_request', 'Request body too large.');
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES)
    throw new ApiError(413, 'bad_request', 'Request body too large.');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw badRequest('Malformed JSON.');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const path = issue.path.length ? `${issue.path.join('.')}: ` : '';
    throw badRequest(`${path}${issue.message}`);
  }
  return parsed.data;
}
