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
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type AuthConfig, DEV_AUTH_SECRET } from './config.ts';
import { type Auth, createAuth } from './server.ts';
import { MAGIC_LINK_CONFIRM_PATH, magicLinkVerifyUrl } from './magic-link.ts';
import { peekMagicLinkEmail } from './magic-link-lookup.ts';
import { createRedisRateLimiter, type RateLimiter } from './rate-limit.ts';
import {
  ensurePersonalWorkspace,
  listUserWorkspaces,
  loadPermissionContext,
  personalWorkspaceSlug,
} from './workspaces.ts';

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

async function personalWorkspacesOf(userId: string) {
  return db
    .select()
    .from(schema.workspace)
    .where(and(eq(schema.workspace.createdBy, userId), eq(schema.workspace.kind, 'personal')));
}

// ---------------------------------------------------------------------------------------------------

describe('magic link', () => {
  it('signs up: verified user, personal workspace + owner membership, active in the session', async () => {
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

    const personal = await personalWorkspacesOf(user!.id);
    expect(personal).toHaveLength(1);
    expect(personal[0]).toMatchObject({
      name: 'Personal',
      slug: personalWorkspaceSlug(user!.id),
      kind: 'personal',
    });
    const members = await db
      .select()
      .from(schema.membership)
      .where(eq(schema.membership.workspaceId, personal[0]!.id));
    expect(members).toMatchObject([{ userId: user!.id, role: 'owner' }]);

    // The session cookie authenticates, and the personal workspace is active.
    const session = await auth.api.getSession({ headers: jar.headers() });
    expect(session?.user.email).toBe(email);
    expect(session?.session.activeOrganizationId).toBe(personal[0]!.id);
    const [row] = await db.select().from(schema.session).where(eq(schema.session.userId, user!.id));
    expect(row?.activeWorkspaceId).toBe(personal[0]!.id);
  });

  it('a second sign-in reuses the user and the personal workspace', async () => {
    const email = uniqueAddress('magic-again');
    await signInWithMagicLink(new Jar(), email);
    const first = await userByEmail(email);

    const jar = new Jar();
    const { verify } = await signInWithMagicLink(jar, email);
    expect(verify.status).toBe(302);
    const again = await userByEmail(email);
    expect(again?.id).toBe(first?.id);
    expect(await personalWorkspacesOf(first!.id)).toHaveLength(1);
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
  it('creates a user with a google account and a personal workspace', async () => {
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
    expect(await personalWorkspacesOf(user!.id)).toHaveLength(1);

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
    expect(await personalWorkspacesOf(user!.id)).toHaveLength(1);
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

  it('API-created workspaces are always team workspaces, created by the caller', async () => {
    const owner = await signedIn('owner');
    const org = await auth.api.createOrganization({
      body: { name: 'Acme', slug: `acme-${owner.user.id}` },
      headers: owner.headers,
    });
    const [ws] = await db.select().from(schema.workspace).where(eq(schema.workspace.id, org!.id));
    expect(ws).toMatchObject({ kind: 'team', createdBy: owner.user.id });
    const list = await listUserWorkspaces(db, owner.user.id);
    expect(list.map((w) => [w.kind, w.role, w.memberCount])).toEqual([
      ['personal', 'owner', 1],
      ['team', 'owner', 1],
    ]);
  });

  // 1.6 review #2: `kind`/slug tampering through the HTTP API.
  describe('workspace kind and slug tampering', () => {
    const create = (jar: Jar, body: Record<string, unknown>) =>
      postJson(jar, '/api/auth/organization/create', body);
    const update = (jar: Jar, organizationId: string, data: Record<string, unknown>) =>
      postJson(jar, '/api/auth/organization/update', { organizationId, data });
    const row = async (id: string) =>
      (await db.select().from(schema.workspace).where(eq(schema.workspace.id, id)))[0]!;

    it('create: `kind` from the body is ignored and `personal-` slugs are reserved', async () => {
      const owner = await signedIn('tamper-create');
      const withKind = await create(owner.jar, {
        name: 'Sneaky',
        slug: `sneaky-${owner.user.id}`,
        kind: 'personal',
      });
      // Better Auth drops `input: false` fields from the body: the workspace is a plain team one.
      expect(withKind.status).toBe(200);
      const created = (await withKind.json()) as { id: string };
      expect((await row(created.id)).kind).toBe('team');
      const reserved = await create(owner.jar, { name: 'X', slug: `personal-${owner.user.id}x` });
      expect(reserved.status).toBe(403);
      expect(await personalWorkspacesOf(owner.user.id)).toHaveLength(1);
      const teams = await db
        .select()
        .from(schema.workspace)
        .where(
          and(eq(schema.workspace.createdBy, owner.user.id), eq(schema.workspace.kind, 'team')),
        );
      expect(teams.map((t) => t.id)).toEqual([created.id]);
    });

    it('personal workspace: kind and slug are immutable, name can change', async () => {
      const owner = await signedIn('tamper-personal');
      const [personal] = await personalWorkspacesOf(owner.user.id);
      const id = personal!.id;

      expect((await update(owner.jar, id, { kind: 'team' })).status).toBeGreaterThanOrEqual(400);
      expect((await update(owner.jar, id, { createdBy: 'x' })).status).toBeGreaterThanOrEqual(400);
      expect((await update(owner.jar, id, { slug: `moved-${owner.user.id}` })).status).toBe(403);
      expect(await row(id)).toMatchObject({
        kind: 'personal',
        slug: personalWorkspaceSlug(owner.user.id),
        createdBy: owner.user.id,
      });

      // Flipping it to team would have allowed invites; still refused.
      await expect(
        auth.api.createInvitation({
          body: { email: uniqueAddress('inv'), role: 'member', organizationId: id },
          headers: owner.headers,
        }),
      ).rejects.toThrow();

      const renamed = await update(owner.jar, id, { name: 'My notes' });
      expect(renamed.status).toBe(200);
      expect((await row(id)).name).toBe('My notes');

      // Signing in again still finds the same, single personal workspace.
      await signInWithMagicLink(new Jar(), owner.user.email);
      const all = await personalWorkspacesOf(owner.user.id);
      expect(all.map((w) => w.id)).toEqual([id]);
    });

    it('team workspace: kind is immutable and `personal-` slugs are reserved', async () => {
      const owner = await signedIn('tamper-team');
      const org = (await auth.api.createOrganization({
        body: { name: 'Team', slug: `team-${owner.user.id}` },
        headers: owner.headers,
      }))!;
      expect((await update(owner.jar, org.id, { kind: 'personal' })).status).toBeGreaterThanOrEqual(
        400,
      );
      expect((await update(owner.jar, org.id, { slug: `personal-${newId()}` })).status).toBe(403);
      expect(await row(org.id)).toMatchObject({ kind: 'team', slug: `team-${owner.user.id}` });
      const ok = await update(owner.jar, org.id, { slug: `team-renamed-${owner.user.id}` });
      expect(ok.status).toBe(200);
      expect((await row(org.id)).slug).toBe(`team-renamed-${owner.user.id}`);
    });

    it('the database allows one personal workspace per user', async () => {
      const owner = await signedIn('tamper-db');
      await expect(
        db.insert(schema.workspace).values({
          name: 'Second',
          slug: `second-${owner.user.id}`,
          kind: 'personal',
          createdBy: owner.user.id,
        }),
      ).rejects.toThrow();
      expect(await ensurePersonalWorkspace(db, owner.user.id)).toBe(
        (await personalWorkspacesOf(owner.user.id))[0]!.id,
      );
    });
  });

  it('caps the team workspaces one user can create', async () => {
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
    const team = { id: org.id, kind: 'team' as const };

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

    // Viewers can't invite; owners can't invite into a personal workspace.
    await expect(
      auth.api.createInvitation({
        body: { email: uniqueAddress('x'), role: 'viewer', organizationId: org.id },
        headers: viewer.headers,
      }),
    ).rejects.toThrow();
    const ownerPersonal = (await listUserWorkspaces(db, owner.user.id)).find(
      (w) => w.kind === 'personal',
    )!;
    await expect(
      auth.api.createInvitation({
        body: { email: uniqueAddress('y'), role: 'member', organizationId: ownerPersonal.id },
        headers: owner.headers,
      }),
    ).rejects.toThrow(/one member|can’t invite/);
    await expect(
      auth.api.addMember({
        body: { userId: member.user.id, role: 'member', organizationId: ownerPersonal.id },
      }),
    ).rejects.toThrow(/one member/);

    // Owners can invite into a team workspace.
    const invite = await auth.api.createInvitation({
      body: { email: uniqueAddress('z'), role: 'member', organizationId: org.id },
      headers: owner.headers,
    });
    expect(invite.status).toBe('pending');
  });
});
