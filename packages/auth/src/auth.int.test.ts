/**
 * End-to-end auth flows against the compose stack (D-11): a throwaway Postgres DB, Mailpit for magic
 * links (real SMTP), and the mock Google OIDC issuer (non-interactive login form post). Requests go
 * through `auth.handler`, i.e. the same Request → Response path the Next.js route uses.
 */
import { canCreateInWorkspace } from '@oat/core';
import { createDb, type Db, migrate, newId, schema } from '@oat/db';
import {
  createMailpit,
  createTestDatabase,
  extractFirstLink,
  type TestDatabase,
  testEnv,
  uniqueAddress,
} from '@oat/testkit';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type AuthConfig, DEV_AUTH_SECRET } from './config.ts';
import { ensureFirstWorkspace, getJoinChoices } from './joining.ts';
import { type Auth, createAuth } from './server.ts';
import { MAGIC_LINK_CONFIRM_PATH, magicLinkVerifyUrl } from './magic-link.ts';
import { peekMagicLinkEmail } from './magic-link-lookup.ts';
import { deleteWorkspace } from './members.ts';
import { createRedisRateLimiter, type RateLimiter } from './rate-limit.ts';
import { findFirstWorkspaceId, listUserWorkspaces, loadPermissionContext } from './workspaces.ts';

const BASE = 'http://localhost:3000';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:63790';
const mailpit = createMailpit();

let testDb: TestDatabase;
let db: Db;
let auth: Auth;
let rateLimiter: RateLimiter;

beforeAll(async () => {
  testDb = await createTestDatabase();
  await migrate(testDb.url);
  db = createDb(testDb.url, { max: 4 });
  const smtp = testEnv.smtpConfig();
  const config: AuthConfig = {
    secret: DEV_AUTH_SECRET,
    baseURL: BASE,
    trustedOrigins: [],
    smtp: { ...smtp, from: 'Oat <no-reply@oat.localhost>' },
    google: { issuer: testEnv.oauthGoogleIssuer(), clientId: 'oat-dev', clientSecret: 'x' },
    // The real per-email limiter, against the compose Redis.
    redisUrl: REDIS_URL,
    maxTeamWorkspaces: 3,
    production: false,
  };
  // The real per-email limiter (official `redis` client) against the compose Redis; an outage here
  // would silently fail open, so make it fail the tests instead.
  rateLimiter = createRedisRateLimiter(REDIS_URL, {
    onError: (error) => {
      throw new Error(`compose Redis unavailable: ${String(error)}`);
    },
  });
  auth = createAuth({ db, config, rateLimiter });
});

afterAll(async () => {
  await rateLimiter?.close();
  await db?.$client.end();
  await testDb?.drop();
});

// ---------------------------------------------------------------------------------------------------
// Tiny cookie jar + request helpers
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
  headers(): Headers {
    return new Headers({ cookie: this.header() });
  }
}

