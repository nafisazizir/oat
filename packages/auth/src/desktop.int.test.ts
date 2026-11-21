/**
 * Desktop sign-in hand-off (1.8) against a throwaway Postgres database, through `auth.handler` (the same
 * Request → Response path the Next.js catch-all route uses). Magic links are captured in memory.
 */
import { createDb, type Db, migrate, newId, schema } from '@oat/db';
import { createTestDatabase, type TestDatabase, testEnv, uniqueAddress } from '@oat/testkit';
import { eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type AuthConfig, DEV_AUTH_SECRET } from './config.ts';
import { desktopCodeIdentifier } from './desktop.ts';
import {
  AUTH_TOKEN_HEADER,
  parseDesktopDeepLink,
  pkceChallenge,
  randomDesktopValue,
} from './desktop-link.ts';
import type { EmailMessage } from './email.ts';
import { magicLinkVerifyUrl } from './magic-link.ts';
import { createMemoryRateLimiter } from './rate-limit.ts';
import { type Auth, createAuth } from './server.ts';
import { findFirstWorkspaceId } from './workspaces.ts';

const BASE = 'http://localhost:3000';

let testDb: TestDatabase;
let db: Db;
let auth: Auth;
const sent: EmailMessage[] = [];

beforeAll(async () => {
  testDb = await createTestDatabase();
  await migrate(testDb.url);
  db = createDb(testDb.url, { max: 4 });
  const config: AuthConfig = {
    secret: DEV_AUTH_SECRET,
    baseURL: BASE,
    trustedOrigins: [],
    smtp: { ...testEnv.smtpConfig(), from: 'Oat <no-reply@oat.localhost>' },
    google: { issuer: testEnv.oauthGoogleIssuer(), clientId: 'oat-dev', clientSecret: 'x' },
    redisUrl: undefined,
    maxTeamWorkspaces: 3,
    production: false,
  };
  auth = createAuth({
    db,
    config,
    mailer: { send: async (message) => void sent.push(message) },
    rateLimiter: createMemoryRateLimiter(),
  });
});

afterAll(async () => {
  await db?.$client.end();
  await testDb?.drop();
});

// ---------------------------------------------------------------------------------------------------

