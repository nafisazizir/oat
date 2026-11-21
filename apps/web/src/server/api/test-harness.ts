/**
 * Int-test harness for the documents/folders API: a throwaway migrated database, a real Better Auth
 * instance (in-process, magic links captured instead of mailed), and the exact route handlers from
 * `createApi`, called the way Next.js calls them (`Request` + `{ params }`). Test-only.
 */
import {
  type Auth,
  createAuth,
  createMemoryRateLimiter,
  DEV_AUTH_SECRET,
  type EmailMessage,
  magicLinkVerifyUrl,
} from '@oat/auth';
import { createDb, type Db, membership, migrate, workspace } from '@oat/db';
import { createTestDatabase, type TestDatabase, testEnv } from '@oat/testkit';

import type { ApiErrorBody } from '@/lib/api-types';

import { type Api, createApi } from './handlers';
import type { RouteHandler } from './route';

export const BASE = 'http://localhost:3000';

export type TestUser = { id: string; email: string; cookie: string; bearer: string };

export type Harness = {
  db: Db;
  auth: Auth;
  api: Api;
  signUp(label: string): Promise<TestUser>;
  /** A team workspace owned by `owner`, with the other users at the given roles. */
  teamWorkspace(
    owner: TestUser,
    members: Array<[TestUser, 'admin' | 'member' | 'viewer']>,
  ): Promise<string>;
  close(): Promise<void>;
};

export async function createHarness(): Promise<Harness> {
  const testDb: TestDatabase = await createTestDatabase();
  await migrate(testDb.url);
  const db = createDb(testDb.url, { max: 6 });
  const outbox: EmailMessage[] = [];
  const auth = createAuth({
    db,
    config: {
      secret: DEV_AUTH_SECRET,
      baseURL: BASE,
      trustedOrigins: [],
      smtp: { ...testEnv.smtpConfig(), from: 'Oat <no-reply@oat.localhost>' },
      google: { issuer: testEnv.oauthGoogleIssuer(), clientId: 'oat-dev', clientSecret: 'x' },
      maxTeamWorkspaces: 20,
      production: false,
    },
    mailer: { send: async (message) => void outbox.push(message) },
    rateLimiter: createMemoryRateLimiter(),
  });
  const api = createApi({
    db: () => db,
    getSession: (headers) => auth.api.getSession({ headers }),
    allowedOrigins: () => [BASE],
  });

  let counter = 0;
  async function signUp(label: string): Promise<TestUser> {
    const email = `${label}-${Date.now()}-${counter++}@example.test`;
    const res = await auth.handler(
      new Request(`${BASE}/api/auth/sign-in/magic-link`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE },
        body: JSON.stringify({ email, callbackURL: '/home' }),
      }),
    );
    if (res.status !== 200) throw new Error(`magic link request failed: ${res.status}`);
    const message = outbox.findLast((m) => m.to === email);
    const token = message?.text.match(/token=([^&\s]+)/)?.[1];
    if (!token) throw new Error('no magic link captured');
    const verify = await auth.handler(
      new Request(magicLinkVerifyUrl(BASE, decodeURIComponent(token), '/home'), {
        redirect: 'manual',
      }),
    );
    const cookie = verify.headers
      .getSetCookie()
      .map((c) => c.split(';')[0]!)
      .join('; ');
    const bearer = verify.headers.get('set-auth-token') ?? '';
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    if (!session) throw new Error('sign-in produced no session');
    return { id: session.user.id, email, cookie, bearer };
  }

  async function teamWorkspace(
    owner: TestUser,
    members: Array<[TestUser, 'admin' | 'member' | 'viewer']>,
  ): Promise<string> {
    const [ws] = await db
      .insert(workspace)
      .values({
        name: 'Team',
        slug: `team-${Date.now()}-${counter++}`,
        createdBy: owner.id,
      })
      .returning();
    await db
      .insert(membership)
      .values([
        { workspaceId: ws!.id, userId: owner.id, role: 'owner' },
        ...members.map(([user, role]) => ({ workspaceId: ws!.id, userId: user.id, role })),
      ]);
    return ws!.id;
  }

  return {
    db,
    auth,
    api,
    signUp,
    teamWorkspace,
    close: async () => {
      await db.$client.end();
      await testDb.drop();
    },
  };
}

export type CallOptions = {
  /** Signed-in user (cookie), `null` for anonymous. */
  as: TestUser | null;
  body?: unknown;
  params?: Record<string, string>;
  /** Override the Origin header (`null` = none). Default: our origin. */
  origin?: string | null;
  /** Authenticate with the bearer token instead of the cookie. */
  bearer?: boolean;
  /** Additional request headers. */
  extraHeaders?: Record<string, string>;
  /** Raw body + content type instead of JSON. */
  raw?: { body: string; type: string };
};

export type CallResult<T> = { status: number; body: T; error?: ApiErrorBody['error'] };

export { denies } from './authz-markers';

/** Calls a route handler like Next.js does and parses the JSON answer. */
export async function call<T = unknown>(
  handler: RouteHandler<never> | RouteHandler<{ id: string }> | RouteHandler<Record<string, never>>,
  method: string,
  path: string,
  options: CallOptions,
): Promise<CallResult<T>> {
  const headers = new Headers();
  const origin = options.origin === undefined ? BASE : options.origin;
  if (origin !== null) headers.set('origin', origin);
  if (options.as && options.bearer) headers.set('authorization', `Bearer ${options.as.bearer}`);
  else if (options.as) headers.set('cookie', options.as.cookie);
  for (const [name, value] of Object.entries(options.extraHeaders ?? {})) headers.set(name, value);
  let body: string | undefined;
  if (options.raw) {
    body = options.raw.body;
    headers.set('content-type', options.raw.type);
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers.set('content-type', 'application/json');
  }
  const request = new Request(`${BASE}${path}`, { method, headers, body });
  const params = Promise.resolve(options.params ?? {});
  const res = await (handler as RouteHandler<Record<string, string>>)(request, { params });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : undefined;
  const error = (json as Partial<ApiErrorBody> | undefined)?.error;
  return { status: res.status, body: json as T, ...(error ? { error } : {}) };
}