async function call(jar: Jar, path: string, init: RequestInit = {}): Promise<Response> {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const headers = new Headers(init.headers);
  headers.set('origin', BASE);
  if (jar.header()) headers.set('cookie', jar.header());
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

/**
 * What the confirm page's POST does (apps/web `/api/sign-in/magic-link`): turn the emailed confirm
 * link into Better Auth's verify call.
 */
function consumeConfirmLink(jar: Jar, link: string) {
  const confirm = new URL(link);
  expect(confirm.origin + confirm.pathname).toBe(`${BASE}${MAGIC_LINK_CONFIRM_PATH}`);
  const token = confirm.searchParams.get('token')!;
  return call(jar, magicLinkVerifyUrl(BASE, token, confirm.searchParams.get('next') ?? '/home'));
}

/** Requests a magic link, reads it from Mailpit and confirms it. Returns the verify response. */
async function signInWithMagicLink(jar: Jar, email: string) {
  const before = (await mailpit.listFor(email)).map((m) => m.ID);
  const res = await postJson(jar, '/api/auth/sign-in/magic-link', { email, callbackURL: '/home' });
  expect(res.status).toBe(200);
  const message = await mailpit.waitForLatest(email, { timeout: 10_000 });
  expect(before).not.toContain(message.ID);
  const link = extractFirstLink(message);
  // The email links to the confirm page (link scanners can't consume a GET), never to the verify API.
  expect(link).toMatch(/^http:\/\/localhost:3000\/sign-in\/confirm\?token=[^&]+&next=%2Fhome$/);
  const verify = await consumeConfirmLink(jar, link!);
  return { verify, message, link: link! };
}

/** Starts Google sign-in, logs in at the mock issuer by form post, then follows the callback. */
async function signInWithGoogle(jar: Jar, email: string, name = 'Grace Hopper') {
  const start = await postJson(jar, '/api/auth/sign-in/social', {
    provider: 'google',
    callbackURL: '/home',
  });
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  expect(url.startsWith(`${testEnv.oauthGoogleIssuer()}/authorize`)).toBe(true);

  const login = await fetch(url, {
    method: 'POST',
    redirect: 'manual',
    body: new URLSearchParams({ username: email, claims: JSON.stringify({ name }) }),
  });
  expect(login.status).toBe(302);
  const callback = login.headers.get('location')!;
  expect(callback.startsWith(`${BASE}/api/auth/callback/google?`)).toBe(true);
  return call(jar, callback);
}

async function userByEmail(email: string) {
  const [row] = await db.select().from(schema.user).where(eq(schema.user.email, email));
  return row;
}

async function workspacesCreatedBy(userId: string) {
  return db.select().from(schema.workspace).where(eq(schema.workspace.createdBy, userId));
}

// ---------------------------------------------------------------------------------------------------

describe('magic link', () => {
  it('signs up: verified user, a workspace of their own + owner membership, active in the session', async () => {
    const email = uniqueAddress('magic');
    const jar = new Jar();
    const { verify, message } = await signInWithMagicLink(jar, email);

    // Our template: plain text + HTML, the same link in both.
    expect(message.Subject).toBe('Sign in to Oat');
    expect(message.Text).toContain('/sign-in/confirm?token=');
    expect(message.Text).not.toContain('/api/auth/magic-link/verify');
    expect(message.HTML).toContain('Sign in to Oat');

    expect(verify.status).toBe(302);
    expect(verify.headers.get('location')).toBe(`${BASE}/home`);

    const user = await userByEmail(email);
    expect(user).toMatchObject({ email, emailVerified: true });

    // D-36: an ordinary workspace (no kind), named for a user without a name, with a generated address.
    const own = await workspacesCreatedBy(user!.id);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ name: 'My workspace', deletedAt: null });
    expect(own[0]!.slug).toMatch(/^my-workspace-[0-9a-f]{8}$/);
    expect(own[0]).not.toHaveProperty('kind');
    const members = await db
      .select()
      .from(schema.membership)
      .where(eq(schema.membership.workspaceId, own[0]!.id));
    expect(members).toMatchObject([{ userId: user!.id, role: 'owner' }]);

    // The session cookie authenticates, and that workspace is active.
    const session = await auth.api.getSession({ headers: jar.headers() });
    expect(session?.user.email).toBe(email);
    expect(session?.session.activeOrganizationId).toBe(own[0]!.id);
    const [row] = await db.select().from(schema.session).where(eq(schema.session.userId, user!.id));
    expect(row?.activeWorkspaceId).toBe(own[0]!.id);
  });

  it('a second sign-in reuses the user and their workspace', async () => {
    const email = uniqueAddress('magic-again');
    await signInWithMagicLink(new Jar(), email);
    const first = await userByEmail(email);

    const jar = new Jar();
    const { verify } = await signInWithMagicLink(jar, email);
    expect(verify.status).toBe(302);
    const again = await userByEmail(email);
    expect(again?.id).toBe(first?.id);
    expect(await workspacesCreatedBy(first!.id)).toHaveLength(1);
    expect(await listUserWorkspaces(db, first!.id)).toHaveLength(1);
    const sessions = await db
      .select()
      .from(schema.session)
      .where(eq(schema.session.userId, first!.id));
    expect(sessions).toHaveLength(2);
  });

  it('a magic link works once', async () => {
    const email = uniqueAddress('once');
    const jar = new Jar();
    const { link } = await signInWithMagicLink(jar, email);
    // Opening the confirm link (GET) consumes nothing; confirming it a second time fails.
    const reuse = await consumeConfirmLink(new Jar(), link);
    expect(reuse.status).toBe(302);
    expect(reuse.headers.get('location')).toBe(`${BASE}/sign-in?error=INVALID_TOKEN`);
    expect(reuse.headers.getSetCookie().join()).not.toContain('session_token=');
  });

  it('the confirm page can read which address a pending link is for, without consuming it', async () => {
    const email = uniqueAddress('peek');
    const res = await postJson(new Jar(), '/api/auth/sign-in/magic-link', {
      email,
      callbackURL: '/home',
    });
    expect(res.status).toBe(200);
    const link = extractFirstLink(await mailpit.waitForLatest(email, { timeout: 10_000 }))!;
    const token = new URL(link).searchParams.get('token')!;
    expect(await peekMagicLinkEmail(db, token)).toBe(email);
    expect(await peekMagicLinkEmail(db, token)).toBe(email); // still pending
    expect(await peekMagicLinkEmail(db, `${token}x`)).toBeUndefined();
    const verify = await consumeConfirmLink(new Jar(), link);
    expect(verify.headers.get('location')).toBe(`${BASE}/home`);
    expect(await peekMagicLinkEmail(db, token)).toBeUndefined(); // consumed
  });
});