class Jar {
  private cookies = new Map<string, string>();
  store(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      if (value === '' || /max-age=0/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

interface CallOptions {
  method?: string;
  body?: unknown;
  jar?: Jar;
  origin?: string | null;
  bearer?: string;
}

/** A request through Better Auth. Browser-like calls carry the jar's cookies and an Origin. */
async function call(path: string, { method = 'GET', body, jar, origin, bearer }: CallOptions = {}) {
  const headers = new Headers();
  if (origin !== null && (origin ?? jar)) headers.set('origin', origin ?? BASE);
  if (jar?.header()) headers.set('cookie', jar.header());
  if (bearer) headers.set('authorization', `Bearer ${bearer}`);
  if (body !== undefined) headers.set('content-type', 'application/json');
  const res = await auth.handler(
    new Request(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    }),
  );
  jar?.store(res);
  return res;
}

/** A signed-in browser (magic link, captured from the in-memory mailer). */
async function signedInBrowser(email = uniqueAddress('desktop')) {
  const jar = new Jar();
  const res = await call('/api/auth/sign-in/magic-link', {
    method: 'POST',
    jar,
    body: { email, callbackURL: '/home' },
  });
  expect(res.status).toBe(200);
  const message = sent.findLast((m) => m.to === email)!;
  const confirm = new URL(/https?:\/\/\S+/.exec(message.text)![0]);
  const token = confirm.searchParams.get('token')!;
  const verify = await call(magicLinkVerifyUrl(BASE, token, '/home').slice(BASE.length), { jar });
  expect(verify.status).toBe(302);
  const session = await (await call('/api/auth/get-session', { jar })).json();
  return { jar, email, userId: session.user.id as string, sessionId: session.session.id as string };
}

/** What the desktop app holds: a fresh state + PKCE verifier. */
async function desktopRequest() {
  const state = randomDesktopValue();
  const verifier = randomDesktopValue();
  return { state, verifier, challenge: await pkceChallenge(verifier) };
}

async function issueCode(jar: Jar, state: string, challenge: string, origin?: string) {
  return call('/api/auth/desktop/code', {
    method: 'POST',
    jar,
    body: { state, challenge },
    origin,
  });
}

/** The code from a successful `/desktop/code` response (checked to be a well-formed deep link). */
async function codeFrom(res: Response, state: string) {
  expect(res.status).toBe(200);
  const { redirectUrl } = (await res.json()) as { redirectUrl: string };
  const link = parseDesktopDeepLink(redirectUrl);
  expect(link).toMatchObject({ kind: 'auth', state });
  return link!.code;
}

const exchange = (code: string, verifier: string) =>
  call('/api/auth/desktop/token', { method: 'POST', body: { code, verifier } });

// ---------------------------------------------------------------------------------------------------

describe('desktop code (browser side)', () => {
  it('needs a signed-in session', async () => {
    const { state, challenge } = await desktopRequest();
    const res = await call('/api/auth/desktop/code', {
      method: 'POST',
      body: { state, challenge },
      origin: BASE,
    });
    expect(res.status).toBe(401);
  });

  // Better Auth turns its origin check off under Vitest (NODE_ENV=test); the cross-site refusal is
  // covered by the web e2e against `next dev` (apps/web/e2e/desktop-sign-in.spec.ts).

  it('refuses a bearer-token caller (browser cookie sessions only)', async () => {
    const browser = await signedInBrowser();
    const first = await desktopRequest();
    const code = await codeFrom(
      await issueCode(browser.jar, first.state, first.challenge),
      first.state,
    );
    const token = (await exchange(code, first.verifier)).headers.get(AUTH_TOKEN_HEADER)!;
    const { state, challenge } = await desktopRequest();
    const res = await call('/api/auth/desktop/code', {
      method: 'POST',
      bearer: token,
      body: { state, challenge },
    });
    expect(res.status).toBe(403);
  });

  it('refuses malformed state or challenge', async () => {
    const { jar } = await signedInBrowser();
    const ok = await desktopRequest();
    for (const body of [
      { state: 'short', challenge: ok.challenge },
      { state: ok.state, challenge: `${ok.challenge}x` },
      { state: `${ok.state.slice(0, 42)}&`, challenge: ok.challenge },
    ]) {
      expect((await issueCode(jar, body.state, body.challenge)).status).toBe(400);
    }
  });

  it('stores only a hash of the code, expiring in about two minutes', async () => {
    const { jar, userId } = await signedInBrowser();
    const { state, challenge } = await desktopRequest();
    const code = await codeFrom(await issueCode(jar, state, challenge), state);
    const rows = await db
      .select()
      .from(schema.verification)
      .where(eq(schema.verification.identifier, await desktopCodeIdentifier(code)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.identifier).not.toContain(code);
    expect(rows[0]!.value).not.toContain(code);
    expect(JSON.parse(rows[0]!.value)).toEqual({ userId, challenge });
    const ttl = rows[0]!.expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(100_000);
    expect(ttl).toBeLessThanOrEqual(120_000);
  });
});

describe('desktop token exchange', () => {
  it('returns a signed bearer token for a new session in the user’s workspace', async () => {
    const browser = await signedInBrowser();
    const { state, verifier, challenge } = await desktopRequest();
    const code = await codeFrom(await issueCode(browser.jar, state, challenge), state);

    const res = await exchange(code, verifier);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      user: { id: browser.userId, email: browser.email, name: null },
    });
    const token = res.headers.get(AUTH_TOKEN_HEADER);
    expect(token).toMatch(/^[^.]+\.[^.]+$/); // `<session token>.<signature>`

    const session = await (await call('/api/auth/get-session', { bearer: token! })).json();
    expect(session.user.id).toBe(browser.userId);
    // Its own session (signing out on one side doesn't end the other), starting in their workspace.
    expect(session.session.id).not.toBe(browser.sessionId);
    expect(session.session.activeOrganizationId).toBe(
      await findFirstWorkspaceId(db, browser.userId),
    );
    // The code is gone.
    const left = await db
      .select()
      .from(schema.verification)
      .where(like(schema.verification.identifier, 'desktop-code:%'));
    expect(left.map((r) => r.identifier)).not.toContain(await desktopCodeIdentifier(code));
  });

  it('a code works once, even when two exchanges race', async () => {
    const { jar } = await signedInBrowser();
    const { state, verifier, challenge } = await desktopRequest();
    const code = await codeFrom(await issueCode(jar, state, challenge), state);
    const results = await Promise.all([exchange(code, verifier), exchange(code, verifier)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect((await exchange(code, verifier)).status).toBe(400);
  });

  it('refuses a wrong PKCE verifier, and the code is burnt', async () => {
    const { jar } = await signedInBrowser();
    const { state, verifier, challenge } = await desktopRequest();
    const code = await codeFrom(await issueCode(jar, state, challenge), state);
    const wrong = await exchange(code, randomDesktopValue());
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { code?: string }).code).toBe('invalid_grant');
    expect(wrong.headers.get(AUTH_TOKEN_HEADER)).toBeNull();
    expect((await exchange(code, verifier)).status).toBe(400);
  });

  it('refuses unknown, malformed and expired codes alike', async () => {
    const { userId } = await signedInBrowser();
    const { verifier, challenge } = await desktopRequest();
    const expired = randomDesktopValue();
    await db.insert(schema.verification).values({
      id: newId(),
      identifier: await desktopCodeIdentifier(expired),
      value: JSON.stringify({ userId, challenge }),
      expiresAt: new Date(Date.now() - 1000),
    });
    for (const code of [randomDesktopValue(), 'not-a-code', expired]) {
      const res = await exchange(code, verifier);
      expect(res.status).toBe(400);
      expect(res.headers.get(AUTH_TOKEN_HEADER)).toBeNull();
    }
  });

  it('sign-out with the bearer token revokes only the desktop session', async () => {
    const browser = await signedInBrowser();
    const { state, verifier, challenge } = await desktopRequest();
    const code = await codeFrom(await issueCode(browser.jar, state, challenge), state);
    const token = (await exchange(code, verifier)).headers.get(AUTH_TOKEN_HEADER)!;

    // What the desktop main process sends: bearer, no cookies, no Origin.
    const out = await call('/api/auth/sign-out', { method: 'POST', bearer: token, body: {} });
    expect(out.status).toBe(200);
    expect(await (await call('/api/auth/get-session', { bearer: token })).json()).toBeNull();
    const still = await (await call('/api/auth/get-session', { jar: browser.jar })).json();
    expect(still.user.id).toBe(browser.userId);
  });
});
