/**
 * "Connect Google Calendar" end to end (7.4): Better Auth (throwaway DB) + the compose mock OIDC issuer for
 * the OAuth dance + an in-process gcal mock (`startMocks()`, this checkout's code) for the Calendar API,
 * read through `@oat/calendar/google` with tokens from the connected account.
 */
import { GoogleCalendarSource } from '@oat/calendar/google';
import { createDb, type Db, migrate, schema } from '@oat/db';
import { gcalProvider, type RunningMocks, startMocks } from '@oat/mocks';
import { createTestDatabase, type TestDatabase, testEnv, uniqueAddress } from '@oat/testkit';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type AuthConfig, DEV_AUTH_SECRET } from './config.ts';
import {
  disconnectGoogleCalendar,
  findGoogleCalendarConnection,
  GOOGLE_CALENDAR_PROVIDER_ID,
  GOOGLE_CALENDAR_SCOPE,
  googleCalendarTokenProvider,
} from './google-calendar.ts';
import { createMemoryRateLimiter } from './rate-limit.ts';
import { type Auth, createAuth } from './server.ts';

const BASE = 'http://localhost:3000';
const WEEK = { from: new Date('2026-11-16T08:00:00Z'), to: new Date('2026-11-21T08:00:00Z') };

let testDb: TestDatabase;
let db: Db;
let auth: Auth;
let config: AuthConfig;
let mocks: RunningMocks;

beforeAll(async () => {
  testDb = await createTestDatabase();
  await migrate(testDb.url);
  db = createDb(testDb.url, { max: 4 });
  config = {
    secret: DEV_AUTH_SECRET,
    baseURL: BASE,
    trustedOrigins: [],
    smtp: { ...testEnv.smtpConfig(), from: 'Oat <no-reply@oat.localhost>' },
    google: { issuer: testEnv.oauthGoogleIssuer(), clientId: 'oat-dev', clientSecret: 'x' },
    maxTeamWorkspaces: 3,
    production: false,
  };
  auth = createAuth({ db, config, rateLimiter: createMemoryRateLimiter() });
  mocks = await startMocks({ providers: [() => gcalProvider({ anchor: 'fixture' })] });
});

afterAll(async () => {
  await mocks?.close();
  await db?.$client.end();
  await testDb?.drop();
});