describe('magic link limits', () => {
  it('the Redis limiter counts per key in a fixed window (compose Redis)', async () => {
    const key = `int-${newId()}`;
    const hits = [];
    for (let i = 0; i < 3; i++) hits.push(await rateLimiter.hit(key, 2, 60));
    expect(hits.map((h) => [h.allowed, h.count])).toEqual([
      [true, 1],
      [true, 2],
      [false, 3],
    ]);
    expect(hits[2]!.retryAfter).toBeGreaterThan(0);
    expect(hits[2]!.retryAfter).toBeLessThanOrEqual(60);
    expect((await rateLimiter.hit(`${key}-other`, 2, 60)).allowed).toBe(true);
  });

  it('sends at most 5 links per address per window (per-email, Redis-backed)', async () => {
    const email = uniqueAddress('limit');
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      // A fresh jar each time: a new "client", like a mail-bomber rotating IPs.
      const res = await postJson(new Jar(), '/api/auth/sign-in/magic-link', {
        email,
        callbackURL: '/home',
      });
      statuses.push(res.status);
      if (res.status === 429) expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    // Case-insensitive: same address, different case, still limited.
    const upper = await postJson(new Jar(), '/api/auth/sign-in/magic-link', {
      email: email.toUpperCase(),
      callbackURL: '/home',
    });
    expect(upper.status).toBe(429);
    // Another address is unaffected.
    const other = await postJson(new Jar(), '/api/auth/sign-in/magic-link', {
      email: uniqueAddress('limit-other'),
      callbackURL: '/home',
    });
    expect(other.status).toBe(200);
  });
});

