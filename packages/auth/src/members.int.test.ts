/**
 * Workspace members (5.1/5.2; one kind of workspace since D-36) against a throwaway Postgres database: invitations through Better Auth with
 * our hooks and email, accepting by the invited (verified) address only, and the member actions in
 * `members.ts` (role change, remove, leave, soft delete) with every deny case and the last-owner rule
 * under concurrency, plus the last-workspace rule (D-36). Mail is captured in memory here; the web e2e covers the Mailpit round trip.
 */
import { ForbiddenError, roleIn, type Role } from '@oat/core';
import { createDb, type Db, migrate, schema } from '@oat/db';
import { createTestDatabase, type TestDatabase, testEnv, uniqueAddress } from '@oat/testkit';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type AuthConfig, DEV_AUTH_SECRET } from './config.ts';
import type { EmailMessage, Mailer } from './email.ts';
import { ensureFirstWorkspace } from './joining.ts';
import { magicLinkVerifyUrl } from './magic-link.ts';
import {
  changeMemberRole,
  deleteWorkspace,
  findInviteByToken,
  inviteState,
  leaveWorkspace,
  listMembers,
  listPendingInvites,
  NotFoundError,
  removeMember,
} from './members.ts';
import { createMemoryRateLimiter } from './rate-limit.ts';
import {
  type Auth,
  BLOCKED_ORGANIZATION_PATHS,
  createAuth,
  DISABLED_AUTH_PATHS,
  INVITE_EMAIL_LIMITS,
} from './server.ts';
import { findFirstWorkspaceId, listUserWorkspaces, loadPermissionContext } from './workspaces.ts';

const BASE = 'http://localhost:3000';

let testDb: TestDatabase;
let db: Db;
let auth: Auth;
const outbox: EmailMessage[] = [];
const mailer: Mailer = {
  async send(message) {
    outbox.push(message);
  },
};

beforeAll(async () => {
  testDb = await createTestDatabase();
  await migrate(testDb.url);
  db = createDb(testDb.url, { max: 8 });
  const config: AuthConfig = {
    secret: DEV_AUTH_SECRET,
    baseURL: BASE,
    trustedOrigins: [],
    smtp: { ...testEnv.smtpConfig(), from: 'Oat <no-reply@oat.localhost>' },
    google: { issuer: testEnv.oauthGoogleIssuer(), clientId: 'oat-dev', clientSecret: 'x' },
    maxTeamWorkspaces: 50,
    production: false,
  };
  auth = createAuth({ db, config, mailer, rateLimiter: createMemoryRateLimiter() });
});

afterAll(async () => {
  await db?.$client.end();
  await testDb?.drop();
});

// ---------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------

const lastMailTo = (email: string) => outbox.findLast((m) => m.to === email);