class Jar {
  #cookies = new Map<string, string>();
  store(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      const value = pair!.slice(i + 1).trim();
      if (value === '' || /max-age=0/i.test(c)) this.#cookies.delete(pair!.slice(0, i).trim());
      else this.#cookies.set(pair!.slice(0, i).trim(), value);
    }
  }
  header() {
    return [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

async function call(jar: Jar, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('origin', BASE);
  if (jar.header()) headers.set('cookie', jar.header());
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const res = await auth.handler(new Request(url, { ...init, headers, redirect: 'manual' }));
  jar.store(res);
  return res;
}

const postJson = (jar: Jar, path: string, body: unknown) =>
  call(jar, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** The mock issuer's login form, posted without a browser; returns the redirect back to the app. */
async function loginAtIssuer(authorizeUrl: string, email: string): Promise<string> {
  const login = await fetch(authorizeUrl, {
    method: 'POST',
    redirect: 'manual',
    body: new URLSearchParams({ username: email, claims: '{}' }),
  });
  expect(login.status).toBe(302);
  return login.headers.get('location')!;
}

async function signIn(email: string): Promise<{ jar: Jar; userId: string }> {
  const jar = new Jar();
  const start = await postJson(jar, '/api/auth/sign-in/social', {
    provider: 'google',
    callbackURL: '/home',
  });
  const { url } = (await start.json()) as { url: string };
  const res = await call(jar, await loginAtIssuer(url, email));
  expect(new URL(res.headers.get('location')!, BASE).href).toBe(`${BASE}/home`);
  const session = await auth.api.getSession({ headers: new Headers({ cookie: jar.header() }) });
  return { jar, userId: session!.user.id };
}

/** Settings → "Connect Google Calendar" → Google consent (as `googleEmail`) → back. */
async function connect(jar: Jar, googleEmail: string) {
  const start = await postJson(jar, '/api/auth/link-social', {
    provider: GOOGLE_CALENDAR_PROVIDER_ID,
    callbackURL: '/settings/integrations?connected=google-calendar',
    errorCallbackURL: '/settings/integrations',
  });
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const authorize = new URL(url);
  const callback = await loginAtIssuer(url, googleEmail);
  expect(callback.startsWith(`${BASE}/api/auth/callback/google-calendar?`)).toBe(true);
  const done = await call(jar, callback);
  return { authorize, location: new URL(done.headers.get('location')!, BASE).href };
}

const calendarRows = (userId: string) =>
  db
    .select()
    .from(schema.account)
    .where(
      and(
        eq(schema.account.userId, userId),
        eq(schema.account.providerId, GOOGLE_CALENDAR_PROVIDER_ID),
      ),
    );

describe('Connect Google Calendar', () => {
  it('asks for calendar.readonly offline, separately from sign-in, and stores the grant encrypted', async () => {
    const email = uniqueAddress('gcal');
    const { jar, userId } = await signIn(email);
    const [signInAccount] = await db
      .select()
      .from(schema.account)
      .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, 'google')));
    expect(signInAccount!.scope ?? '').not.toContain('calendar');

    const { authorize, location } = await connect(jar, email);
    expect(authorize.searchParams.get('scope')!.split(' ')).toEqual(
      expect.arrayContaining(['openid', 'email', GOOGLE_CALENDAR_SCOPE]),
    );
    expect(authorize.searchParams.get('access_type')).toBe('offline');
    expect(authorize.searchParams.get('prompt')).toBe('consent');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('redirect_uri')).toBe(
      `${BASE}/api/auth/callback/google-calendar`,
    );
    expect(location).toBe(`${BASE}/settings/integrations?connected=google-calendar`);

    const [row] = await calendarRows(userId);
    expect(row).toMatchObject({ accountId: email, providerId: GOOGLE_CALENDAR_PROVIDER_ID });
    expect(row!.scope).toContain(GOOGLE_CALENDAR_SCOPE);
    // Encrypted at rest: the mock issues JWT access tokens (`eyJ…`); the column holds ciphertext.
    expect(row!.accessToken).toBeTruthy();
    expect(row!.accessToken!.startsWith('eyJ')).toBe(false);
    expect(row!.refreshToken).toBeTruthy();

    const connection = await findGoogleCalendarConnection(db, userId);
    expect(connection).toMatchObject({
      accountId: row!.id,
      googleAccountId: email,
      email,
      hasCalendarScope: true,
    });
    const token = await googleCalendarTokenProvider(auth.api, { accountId: row!.id, userId })({
      forceRefresh: false,
    });
    expect(token.startsWith('eyJ')).toBe(true);

    // The sign-in account kept its minimal scopes.
    const [after] = await db
      .select()
      .from(schema.account)
      .where(eq(schema.account.id, signInAccount!.id));
    expect(after!.scope ?? '').not.toContain('calendar');
  });

  it('reads the calendar through the API mock with the stored tokens; refreshes them when needed', async () => {
    const email = uniqueAddress('gcal-read');
    const { jar, userId } = await signIn(email);
    await connect(jar, email);
    const connection = (await findGoogleCalendarConnection(db, userId))!;
    const getAccessToken = googleCalendarTokenProvider(auth.api, {
      accountId: connection.accountId,
      userId,
    });
    const source = new GoogleCalendarSource({
      clientOptions: { baseUrl: `${mocks.url}/gcal`, getAccessToken },
      now: () => new Date('2026-11-16T16:00:00Z'),
      minSyncIntervalMs: 0,
    });
    const events = await source.fetchEvents(WEEK);
    expect(events).toHaveLength(15);
    expect(events[1]).toMatchObject({ source: 'google', title: 'Daily standup' });

    // Expired access token → Better Auth refreshes it at the issuer on the next read and stores the new one.
    const before = await getAccessToken({ forceRefresh: false });
    await db
      .update(schema.account)
      .set({ accessTokenExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.account.id, connection.accountId));
    const refreshed = await getAccessToken({ forceRefresh: false });
    expect(refreshed).not.toBe(before);
    const [row] = await calendarRows(userId);
    expect(row!.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());

    // Google refuses the current token (revoked) → the source forces a refresh and retries.
    const revoke = await fetch(`${mocks.url}/gcal/_mock/revoke-token`, {
      method: 'POST',
      body: JSON.stringify({ token: refreshed }),
    });
    expect(revoke.status).toBe(200);
    await expect(source.fetchEvents(WEEK)).resolves.toHaveLength(15);
    expect(await getAccessToken({ forceRefresh: false })).not.toBe(refreshed);

    // Stale sync tokens (410) → full re-sync of every calendar.
    await fetch(`${mocks.url}/gcal/_mock/expire-sync-tokens`, { method: 'POST' });
    await expect(source.fetchEvents(WEEK)).resolves.toHaveLength(15);
    expect(source.stats.expiredSyncTokens).toBe(3);
    const gone = mocks.log.list({ provider: 'gcal' }).filter((r) => r.status === 410);
    expect(gone).toHaveLength(3);
  });

  it('a later Google sign-in leaves the calendar grant alone', async () => {
    const email = uniqueAddress('gcal-signin');
    const { jar, userId } = await signIn(email);
    await connect(jar, email);
    const [before] = await calendarRows(userId);
    await signIn(email);
    const [after] = await calendarRows(userId);
    expect(after).toMatchObject({
      accessToken: before!.accessToken,
      refreshToken: before!.refreshToken,
      scope: before!.scope,
    });
  });

  it('can’t be used to sign in', async () => {
    const res = await postJson(new Jar(), '/api/auth/sign-in/social', {
      provider: GOOGLE_CALENDAR_PROVIDER_ID,
      callbackURL: '/home',
    });
    expect(res.status).toBe(400);
  });

  it('can’t be linked from a caller-supplied id_token (no code exchange → no proof of scope)', async () => {
    const email = uniqueAddress('gcal-idtoken');
    const { jar, userId } = await signIn(email);
    // A genuine id_token for the same Google account, straight from the issuer.
    const issuer = testEnv.oauthGoogleIssuer();
    const authorize = `${issuer}/authorize?${new URLSearchParams({
      client_id: 'oat-dev',
      response_type: 'code',
      scope: 'openid email',
      redirect_uri: 'http://localhost/cb',
      state: 's',
    })}`;
    const code = new URL(await loginAtIssuer(authorize, email)).searchParams.get('code')!;
    const tokens = (await (
      await fetch(`${issuer}/token`, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: 'http://localhost/cb',
          client_id: 'oat-dev',
          client_secret: 'x',
        }),
      })
    ).json()) as { id_token: string; access_token: string };
    const res = await postJson(jar, '/api/auth/link-social', {
      provider: GOOGLE_CALENDAR_PROVIDER_ID,
      idToken: { token: tokens.id_token, accessToken: tokens.access_token },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/consent screen/);
    expect(await calendarRows(userId)).toEqual([]);
  });

  it('never hands provider tokens to the browser: token routes are off over HTTP', async () => {
    const email = uniqueAddress('gcal-routes');
    const { jar, userId } = await signIn(email);
    await connect(jar, email);
    const [row] = await calendarRows(userId);
    for (const path of ['/api/auth/get-access-token', '/api/auth/refresh-token']) {
      const res = await postJson(jar, path, { accountId: row!.id });
      expect(res.status, path).toBe(404);
    }
    expect((await call(jar, `/api/auth/account-info?accountId=${row!.id}`)).status).toBe(404);
    // The server-side API still works (what the app uses).
    const viaApi = await auth.api.getAccessToken({ body: { accountId: row!.id, userId } });
    expect(viaApi.accessToken).toBeTruthy();
  });

  it('needs a session, and the Google account must have the user’s email', async () => {
    const anonymous = await postJson(new Jar(), '/api/auth/link-social', {
      provider: GOOGLE_CALENDAR_PROVIDER_ID,
      callbackURL: '/settings/integrations',
    });
    expect(anonymous.status).toBe(401);

    const { jar, userId } = await signIn(uniqueAddress('gcal-me'));
    const { location } = await connect(jar, uniqueAddress('gcal-someone-else'));
    expect(location).toBe(`${BASE}/settings/integrations?error=email_does_not_match`);
    expect(await calendarRows(userId)).toEqual([]);
    expect(await findGoogleCalendarConnection(db, userId)).toBeNull();
  });

  it('disconnect revokes the grant at the issuer and deletes only the calendar account', async () => {
    const email = uniqueAddress('gcal-off');
    const { jar, userId } = await signIn(email);
    await connect(jar, email);
    const result = await disconnectGoogleCalendar({
      db,
      api: auth.api,
      google: config.google,
      userId,
    });
    expect(result).toEqual({ disconnected: true, revoked: true });
    expect(await calendarRows(userId)).toEqual([]);
    const accounts = await db
      .select()
      .from(schema.account)
      .where(eq(schema.account.userId, userId));
    expect(accounts.map((a) => a.providerId)).toEqual(['google']);
    expect(
      await disconnectGoogleCalendar({ db, api: auth.api, google: config.google, userId }),
    ).toEqual({ disconnected: false, revoked: false });
    // …and connecting again works.
    await connect(jar, email);
    expect(await findGoogleCalendarConnection(db, userId)).not.toBeNull();
  });
});