describe('Google (mock OIDC issuer)', () => {
  it('creates a user with a google account and a workspace named after them', async () => {
    const email = uniqueAddress('google');
    const jar = new Jar();
    const res = await signInWithGoogle(jar, email, 'Grace Hopper');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/home');

    const user = await userByEmail(email);
    expect(user).toMatchObject({ email, name: 'Grace Hopper', emailVerified: true });
    const accounts = await db
      .select()
      .from(schema.account)
      .where(eq(schema.account.userId, user!.id));
    expect(accounts).toMatchObject([{ providerId: 'google', accountId: email }]);
    const own = await workspacesCreatedBy(user!.id);
    expect(own.map((w) => w.name)).toEqual(['Grace’s workspace']);
    expect(own[0]!.slug).toMatch(/^grace-s-workspace-[0-9a-f]{8}$/);

    const session = await auth.api.getSession({ headers: jar.headers() });
    expect(session?.user.id).toBe(user!.id);
  });

  it('links Google to an existing magic-link user with the same email', async () => {
    const email = uniqueAddress('link');
    await signInWithMagicLink(new Jar(), email);
    const user = await userByEmail(email);

    const jar = new Jar();
    const res = await signInWithGoogle(jar, email);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/home');

    const accounts = await db
      .select({ providerId: schema.account.providerId })
      .from(schema.account)
      .where(eq(schema.account.userId, user!.id));
    expect(accounts.map((a) => a.providerId)).toContain('google');
    const users = await db.select().from(schema.user).where(eq(schema.user.email, email));
    expect(users).toHaveLength(1);
    expect(await workspacesCreatedBy(user!.id)).toHaveLength(1);
  });
});