class Jar {
  private cookies = new Map<string, string>();
  store(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      const name = pair!.slice(0, i).trim();
      const value = pair!.slice(i + 1).trim();
      if (value === '' || /max-age=0/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  headers(): Headers {
    return new Headers({ cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') });
  }
}

async function call(jar: Jar, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('origin', BASE);
  const cookie = jar.headers().get('cookie');
  if (cookie) headers.set('cookie', cookie);
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

interface Person {
  id: string;
  email: string;
  jar: Jar;
  headers: Headers;
}

/** Signs up by magic link (captured mail, the real verify endpoint): a verified user with a session. */
async function person(prefix: string): Promise<Person> {
  const email = uniqueAddress(prefix);
  const jar = new Jar();
  const res = await postJson(jar, '/api/auth/sign-in/magic-link', { email, callbackURL: '/home' });
  expect(res.status).toBe(200);
  const link = new URL(/https?:\/\/\S+/.exec(lastMailTo(email)!.text)![0]);
  const verify = await call(
    jar,
    magicLinkVerifyUrl(BASE, link.searchParams.get('token')!, '/home'),
  );
  expect(verify.status).toBe(302);
  const [row] = await db.select().from(schema.user).where(eq(schema.user.email, email));
  return { id: row!.id, email, jar, headers: jar.headers() };
}

async function teamOf(owner: Person, name = 'Acme'): Promise<string> {
  const org = await auth.api.createOrganization({
    body: { name, slug: `t-${crypto.randomUUID()}` },
    headers: owner.headers,
  });
  return org!.id;
}

async function addMember(workspaceId: string, p: Person, role: Role) {
  await db.insert(schema.membership).values({ workspaceId, userId: p.id, role });
}

async function roleOf(workspaceId: string, userId: string): Promise<Role | undefined> {
  const [row] = await db
    .select({ role: schema.membership.role })
    .from(schema.membership)
    .where(
      and(eq(schema.membership.workspaceId, workspaceId), eq(schema.membership.userId, userId)),
    );
  return row?.role;
}

const invite = (by: Person, workspaceId: string, email: string, role: Role) =>
  auth.api.createInvitation({
    body: { email, role, organizationId: workspaceId },
    headers: by.headers,
  });

const tokenFromMail = (email: string) => {
  const match = /\/invite\/([A-Za-z0-9_-]+)/.exec(lastMailTo(email)!.text);
  return match![1]!;
};

/** A fresh team: owner O, admin A, member M, viewer V. */
async function team() {
  const [owner, admin, member, viewer] = await Promise.all([
    person('owner'),
    person('admin'),
    person('member'),
    person('viewer'),
  ]);
  const ws = await teamOf(owner);
  await addMember(ws, admin, 'admin');
  await addMember(ws, member, 'member');
  await addMember(ws, viewer, 'viewer');
  return { ws, owner, admin, member, viewer };
}

// ---------------------------------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------------------------------

describe('invitations', () => {
  it('owner invites: our email links to /invite/<token>; the token finds the invite', async () => {
    const { ws, owner } = await team();
    const email = uniqueAddress('invitee');
    const created = await invite(owner, ws, email, 'admin');
    expect(created).toMatchObject({ email, role: 'admin', status: 'pending' });

    const mail = lastMailTo(email)!;
    expect(mail.subject).toMatch(/invited you to Acme on Oat$/);
    expect(mail.text).toContain(`${BASE}/invite/`);
    expect(mail.html).toContain(`${BASE}/invite/`);
    const token = tokenFromMail(email);
    const [row] = await db.select().from(schema.invite).where(eq(schema.invite.id, created!.id));
    expect(row!.token).toBe(token);
    // The link carries the invite's secret token, never its id.
    expect(mail.text).not.toContain(created!.id);
    // 7-day expiry.
    const days = (row!.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);

    const found = await findInviteByToken(db, token);
    expect(found).toMatchObject({
      id: created!.id,
      email,
      role: 'admin',
      state: 'pending',
      workspace: { id: ws, name: 'Acme' },
    });
    expect((await listPendingInvites(db, ws)).map((i) => i.email)).toEqual([email]);
    expect(await findInviteByToken(db, `${token}x`)).toBeUndefined();
  });

  it('admin invites members but not owners; members and viewers cannot invite', async () => {
    const { ws, admin, member, viewer } = await team();
    await expect(invite(admin, ws, uniqueAddress('a'), 'admin')).resolves.toBeTruthy();
    await expect(invite(admin, ws, uniqueAddress('a'), 'owner')).rejects.toThrow();
    await expect(invite(member, ws, uniqueAddress('m'), 'member')).rejects.toThrow();
    await expect(invite(member, ws, uniqueAddress('m'), 'admin')).rejects.toThrow();
    await expect(invite(viewer, ws, uniqueAddress('v'), 'viewer')).rejects.toThrow();
  });

  it('the invited user accepts: membership with the invited role, workspace active', async () => {
    const { ws, owner } = await team();
    const grace = await person('grace');
    const created = await invite(owner, ws, grace.email, 'member');
    const res = await postJson(grace.jar, '/api/auth/organization/accept-invitation', {
      invitationId: created!.id,
    });
    expect(res.status).toBe(200);
    expect(await roleOf(ws, grace.id)).toBe('member');
    const session = await auth.api.getSession({ headers: grace.jar.headers() });
    expect(session?.session.activeOrganizationId).toBe(ws);
    expect((await findInviteByToken(db, tokenFromMail(grace.email)))!.state).toBe('accepted');

    // Used: a second accept fails.
    const again = await postJson(grace.jar, '/api/auth/organization/accept-invitation', {
      invitationId: created!.id,
    });
    expect(again.status).toBe(400);
  });

  it('an invite cannot be accepted by a different email', async () => {
    const { ws, owner } = await team();
    const created = await invite(owner, ws, uniqueAddress('intended'), 'admin');
    const mallory = await person('mallory');
    const res = await postJson(mallory.jar, '/api/auth/organization/accept-invitation', {
      invitationId: created!.id,
    });
    expect(res.status).toBe(403);
    expect(await roleOf(ws, mallory.id)).toBeUndefined();
  });

  it('an unverified address cannot accept', async () => {
    const { ws, owner } = await team();
    const una = await person('unverified');
    await db.update(schema.user).set({ emailVerified: false }).where(eq(schema.user.id, una.id));
    const created = await invite(owner, ws, una.email, 'member');
    const res = await postJson(una.jar, '/api/auth/organization/accept-invitation', {
      invitationId: created!.id,
    });
    expect(res.status).toBe(403);
    expect(await roleOf(ws, una.id)).toBeUndefined();
  });

  it('expired invites cannot be accepted; resending renews the same link', async () => {
    const { ws, owner } = await team();
    const late = await person('late');
    const created = await invite(owner, ws, late.email, 'member');
    const token = tokenFromMail(late.email);
    await db
      .update(schema.invite)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.invite.id, created!.id));
    expect((await findInviteByToken(db, token))!.state).toBe('expired');
    const res = await postJson(late.jar, '/api/auth/organization/accept-invitation', {
      invitationId: created!.id,
    });
    expect(res.status).toBe(400);
    expect(await roleOf(ws, late.id)).toBeUndefined();
    expect((await listPendingInvites(db, ws))[0]).toMatchObject({ state: 'expired' });
  });

  it('a revoked invite cannot be accepted', async () => {
    const { ws, admin } = await team();
    const rev = await person('revoked');
    const created = await invite(admin, ws, rev.email, 'member');
    await auth.api.cancelInvitation({
      body: { invitationId: created!.id },
      headers: admin.headers,
    });
    expect((await findInviteByToken(db, tokenFromMail(rev.email)))!.state).toBe('canceled');
    expect(await listPendingInvites(db, ws)).toEqual([]);
    const res = await postJson(rev.jar, '/api/auth/organization/accept-invitation', {
      invitationId: created!.id,
    });
    expect(res.status).toBe(400);
    expect(await roleOf(ws, rev.id)).toBeUndefined();
  });

  it('members and viewers cannot revoke invites', async () => {
    const { ws, owner, member, viewer } = await team();
    const created = await invite(owner, ws, uniqueAddress('keep'), 'member');
    for (const p of [member, viewer]) {
      await expect(
        auth.api.cancelInvitation({ body: { invitationId: created!.id }, headers: p.headers }),
      ).rejects.toThrow();
    }
    expect(await listPendingInvites(db, ws)).toHaveLength(1);
  });

  it('declining marks the invite rejected and adds nobody', async () => {
    const { ws, owner } = await team();
    const no = await person('declines');
    const created = await invite(owner, ws, no.email, 'member');
    const res = await postJson(no.jar, '/api/auth/organization/reject-invitation', {
      invitationId: created!.id,
    });
    expect(res.status).toBe(200);
    expect((await findInviteByToken(db, tokenFromMail(no.email)))!.state).toBe('rejected');
    expect(await roleOf(ws, no.id)).toBeUndefined();
  });

  it('inviteState maps statuses and expiry', () => {
    const future = new Date(Date.now() + 1000);
    const past = new Date(Date.now() - 1000);
    expect(inviteState({ status: 'pending', expiresAt: future })).toBe('pending');
    expect(inviteState({ status: 'pending', expiresAt: past })).toBe('expired');
    expect(inviteState({ status: 'accepted', expiresAt: past })).toBe('accepted');
    expect(inviteState({ status: 'rejected', expiresAt: future })).toBe('rejected');
    expect(inviteState({ status: 'canceled', expiresAt: future })).toBe('canceled');
  });
});

// ---------------------------------------------------------------------------------------------------
// Member actions
// ---------------------------------------------------------------------------------------------------

describe('changing roles', () => {
  it('owners change anyone; admins only members/viewers and up to admin', async () => {
    const { ws, owner, admin, member, viewer } = await team();
    await changeMemberRole(db, {
      actorId: owner.id,
      workspaceId: ws,
      userId: admin.id,
      role: 'member',
    });
    expect(await roleOf(ws, admin.id)).toBe('member');
    await changeMemberRole(db, {
      actorId: owner.id,
      workspaceId: ws,
      userId: admin.id,
      role: 'admin',
    });

    await changeMemberRole(db, {
      actorId: admin.id,
      workspaceId: ws,
      userId: viewer.id,
      role: 'member',
    });
    expect(await roleOf(ws, viewer.id)).toBe('member');
    await changeMemberRole(db, {
      actorId: admin.id,
      workspaceId: ws,
      userId: member.id,
      role: 'admin',
    });
    expect(await roleOf(ws, member.id)).toBe('admin');
  });

  it('deny: admin demotes owner, admin grants owner, admin demotes admin, member/viewer change roles', async () => {
    const { ws, owner, admin, member, viewer } = await team();
    const other = await person('admin2');
    await addMember(ws, other, 'admin');
    const denied = [
      { actorId: admin.id, userId: owner.id, role: 'member' as Role },
      { actorId: admin.id, userId: member.id, role: 'owner' as Role },
      { actorId: admin.id, userId: other.id, role: 'member' as Role },
      { actorId: member.id, userId: viewer.id, role: 'member' as Role },
      { actorId: viewer.id, userId: member.id, role: 'viewer' as Role },
      { actorId: member.id, userId: member.id, role: 'admin' as Role },
    ];
    for (const d of denied) {
      await expect(
        changeMemberRole(db, { ...d, workspaceId: ws }),
        JSON.stringify(d),
      ).rejects.toThrow(ForbiddenError);
    }
    expect(await roleOf(ws, owner.id)).toBe('owner');
    expect(await roleOf(ws, member.id)).toBe('member');
    expect(await roleOf(ws, other.id)).toBe('admin');
  });

  it('the last owner cannot demote themselves; with two owners one can', async () => {
    const { ws, owner, admin } = await team();
    await expect(
      changeMemberRole(db, { actorId: owner.id, workspaceId: ws, userId: owner.id, role: 'admin' }),
    ).rejects.toThrow(ForbiddenError);
    await changeMemberRole(db, {
      actorId: owner.id,
      workspaceId: ws,
      userId: admin.id,
      role: 'owner',
    });
    await changeMemberRole(db, {
      actorId: owner.id,
      workspaceId: ws,
      userId: owner.id,
      role: 'admin',
    });
    expect(await roleOf(ws, owner.id)).toBe('admin');
  });

  it('non-members get not-found; the only owner of a workspace of one can’t demote themselves', async () => {
    const { ws, member } = await team();
    const stranger = await person('stranger');
    await expect(
      changeMemberRole(db, {
        actorId: stranger.id,
        workspaceId: ws,
        userId: member.id,
        role: 'viewer',
      }),
    ).rejects.toThrow(NotFoundError);
    const own = (await listUserWorkspaces(db, stranger.id))[0]!;
    await expect(
      changeMemberRole(db, {
        actorId: stranger.id,
        workspaceId: own.id,
        userId: stranger.id,
        role: 'admin',
      }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe('removing and leaving', () => {
  it('owners remove admins; admins remove members/viewers; removal clears their active workspace', async () => {
    const { ws, owner, admin, member, viewer } = await team();
    await auth.api.setActiveOrganization({ body: { organizationId: ws }, headers: member.headers });
    await removeMember(db, { actorId: admin.id, workspaceId: ws, userId: member.id });
    await removeMember(db, { actorId: admin.id, workspaceId: ws, userId: viewer.id });
    await removeMember(db, { actorId: owner.id, workspaceId: ws, userId: admin.id });
    expect((await listMembers(db, ws)).map((m) => m.userId)).toEqual([owner.id]);
    const [s] = await db.select().from(schema.session).where(eq(schema.session.userId, member.id));
    expect(s!.activeWorkspaceId).toBeNull();
    // Back to the workspace they had before joining.
    expect((await listUserWorkspaces(db, member.id)).map((w) => w.id)).toEqual([
      await findFirstWorkspaceId(db, member.id),
    ]);
  });

  it('deny: admin removes owner or admin, member/viewer remove others, last owner removed', async () => {
    const { ws, owner, admin, member, viewer } = await team();
    const other = await person('admin2');
    await addMember(ws, other, 'admin');
    const denied = [
      { actorId: admin.id, userId: owner.id },
      { actorId: admin.id, userId: other.id },
      { actorId: member.id, userId: viewer.id },
      { actorId: viewer.id, userId: member.id },
      { actorId: member.id, userId: owner.id },
    ];
    for (const d of denied) {
      await expect(removeMember(db, { ...d, workspaceId: ws }), JSON.stringify(d)).rejects.toThrow(
        ForbiddenError,
      );
    }
    expect(await listMembers(db, ws)).toHaveLength(5);
  });

  it('anyone may leave, except the last owner', async () => {
    const { ws, owner, admin, member, viewer } = await team();
    for (const p of [viewer, member, admin]) {
      await leaveWorkspace(db, { actorId: p.id, workspaceId: ws });
      expect(await roleOf(ws, p.id)).toBeUndefined();
    }
    await expect(leaveWorkspace(db, { actorId: owner.id, workspaceId: ws })).rejects.toThrow(
      ForbiddenError,
    );
    expect(await roleOf(ws, owner.id)).toBe('owner');
  });

  // D-36: no account is left without a workspace by its own action.
  it('nobody leaves their last workspace; with a second one they can', async () => {
    const { ws, owner, member } = await team();
    // A member whose only workspace is the team (as someone who signed up through an invitation).
    const own = (await findFirstWorkspaceId(db, member.id))!;
    await db.delete(schema.membership).where(eq(schema.membership.workspaceId, own));
    expect((await listUserWorkspaces(db, member.id)).map((w) => w.id)).toEqual([ws]);

    await expect(leaveWorkspace(db, { actorId: member.id, workspaceId: ws })).rejects.toThrow(
      ForbiddenError,
    );
    expect(await roleOf(ws, member.id)).toBe('member');
    // A soft-deleted workspace doesn't count as somewhere else to be.
    const dead = await teamOf(owner, 'Dead');
    await addMember(dead, member, 'member');
    await deleteWorkspace(db, { actorId: owner.id, workspaceId: dead });
    await expect(leaveWorkspace(db, { actorId: member.id, workspaceId: ws })).rejects.toThrow(
      ForbiddenError,
    );

    // Being removed by someone else is not leaving: allowed, and the next visit gives them a workspace.
    await removeMember(db, { actorId: owner.id, workspaceId: ws, userId: member.id });
    expect(await listUserWorkspaces(db, member.id)).toEqual([]);
    const fresh = await ensureFirstWorkspace(db, member.id);
    expect(fresh.created).toBe(true);

    // With a second workspace, leaving the first works.
    await addMember(ws, member, 'member');
    await leaveWorkspace(db, { actorId: member.id, workspaceId: ws });
    expect((await listUserWorkspaces(db, member.id)).map((w) => w.id)).toEqual([fresh.workspaceId]);
  });

  it('the sole owner of a workspace of one can’t leave it (last owner, last workspace)', async () => {
    const solo = await person('solo');
    const own = (await listUserWorkspaces(db, solo.id))[0]!;
    await expect(leaveWorkspace(db, { actorId: solo.id, workspaceId: own.id })).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('leaving two workspaces at the same time keeps one of them', async () => {
    for (let round = 0; round < 5; round++) {
      const [a, b] = await Promise.all([team(), team()]);
      const both = await person(`both-${round}`);
      const own = (await findFirstWorkspaceId(db, both.id))!;
      await db.delete(schema.membership).where(eq(schema.membership.workspaceId, own));
      await addMember(a.ws, both, 'member');
      await addMember(b.ws, both, 'member');

      const results = await Promise.allSettled([
        leaveWorkspace(db, { actorId: both.id, workspaceId: a.ws }),
        leaveWorkspace(db, { actorId: both.id, workspaceId: b.ws }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(refused.reason).toBeInstanceOf(ForbiddenError);
      expect(await listUserWorkspaces(db, both.id)).toHaveLength(1);
    }
  });

  it('Better Auth’s own member endpoints are not served (one write path, under our lock)', async () => {
    const { ws, owner, admin } = await team();
    for (const path of BLOCKED_ORGANIZATION_PATHS) {
      const res = await postJson(owner.jar, `/api/auth${path}`, {
        organizationId: ws,
        memberId: admin.id,
        memberIdOrEmail: admin.email,
        role: 'viewer',
      });
      expect(res.status, path).toBe(404);
    }
    expect(await roleOf(ws, admin.id)).toBe('admin');
    expect(await listUserWorkspaces(db, owner.id)).toHaveLength(2);
  });
});

describe('last-owner protection under concurrency', () => {
  const settle = (ps: Promise<unknown>[]) => Promise.allSettled(ps);
  const outcome = (results: PromiseSettledResult<unknown>[]) => {
    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    const forbidden = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof ForbiddenError,
    ).length;
    return { fulfilled, forbidden };
  };

  async function twoOwners() {
    const [a, b] = await Promise.all([person('own-a'), person('own-b')]);
    const ws = await teamOf(a);
    await addMember(ws, b, 'owner');
    return { ws, a, b };
  }

  const ownerCount = async (ws: string) =>
    (await listMembers(db, ws)).filter((m) => m.role === 'owner').length;

  it('two owners leaving at once: exactly one succeeds, one owner remains', async () => {
    for (let i = 0; i < 5; i++) {
      const { ws, a, b } = await twoOwners();
      const results = await settle([
        leaveWorkspace(db, { actorId: a.id, workspaceId: ws }),
        leaveWorkspace(db, { actorId: b.id, workspaceId: ws }),
      ]);
      expect(outcome(results)).toEqual({ fulfilled: 1, forbidden: 1 });
      expect(await ownerCount(ws)).toBe(1);
    }
  });

  it('two owners demoting each other at once: exactly one succeeds', async () => {
    for (let i = 0; i < 5; i++) {
      const { ws, a, b } = await twoOwners();
      const results = await settle([
        changeMemberRole(db, { actorId: a.id, workspaceId: ws, userId: b.id, role: 'admin' }),
        changeMemberRole(db, { actorId: b.id, workspaceId: ws, userId: a.id, role: 'admin' }),
      ]);
      // The second sees the first one's demotion: its actor is no longer an owner of an owner, or the
      // target is now the last owner. Either way it's refused.
      expect(outcome(results)).toEqual({ fulfilled: 1, forbidden: 1 });
      expect(await ownerCount(ws)).toBe(1);
    }
  });

  it('demote + leave racing: the workspace still has an owner', async () => {
    for (let i = 0; i < 5; i++) {
      const { ws, a, b } = await twoOwners();
      const results = await settle([
        changeMemberRole(db, { actorId: a.id, workspaceId: ws, userId: a.id, role: 'member' }),
        leaveWorkspace(db, { actorId: b.id, workspaceId: ws }),
        removeMember(db, { actorId: a.id, workspaceId: ws, userId: b.id }),
      ]);
      expect(outcome(results).fulfilled).toBeGreaterThanOrEqual(1);
      expect(await ownerCount(ws)).toBe(1);
    }
  });
});

describe('deleting a workspace (soft)', () => {
  it('only the owner deletes; the workspace disappears everywhere but the rows remain', async () => {
    const { ws, owner, admin, member } = await team();
    await expect(deleteWorkspace(db, { actorId: admin.id, workspaceId: ws })).rejects.toThrow(
      ForbiddenError,
    );
    await expect(deleteWorkspace(db, { actorId: member.id, workspaceId: ws })).rejects.toThrow(
      ForbiddenError,
    );
    const pending = await invite(owner, ws, uniqueAddress('late-joiner'), 'member');
    const pendingToken = tokenFromMail(pending!.email);
    await auth.api.setActiveOrganization({ body: { organizationId: ws }, headers: member.headers });

    await deleteWorkspace(db, { actorId: owner.id, workspaceId: ws });

    const [row] = await db.select().from(schema.workspace).where(eq(schema.workspace.id, ws));
    expect(row!.deletedAt).toBeInstanceOf(Date);
    expect(await listMembers(db, ws)).toHaveLength(4); // kept for restore
    for (const p of [owner, admin, member]) {
      expect((await listUserWorkspaces(db, p.id)).map((w) => w.id)).not.toContain(ws);
      expect(roleIn(await loadPermissionContext(db, p.id), ws)).toBeUndefined();
    }
    const [s] = await db.select().from(schema.session).where(eq(schema.session.userId, member.id));
    expect(s!.activeWorkspaceId).toBeNull();

    // Nothing more can happen in it.
    await expect(
      changeMemberRole(db, {
        actorId: owner.id,
        workspaceId: ws,
        userId: member.id,
        role: 'viewer',
      }),
    ).rejects.toThrow(NotFoundError);
    await expect(leaveWorkspace(db, { actorId: member.id, workspaceId: ws })).rejects.toThrow(
      NotFoundError,
    );
    await expect(invite(owner, ws, uniqueAddress('x'), 'member')).rejects.toThrow();
    await expect(
      auth.api.setActiveOrganization({ body: { organizationId: ws }, headers: member.headers }),
    ).rejects.toThrow();
    expect(await findInviteByToken(db, pendingToken)).toBeUndefined();
    await expect(
      auth.api.updateOrganization({
        body: { organizationId: ws, data: { name: 'Back' } },
        headers: owner.headers,
      }),
    ).rejects.toThrow();
  });

  it('a deleted workspace’s pending invite cannot be accepted', async () => {
    const { ws, owner } = await team();
    const joiner = await person('joiner');
    const created = await invite(owner, ws, joiner.email, 'member');
    await deleteWorkspace(db, { actorId: owner.id, workspaceId: ws });
    const res = await postJson(joiner.jar, '/api/auth/organization/accept-invitation', {
      invitationId: created!.id,
    });
    expect(res.status).toBe(403);
    expect(await roleOf(ws, joiner.id)).toBeUndefined();
  });

  // D-36: the workspace made at sign-up is an ordinary one, but nobody deletes their last workspace.
  it('the last workspace can’t be deleted; with a second one it can — the first one too', async () => {
    const solo = await person('solo-del');
    const own = (await listUserWorkspaces(db, solo.id))[0]!;
    await expect(deleteWorkspace(db, { actorId: solo.id, workspaceId: own.id })).rejects.toThrow(
      ForbiddenError,
    );
    expect((await listUserWorkspaces(db, solo.id)).map((w) => w.id)).toEqual([own.id]);

    const second = await teamOf(solo, 'Second');
    await deleteWorkspace(db, { actorId: solo.id, workspaceId: own.id });
    expect((await listUserWorkspaces(db, solo.id)).map((w) => w.id)).toEqual([second]);
    // …which leaves `second` as the last one.
    await expect(deleteWorkspace(db, { actorId: solo.id, workspaceId: second })).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('deleting two workspaces at the same time keeps one of them', async () => {
    for (let round = 0; round < 5; round++) {
      const solo = await person(`del-both-${round}`);
      const own = (await findFirstWorkspaceId(db, solo.id))!;
      const second = await teamOf(solo, 'Second');
      const results = await Promise.allSettled([
        deleteWorkspace(db, { actorId: solo.id, workspaceId: own }),
        deleteWorkspace(db, { actorId: solo.id, workspaceId: second }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(await listUserWorkspaces(db, solo.id)).toHaveLength(1);
    }
  });

  // Review (step A) #1: the decision must come from rows read under the workspace lock, not before it.
  describe('a change that commits while the action waits for the workspace lock', () => {
    /** Runs `change` in a transaction that holds the workspace's lock while `action` is already waiting. */
    async function whileWaiting<T>(
      workspaceId: string,
      action: () => Promise<T>,
      change: (tx: Parameters<Parameters<Db['transaction']>[0]>[0]) => Promise<unknown>,
    ): Promise<PromiseSettledResult<T>> {
      let pending!: Promise<PromiseSettledResult<T>>;
      await db.transaction(async (tx) => {
        await tx
          .select({ id: schema.workspace.id })
          .from(schema.workspace)
          .where(eq(schema.workspace.id, workspaceId))
          .for('update');
        pending = Promise.allSettled([action()]).then(([r]) => r!);
        // Long enough for the action to take its user lock and block on the workspace row.
        await new Promise((resolve) => setTimeout(resolve, 300));
        await change(tx);
      });
      return pending;
    }

    it('an owner demoted meanwhile no longer deletes the workspace', async () => {
      const { ws, owner, admin } = await team();
      await db
        .update(schema.membership)
        .set({ role: 'owner' })
        .where(and(eq(schema.membership.workspaceId, ws), eq(schema.membership.userId, admin.id)));
      const result = await whileWaiting(
        ws,
        () => deleteWorkspace(db, { actorId: admin.id, workspaceId: ws }),
        (tx) =>
          tx
            .update(schema.membership)
            .set({ role: 'member' })
            .where(
              and(eq(schema.membership.workspaceId, ws), eq(schema.membership.userId, admin.id)),
            ),
      );
      expect(result.status).toBe('rejected');
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(ForbiddenError);
      const [row] = await db.select().from(schema.workspace).where(eq(schema.workspace.id, ws));
      expect(row!.deletedAt).toBeNull();
      expect(await roleOf(ws, owner.id)).toBe('owner');
    });

    it('a member removed meanwhile has nothing left to delete or leave', async () => {
      const { ws, admin, member } = await team();
      const removed = await whileWaiting(
        ws,
        () => leaveWorkspace(db, { actorId: member.id, workspaceId: ws }),
        (tx) =>
          tx
            .delete(schema.membership)
            .where(
              and(eq(schema.membership.workspaceId, ws), eq(schema.membership.userId, member.id)),
            ),
      );
      expect(removed.status).toBe('rejected');
      expect((removed as PromiseRejectedResult).reason).toBeInstanceOf(NotFoundError);

      // An owner who becomes the last owner while their leave waits stays.
      const second = await team();
      await db
        .update(schema.membership)
        .set({ role: 'owner' })
        .where(
          and(
            eq(schema.membership.workspaceId, second.ws),
            eq(schema.membership.userId, second.admin.id),
          ),
        );
      const stays = await whileWaiting(
        second.ws,
        () => leaveWorkspace(db, { actorId: second.admin.id, workspaceId: second.ws }),
        (tx) =>
          tx
            .update(schema.membership)
            .set({ role: 'member' })
            .where(
              and(
                eq(schema.membership.workspaceId, second.ws),
                eq(schema.membership.userId, second.owner.id),
              ),
            ),
      );
      expect(stays.status).toBe('rejected');
      expect((stays as PromiseRejectedResult).reason).toBeInstanceOf(ForbiddenError);
      expect(await roleOf(second.ws, second.admin.id)).toBe('owner');
      expect(admin.id).not.toBe(second.admin.id);
    });
  });

  it('members of other workspaces are unaffected', async () => {
    const first = await team();
    const second = await team();
    await addMember(second.ws, first.member, 'member');
    await deleteWorkspace(db, { actorId: first.owner.id, workspaceId: first.ws });
    const ctx = await loadPermissionContext(db, first.member.id);
    expect(roleIn(ctx, second.ws)).toBe('member');
    expect(roleIn(ctx, first.ws)).toBeUndefined();
    expect((await listUserWorkspaces(db, second.owner.id)).map((w) => w.id)).toContain(second.ws);
  });
});

// ---------------------------------------------------------------------------------------------------
// 5.1 review: invite authority, email throttling, Better Auth read/update endpoints
// ---------------------------------------------------------------------------------------------------

const accept = (p: Person, invitationId: string) =>
  postJson(p.jar, '/api/auth/organization/accept-invitation', { invitationId });

const statusOf = async (invitationId: string) =>
  (await db.select().from(schema.invite).where(eq(schema.invite.id, invitationId)))[0]!.status;

describe('an invite carries its sender’s authority only while they have it', () => {
  it('demoted admin: their invite to their own second address is revoked and refused', async () => {
    const { ws, owner, admin } = await team();
    const alt = await person('admin-alt');
    const created = await invite(admin, ws, alt.email, 'admin');
    await changeMemberRole(db, {
      actorId: owner.id,
      workspaceId: ws,
      userId: admin.id,
      role: 'member',
    });
    expect(await statusOf(created!.id)).toBe('canceled');
    expect((await accept(alt, created!.id)).status).toBe(400);
    expect(await roleOf(ws, alt.id)).toBeUndefined();
  });

  it('removed admin: every pending invite they sent is revoked', async () => {
    const { ws, owner, admin } = await team();
    const a = await invite(admin, ws, uniqueAddress('r1'), 'member');
    const b = await invite(admin, ws, uniqueAddress('r2'), 'viewer');
    const ownersOwn = await invite(owner, ws, uniqueAddress('r3'), 'member');
    await removeMember(db, { actorId: owner.id, workspaceId: ws, userId: admin.id });
    expect(await statusOf(a!.id)).toBe('canceled');
    expect(await statusOf(b!.id)).toBe('canceled');
    expect(await statusOf(ownersOwn!.id)).toBe('pending');
  });

  it('demoted owner: owner-role invites are revoked, the ones they may still send stay', async () => {
    const { ws, owner } = await team();
    const second = await person('owner-2');
    await addMember(ws, second, 'owner');
    const asOwner = await invite(owner, ws, uniqueAddress('o1'), 'owner');
    const asAdmin = await invite(owner, ws, uniqueAddress('o2'), 'admin');
    await changeMemberRole(db, {
      actorId: second.id,
      workspaceId: ws,
      userId: owner.id,
      role: 'admin',
    });
    expect(await statusOf(asOwner!.id)).toBe('canceled');
    expect(await statusOf(asAdmin!.id)).toBe('pending');
  });

  it('accept re-checks the inviter’s current role even if the invite is still pending', async () => {
    const { ws, admin } = await team();
    const alt = await person('alt-direct');
    const created = await invite(admin, ws, alt.email, 'admin');
    // Demoted by a path that doesn't revoke (e.g. a future one): accept must still refuse.
    await db
      .update(schema.membership)
      .set({ role: 'member' })
      .where(and(eq(schema.membership.workspaceId, ws), eq(schema.membership.userId, admin.id)));
    expect(await statusOf(created!.id)).toBe('pending');
    expect((await accept(alt, created!.id)).status).toBe(403);
    expect(await roleOf(ws, alt.id)).toBeUndefined();
    // …and the same for an inviter who left by any means.
    const other = await person('alt-gone');
    await db
      .update(schema.membership)
      .set({ role: 'admin' })
      .where(and(eq(schema.membership.workspaceId, ws), eq(schema.membership.userId, admin.id)));
    const second = await invite(admin, ws, other.email, 'member');
    await db
      .delete(schema.membership)
      .where(and(eq(schema.membership.workspaceId, ws), eq(schema.membership.userId, admin.id)));
    expect((await accept(other, second!.id)).status).toBe(403);
  });
});

describe('invitation emails', () => {
  it('resend re-checks the workspace and the inviter (Better Auth skips our create hook there)', async () => {
    const { ws, owner, admin } = await team();
    const to = uniqueAddress('resend');
    await invite(admin, ws, to, 'member');
    const sent = outbox.filter((m) => m.to === to).length;
    const resend = (by: Person) =>
      auth.api.createInvitation({
        body: { email: to, role: 'member', organizationId: ws, resend: true },
        headers: by.headers,
      });
    // Demoted to viewer behind the actions' back: resend refused, nothing mailed.
    await db
      .update(schema.membership)
      .set({ role: 'viewer' })
      .where(and(eq(schema.membership.workspaceId, ws), eq(schema.membership.userId, admin.id)));
    await expect(resend(admin)).rejects.toThrow();
    // Deleted workspace: refused too.
    await deleteWorkspace(db, { actorId: owner.id, workspaceId: ws });
    await expect(resend(owner)).rejects.toThrow();
    expect(outbox.filter((m) => m.to === to)).toHaveLength(sent);
  });

  it('caps invitations per recipient (resends included)', async () => {
    const { ws, owner } = await team();
    const other = await team();
    const to = uniqueAddress('capped');
    const { max } = INVITE_EMAIL_LIMITS.perRecipient;
    await invite(owner, ws, to, 'member');
    for (let i = 1; i < max; i++) {
      await auth.api.createInvitation({
        body: { email: to, role: 'member', organizationId: ws, resend: true },
        headers: owner.headers,
      });
    }
    expect(outbox.filter((m) => m.to === to)).toHaveLength(max);
    // A different inviter and workspace still can't reach the same address.
    const res = await postJson(other.owner.jar, '/api/auth/organization/invite-member', {
      email: to,
      role: 'member',
      organizationId: other.ws,
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(outbox.filter((m) => m.to === to)).toHaveLength(max);
  });

  it('caps invitations per inviter', async () => {
    const { ws, owner } = await team();
    const { max } = INVITE_EMAIL_LIMITS.perInviter;
    for (let i = 0; i < max; i++) await invite(owner, ws, uniqueAddress(`bulk${i}`), 'viewer');
    const res = await postJson(owner.jar, '/api/auth/organization/invite-member', {
      email: uniqueAddress('one-too-many'),
      role: 'viewer',
      organizationId: ws,
    });
    expect(res.status).toBe(429);
  });
});

describe('Better Auth organization endpoints', () => {
  const get = (p: Person, path: string) => call(p.jar, path);

  it('soft-deleted workspaces are not listed or served', async () => {
    const { ws, owner, member } = await team();
    const kept = await teamOf(owner, 'Kept');
    await deleteWorkspace(db, { actorId: owner.id, workspaceId: ws });
    const list = (await (await get(owner, '/api/auth/organization/list')).json()) as {
      id: string;
    }[];
    expect(list.map((o) => o.id)).toContain(kept);
    expect(list.map((o) => o.id)).not.toContain(ws);
    for (const path of [
      `/api/auth/organization/get-full-organization?organizationId=${ws}`,
      `/api/auth/organization/list-members?organizationId=${ws}`,
      `/api/auth/organization/list-invitations?organizationId=${ws}`,
    ]) {
      expect((await get(member, path)).status, path).toBe(404);
    }
    expect(
      (await get(owner, `/api/auth/organization/get-full-organization?organizationId=${kept}`))
        .status,
    ).toBe(200);
  });

  it('only owners and admins list invitations', async () => {
    const { ws, owner, admin, member, viewer } = await team();
    await invite(owner, ws, uniqueAddress('listed'), 'member');
    const path = `/api/auth/organization/list-invitations?organizationId=${ws}`;
    expect((await get(owner, path)).status).toBe(200);
    expect((await get(admin, path)).status).toBe(200);
    expect((await get(member, path)).status).toBe(403);
    expect((await get(viewer, path)).status).toBe(403);
  });

  it('update: name length capped, metadata refused, only owners change the address', async () => {
    const { ws, owner, admin } = await team();
    const update = (p: Person, data: Record<string, unknown>) =>
      postJson(p.jar, '/api/auth/organization/update', { organizationId: ws, data });
    expect((await update(admin, { name: 'x'.repeat(61) })).status).toBe(400);
    expect((await update(admin, { name: '   ' })).status).toBe(400);
    expect((await update(admin, { metadata: { a: 1 } })).status).toBeGreaterThanOrEqual(400);
    expect((await update(admin, { logo: 'x'.repeat(100) })).status).toBe(400);
    expect((await update(admin, { slug: `admin-${crypto.randomUUID()}` })).status).toBe(403);
    expect((await update(owner, { slug: 'Not A Slug!' })).status).toBe(400);
    expect((await update(owner, { slug: `owner-${crypto.randomUUID()}` })).status).toBe(200);
    expect((await update(admin, { name: 'Renamed', logo: '🌾' })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------------
// 5.5 authz audit: deny cases for the Better Auth endpoints the catch-all serves (`endpoints.test.ts`)
// ---------------------------------------------------------------------------------------------------

describe('Better Auth endpoints: deny cases (5.5)', () => {
  const workspaceName = async (ws: string) =>
    (await db.select().from(schema.workspace).where(eq(schema.workspace.id, ws)))[0]!.name;
  const inviteStatus = async (id: string) =>
    (await db.select().from(schema.invite).where(eq(schema.invite.id, id)))[0]!.status;
  const activeOf = async (p: Person) =>
    (await db.select().from(schema.session).where(eq(schema.session.userId, p.id)))[0]!
      .activeWorkspaceId;
  const refused = (status: number) => status >= 400 && status < 500;

  it('organization/update: members, viewers and outsiders cannot change a workspace', async () => {
    const { ws, member, viewer } = await team();
    const outsider = await person('outsider');
    for (const p of [member, viewer, outsider]) {
      const res = await postJson(p.jar, '/api/auth/organization/update', {
        organizationId: ws,
        data: { name: 'Hijacked' },
      });
      expect(refused(res.status), `${p.email}: ${res.status}`).toBe(true);
    }
    expect(await workspaceName(ws)).toBe('Acme');
  });

  it('invitations: only the recipient reads or rejects; outsiders and members cannot cancel', async () => {
    const { ws, owner, member } = await team();
    const invitee = await person('invitee');
    const outsider = await person('outsider');
    const created = await invite(owner, ws, invitee.email, 'member');
    const id = created!.id;
    for (const p of [outsider, member, owner]) {
      const read = await call(p.jar, `/api/auth/organization/get-invitation?id=${id}`);
      expect(refused(read.status), `read ${p.email}: ${read.status}`).toBe(true);
      const reject = await postJson(p.jar, '/api/auth/organization/reject-invitation', {
        invitationId: id,
      });
      expect(refused(reject.status), `reject ${p.email}: ${reject.status}`).toBe(true);
    }
    for (const p of [outsider, member]) {
      const cancel = await postJson(p.jar, '/api/auth/organization/cancel-invitation', {
        invitationId: id,
      });
      expect(refused(cancel.status), `cancel ${p.email}: ${cancel.status}`).toBe(true);
    }
    expect(await inviteStatus(id)).toBe('pending');
    const own = await call(invitee.jar, `/api/auth/organization/get-invitation?id=${id}`);
    expect(own.status).toBe(200);
  });

  it('set-active and get-organization refuse non-members; soft-deleted workspaces are not served', async () => {
    const { ws, owner, member } = await team();
    const outsider = await person('outsider');
    const set = await postJson(outsider.jar, '/api/auth/organization/set-active', {
      organizationId: ws,
    });
    expect(refused(set.status), String(set.status)).toBe(true);
    // Better Auth clears the active workspace on a refused switch; it never becomes `ws`.
    expect(await activeOf(outsider)).not.toBe(ws);
    const path = `/api/auth/organization/get-organization?organizationId=${ws}`;
    const asOutsider = await call(outsider.jar, path);
    expect(refused(asOutsider.status), String(asOutsider.status)).toBe(true);
    expect((await call(member.jar, path)).status).toBe(200);
    await deleteWorkspace(db, { actorId: owner.id, workspaceId: ws });
    expect((await call(member.jar, path)).status).toBe(404);
  });

  it('disabled routes answer 404 even when signed in', async () => {
    const p = await person('disabled');
    for (const path of DISABLED_AUTH_PATHS) {
      const get = await call(p.jar, `/api/auth${path}`);
      const post = await postJson(p.jar, `/api/auth${path}`, {
        email: uniqueAddress('x'),
        newEmail: uniqueAddress('y'),
        password: 'correct horse battery staple',
        activeOrganizationId: 'x',
        slug: 'acme',
      });
      expect(get.status, `GET ${path}`).toBe(404);
      expect(post.status, `POST ${path}`).toBe(404);
    }
    const [row] = await db.select().from(schema.user).where(eq(schema.user.id, p.id));
    expect(row!.email).toBe(p.email);
  });

  it('update-user changes only the caller’s name: no avatar URL, email or other fields', async () => {
    const p = await person('profile');
    const update = (body: unknown) => postJson(p.jar, '/api/auth/update-user', body);
    const pixel = 'https://tracker.example/p.gif';
    expect((await update({ name: 'Pat', image: pixel })).status).toBe(403);
    expect((await update({ image: pixel })).status).toBe(403);
    expect((await update({ email: uniqueAddress('other') })).status).toBe(403);
    expect((await update({ name: 'x'.repeat(101) })).status).toBe(400);
    expect((await update({ name: '  ' })).status).toBe(400);
    const anonymous = await postJson(new Jar(), '/api/auth/update-user', { name: 'Anon' });
    expect(refused(anonymous.status), String(anonymous.status)).toBe(true);
    expect((await update({ name: 'Pat' })).status).toBe(200);
    const [row] = await db.select().from(schema.user).where(eq(schema.user.id, p.id));
    expect(row).toMatchObject({ name: 'Pat', image: null, email: p.email });
  });
});