describe('sessions', () => {
  it('a signed bearer token authenticates (desktop); an unsigned one does not', async () => {
    const jar = new Jar();
    const { verify } = await signInWithMagicLink(jar, uniqueAddress('bearer'));
    const token = verify.headers.get('set-auth-token');
    expect(token).toContain('.');

    const ok = await auth.handler(
      new Request(`${BASE}/api/auth/get-session`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(((await ok.json()) as { user?: { id: string } } | null)?.user?.id).toBeTruthy();

    const unsigned = await auth.handler(
      new Request(`${BASE}/api/auth/get-session`, {
        headers: { authorization: `Bearer ${token!.split('.')[0]}` },
      }),
    );
    expect(await unsigned.json()).toBeNull();
  });

  it('sign-out ends the session', async () => {
    const jar = new Jar();
    await signInWithMagicLink(jar, uniqueAddress('signout'));
    expect(await auth.api.getSession({ headers: jar.headers() })).not.toBeNull();
    const res = await postJson(jar, '/api/auth/sign-out', {});
    expect(res.status).toBe(200);
    expect(await auth.api.getSession({ headers: jar.headers() })).toBeNull();
  });
});

describe('workspaces and roles', () => {
  async function signedIn(prefix: string) {
    const jar = new Jar();
    const email = uniqueAddress(prefix);
    await signInWithMagicLink(jar, email);
    const user = (await userByEmail(email))!;
    return { jar, user, headers: jar.headers() };
  }

  it('API-created workspaces are created by the caller, next to their first one', async () => {
    const owner = await signedIn('owner');
    const org = await auth.api.createOrganization({
      body: { name: 'Acme', slug: `acme-${owner.user.id}` },
      headers: owner.headers,
    });
    const [ws] = await db.select().from(schema.workspace).where(eq(schema.workspace.id, org!.id));
    expect(ws).toMatchObject({ createdBy: owner.user.id });
    // Listed by name; nothing tells them apart but that (D-36).
    const list = await listUserWorkspaces(db, owner.user.id);
    expect(list.map((w) => [w.name, w.role, w.memberCount])).toEqual([
      ['Acme', 'owner', 1],
      ['My workspace', 'owner', 1],
    ]);
  });

  // 1.6 review #2: tampering through the HTTP API. Since D-36 there is no `kind` to flip and no reserved
  // address; what stays server-owned is who created a workspace.
  describe('workspace field tampering', () => {
    const create = (jar: Jar, body: Record<string, unknown>) =>
      postJson(jar, '/api/auth/organization/create', body);
    const update = (jar: Jar, organizationId: string, data: Record<string, unknown>) =>
      postJson(jar, '/api/auth/organization/update', { organizationId, data });
    const row = async (id: string) =>
      (await db.select().from(schema.workspace).where(eq(schema.workspace.id, id)))[0]!;

    it('create: `createdBy` from the body is ignored', async () => {
      const owner = await signedIn('tamper-create');
      const res = await create(owner.jar, {
        name: 'Sneaky',
        slug: `sneaky-${owner.user.id}`,
        createdBy: 'someone-else',
      });
      expect(res.status).toBe(200);
      const created = (await res.json()) as { id: string };
      expect(await row(created.id)).toMatchObject({
        slug: `sneaky-${owner.user.id}`,
        createdBy: owner.user.id,
      });
      expect((await workspacesCreatedBy(owner.user.id)).map((w) => w.id)).toContain(created.id);
    });

    it('a first workspace is an ordinary one: rename it, change its address, invite into it', async () => {
      const owner = await signedIn('tamper-first');
      const id = (await findFirstWorkspaceId(db, owner.user.id))!;

      expect((await update(owner.jar, id, { createdBy: 'x' })).status).toBeGreaterThanOrEqual(400);
      expect((await row(id)).createdBy).toBe(owner.user.id);

      const moved = await update(owner.jar, id, { slug: `moved-${owner.user.id}` });
      expect(moved.status).toBe(200);
      const renamed = await update(owner.jar, id, { name: 'My notes' });
      expect(renamed.status).toBe(200);
      expect(await row(id)).toMatchObject({ name: 'My notes', slug: `moved-${owner.user.id}` });

      const invitation = await auth.api.createInvitation({
        body: { email: uniqueAddress('inv'), role: 'member', organizationId: id },
        headers: owner.headers,
      });
      expect(invitation.status).toBe('pending');

      // Signing in again still finds the same, single workspace.
      await signInWithMagicLink(new Jar(), owner.user.email);
      expect((await listUserWorkspaces(db, owner.user.id)).map((w) => w.id)).toEqual([id]);
    });

    it('updates: the address must be valid and only owners change it', async () => {
      const owner = await signedIn('tamper-team');
      const org = (await auth.api.createOrganization({
        body: { name: 'Team', slug: `team-${owner.user.id}` },
        headers: owner.headers,
      }))!;
      expect((await update(owner.jar, org.id, { slug: 'Not A Slug' })).status).toBe(400);
      expect(await row(org.id)).toMatchObject({ slug: `team-${owner.user.id}` });
      const ok = await update(owner.jar, org.id, { slug: `team-renamed-${owner.user.id}` });
      expect(ok.status).toBe(200);
      expect((await row(org.id)).slug).toBe(`team-renamed-${owner.user.id}`);
    });
  });

  // D-36: nobody is left without a workspace, and nobody gets one they don't need.
  describe('first workspace', () => {
    const newUser = async (prefix: string, name: string | null = null) =>
      (
        await db
          .insert(schema.user)
          .values({ email: uniqueAddress(prefix), name, emailVerified: true })
          .returning()
      )[0]!;

    /** An invitation row as Better Auth writes it (no email is sent). */
    const invited = async (
      inviter: { user: { id: string } },
      workspaceId: string,
      email: string,
      overrides: Partial<typeof schema.invite.$inferInsert> = {},
    ) =>
      (
        await db
          .insert(schema.invite)
          .values({
            workspaceId,
            email,
            role: 'member',
            inviterId: inviter.user.id,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
            ...overrides,
          })
          .returning()
      )[0]!;

    it('concurrent calls for a user without one create exactly one, as owner', async () => {
      const user = await newUser('race', 'Race Car');
      const results = await Promise.all(
        Array.from({ length: 8 }, () => ensureFirstWorkspace(db, user.id)),
      );
      expect(new Set(results.map((r) => r.workspaceId)).size).toBe(1);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(await workspacesCreatedBy(user.id)).toHaveLength(1);
      const list = await listUserWorkspaces(db, user.id);
      expect(list.map((w) => [w.name, w.role, w.memberCount])).toEqual([
        ['Race’s workspace', 'owner', 1],
      ]);
    });

    it('does nothing for a user who already has a workspace (their oldest is returned)', async () => {
      const owner = await signedIn('ensure-again');
      const first = (await findFirstWorkspaceId(db, owner.user.id))!;
      await auth.api.createOrganization({
        body: { name: 'Aardvark', slug: `aardvark-${owner.user.id}` },
        headers: owner.headers,
      });
      expect(await ensureFirstWorkspace(db, owner.user.id)).toEqual({
        workspaceId: first,
        created: false,
      });
      expect(await workspacesCreatedBy(owner.user.id)).toHaveLength(2);
      await expect(ensureFirstWorkspace(db, 'no-such-user')).rejects.toThrow(/unknown user/);
    });

    it('an invited newcomer gets no workspace until they answer; declining gives them their own', async () => {
      const owner = await signedIn('inviter');
      const first = (await findFirstWorkspaceId(db, owner.user.id))!;
      const email = uniqueAddress('newcomer');
      const invitation = await invited(owner, first, email);

      const jar = new Jar();
      await signInWithMagicLink(jar, email);
      const user = (await userByEmail(email))!;
      expect(await listUserWorkspaces(db, user.id)).toEqual([]);
      expect(await workspacesCreatedBy(user.id)).toEqual([]);
      const session = await auth.api.getSession({ headers: jar.headers() });
      expect(session?.session.activeOrganizationId ?? null).toBeNull();
      // Asking again changes nothing: there is a choice to make first (the join screen shows it).
      expect(await ensureFirstWorkspace(db, user.id)).toEqual({
        workspaceId: undefined,
        created: false,
        choices: true,
      });
      expect((await getJoinChoices(db, user.id)).invites.map((i) => i.token)).toEqual([
        invitation.token,
      ]);

      await auth.api.rejectInvitation({
        body: { invitationId: invitation.id },
        headers: jar.headers(),
      });
      const own = await ensureFirstWorkspace(db, user.id);
      expect(own.created).toBe(true);
      expect((await listUserWorkspaces(db, user.id)).map((w) => [w.id, w.name, w.role])).toEqual([
        [own.workspaceId, 'My workspace', 'owner'],
      ]);
    });

    it('an invited newcomer who accepts is only in that workspace, and starts there', async () => {
      const owner = await signedIn('inviter-yes');
      const first = (await findFirstWorkspaceId(db, owner.user.id))!;
      const email = uniqueAddress('joiner');
      const invitation = await invited(owner, first, email);

      const jar = new Jar();
      await signInWithMagicLink(jar, email);
      const user = (await userByEmail(email))!;
      await auth.api.acceptInvitation({
        body: { invitationId: invitation.id },
        headers: jar.headers(),
      });
      expect((await listUserWorkspaces(db, user.id)).map((w) => [w.id, w.role])).toEqual([
        [first, 'member'],
      ]);
      expect(await ensureFirstWorkspace(db, user.id)).toEqual({
        workspaceId: first,
        created: false,
      });
      expect(await workspacesCreatedBy(user.id)).toEqual([]);

      const again = new Jar();
      await signInWithMagicLink(again, email);
      const session = await auth.api.getSession({ headers: again.headers() });
      expect(session?.session.activeOrganizationId).toBe(first);
    });

    it('an expired, answered or revoked invitation, or one into a deleted workspace, holds nothing back', async () => {
      const owner = await signedIn('inviter-stale');
      const first = (await findFirstWorkspaceId(db, owner.user.id))!;
      const gone = (await auth.api.createOrganization({
        body: { name: 'Gone', slug: `gone-${owner.user.id}` },
        headers: owner.headers,
      }))!;
      await deleteWorkspace(db, { actorId: owner.user.id, workspaceId: gone.id });

      const user = await newUser('stale');
      await invited(owner, first, user.email, { expiresAt: new Date(Date.now() - 1000) });
      await invited(owner, first, user.email, { status: 'canceled' });
      await invited(owner, first, user.email, { status: 'rejected' });
      await invited(owner, gone.id, user.email);
      // Someone else's pending invitation is not mine.
      await invited(owner, first, uniqueAddress('other'));

      const own = await ensureFirstWorkspace(db, user.id);
      expect(own.created).toBe(true);
      // A pending invitation is matched whatever the case of the address.
      const shouty = await newUser('shouty');
      const waiting = await invited(owner, first, shouty.email.toUpperCase());
      expect(await ensureFirstWorkspace(db, shouty.id)).toMatchObject({
        workspaceId: undefined,
        choices: true,
      });
      expect((await getJoinChoices(db, shouty.id)).invites.map((i) => i.token)).toEqual([
        waiting.token,
      ]);
    });
  });

  // D-36: a new session starts in the workspace last switched to, else the oldest membership.
  describe('where a session starts', () => {
    const activeOf = async (jar: Jar) =>
      (await auth.api.getSession({ headers: jar.headers() }))?.session.activeOrganizationId;
    const freshSession = async (email: string) => {
      const jar = new Jar();
      await signInWithMagicLink(jar, email);
      return jar;
    };

    it('last active workspace, else the oldest membership; a workspace that is gone is skipped', async () => {
      const me = await signedIn('starter');
      const email = me.user.email;
      const first = (await findFirstWorkspaceId(db, me.user.id))!;
      // Two more memberships (added by someone else: nothing the user chose). Their names sort before
      // "My workspace": the list order must not decide.
      const added = async (name: string) => {
        const [ws] = await db
          .insert(schema.workspace)
          .values({ name, slug: `${name.toLowerCase()}-${me.user.id}`, createdBy: me.user.id })
          .returning();
        await db
          .insert(schema.membership)
          .values({ workspaceId: ws!.id, userId: me.user.id, role: 'owner' });
        return ws!;
      };
      const b = await added('Aardvark');
      const c = await added('Beaver');

      // Nothing chosen yet: the oldest membership.
      const second = await freshSession(email);
      expect(await activeOf(second)).toBe(first);

      // Switching over HTTP is remembered for the next sign-in…
      const switched = await postJson(second, '/api/auth/organization/set-active', {
        organizationId: b.id,
      });
      expect(switched.status).toBe(200);
      const third = await freshSession(email);
      expect(await activeOf(third)).toBe(b.id);

      // …and so is the app's own in-process call (the web's `switchWorkspace` action).
      await auth.api.setActiveOrganization({
        body: { organizationId: c.id },
        headers: third.headers(),
      });
      const [row] = await db.select().from(schema.user).where(eq(schema.user.id, me.user.id));
      expect(row?.lastActiveWorkspaceId).toBe(c.id);

      // A refused switch (not a member) is not remembered.
      const stranger = await signedIn('starter-stranger');
      const theirs = (await findFirstWorkspaceId(db, stranger.user.id))!;
      const refused = await postJson(third, '/api/auth/organization/set-active', {
        organizationId: theirs,
      });
      expect(refused.status).toBeGreaterThanOrEqual(400);
      const fourth = await freshSession(email);
      expect(await activeOf(fourth)).toBe(c.id);

      // The remembered workspace is deleted: back to the oldest membership.
      await deleteWorkspace(db, { actorId: me.user.id, workspaceId: c.id });
      const fifth = await freshSession(email);
      expect(await activeOf(fifth)).toBe(first);
    });

    // Review (step A) #3: Better Auth makes these active in the session without `set-active`.
    it('a workspace the user creates, or joins by accepting an invitation, is where they start next', async () => {
      const me = await signedIn('starter-joins');
      const first = (await findFirstWorkspaceId(db, me.user.id))!;
      const lastActive = async () =>
        (await db.select().from(schema.user).where(eq(schema.user.id, me.user.id)))[0]
          ?.lastActiveWorkspaceId;

      // Created (and switched to, as Better Auth does by default): remembered.
      const created = (await auth.api.createOrganization({
        body: { name: 'Aardvark', slug: `made-${me.user.id}` },
        headers: me.headers,
      }))!;
      expect(await lastActive()).toBe(created.id);
      expect(await activeOf(await freshSession(me.user.email))).toBe(created.id);
      // Created without switching to it: not where the user is.
      await auth.api.createOrganization({
        body: { name: 'Side', slug: `side-${me.user.id}`, keepCurrentActiveOrganization: true },
        headers: me.headers,
      });
      expect(await lastActive()).toBe(created.id);

      // Accepting an invitation into someone else's workspace: remembered too.
      const host = await signedIn('starter-host');
      const theirs = (await findFirstWorkspaceId(db, host.user.id))!;
      const [invitation] = await db
        .insert(schema.invite)
        .values({
          workspaceId: theirs,
          email: me.user.email,
          role: 'member',
          inviterId: host.user.id,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        })
        .returning();
      await auth.api.acceptInvitation({
        body: { invitationId: invitation!.id },
        headers: me.headers,
      });
      expect(await lastActive()).toBe(theirs);
      expect(await activeOf(await freshSession(me.user.email))).toBe(theirs);
      expect(theirs).not.toBe(first);

      // A refused accept (someone else's invitation) changes nothing.
      const [other] = await db
        .insert(schema.invite)
        .values({
          workspaceId: first,
          email: uniqueAddress('not-host'),
          role: 'member',
          inviterId: me.user.id,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        })
        .returning();
      await expect(
        auth.api.acceptInvitation({ body: { invitationId: other!.id }, headers: host.headers }),
      ).rejects.toThrow();
      const [hostRow] = await db.select().from(schema.user).where(eq(schema.user.id, host.user.id));
      expect(hostRow?.lastActiveWorkspaceId ?? null).toBeNull();
    });
  });

  it('caps the workspaces one user can create (on top of their first)', async () => {
    const owner = await signedIn('cap');
    for (let i = 0; i < 3; i++) {
      await auth.api.createOrganization({
        body: { name: `T${i}`, slug: `cap-${i}-${owner.user.id}` },
        headers: owner.headers,
      });
    }
    await expect(
      auth.api.createOrganization({
        body: { name: 'T3', slug: `cap-3-${owner.user.id}` },
        headers: owner.headers,
      }),
    ).rejects.toThrow(/maximum/i);
  });

  it('viewer cannot create documents; member can (permission hookup)', async () => {
    const owner = await signedIn('team-owner');
    const viewer = await signedIn('viewer');
    const member = await signedIn('member');
    const org = (await auth.api.createOrganization({
      body: { name: 'Docs team', slug: `docs-${owner.user.id}` },
      headers: owner.headers,
    }))!;
    await auth.api.addMember({
      body: { userId: viewer.user.id, role: 'viewer', organizationId: org.id },
    });
    await auth.api.addMember({
      body: { userId: member.user.id, role: 'member', organizationId: org.id },
    });
    const team = { id: org.id };

    // @oat/core is the source of truth.
    expect(canCreateInWorkspace(await loadPermissionContext(db, viewer.user.id), team)).toBe(false);
    expect(canCreateInWorkspace(await loadPermissionContext(db, member.user.id), team)).toBe(true);

    // Better Auth's access control agrees.
    const can = async (headers: Headers) =>
      (
        await auth.api.hasPermission({
          headers,
          body: { organizationId: org.id, permissions: { document: ['create'] } },
        })
      ).success;
    expect(await can(viewer.headers)).toBe(false);
    expect(await can(member.headers)).toBe(true);

    // Viewers can't invite, and nobody invites into a workspace they aren't in.
    await expect(
      auth.api.createInvitation({
        body: { email: uniqueAddress('x'), role: 'viewer', organizationId: org.id },
        headers: viewer.headers,
      }),
    ).rejects.toThrow();
    const ownerFirst = (await findFirstWorkspaceId(db, owner.user.id))!;
    await expect(
      auth.api.createInvitation({
        body: { email: uniqueAddress('y'), role: 'member', organizationId: ownerFirst },
        headers: member.headers,
      }),
    ).rejects.toThrow();

    // Owners can invite into any workspace of theirs — the one made for them at sign-up too (D-36).
    for (const organizationId of [org.id, ownerFirst]) {
      const invite = await auth.api.createInvitation({
        body: { email: uniqueAddress('z'), role: 'member', organizationId },
        headers: owner.headers,
      });
      expect(invite.status).toBe('pending');
    }
  });
});
