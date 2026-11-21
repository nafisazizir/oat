/**
 * Joining a workspace by email domain (D-36, task unified-workspaces step B) against a throwaway Postgres
 * database: what each join policy shows and allows, every deny case on the server (the checks never see a
 * client-sent email or domain: there is none to send), race safety of auto-join, requests and decisions, and
 * what a newcomer with something to join gets instead of a workspace of their own.
 */
import { randomBytes } from 'node:crypto';

import { ForbiddenError, type JoinPolicy, type Role } from '@oat/core';
import { createDb, type Db, migrate, schema } from '@oat/db';
import { createTestDatabase, type TestDatabase, testEnv } from '@oat/testkit';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type AuthConfig, DEV_AUTH_SECRET } from './config.ts';
import type { EmailMessage, Mailer } from './email.ts';
import {
  addOwnDomain,
  createOwnWorkspace,
  decideJoinRequest,
  ensureFirstWorkspace,
  getJoinChoices,
  getJoinSettings,
  JoinRequestDecidedError,
  joinWorkspace,
  listableDomain,
  listJoinRequests,
  removeDomain,
  requestToJoin,
  sendJoinDecisionEmail,
  sendJoinRequestEmails,
  setJoinPolicy,
} from './joining.ts';
import { magicLinkVerifyUrl } from './magic-link.ts';
import { deleteWorkspace, NotFoundError } from './members.ts';
import { createMemoryRateLimiter } from './rate-limit.ts';
import { type Auth, createAuth } from './server.ts';
import { listUserWorkspaces } from './workspaces.ts';

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
  db = createDb(testDb.url, { max: 10 });
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

const rand = () => randomBytes(5).toString('hex');
/** A company domain nobody else in this database uses. */
const newDomain = () => `co-${rand()}.test`;

type TestUser = { id: string; email: string };

/** A user row as sign-in leaves it (verified unless said otherwise), without a workspace. */
async function person(
  domain: string,
  options: { verified?: boolean; name?: string | null } = {},
): Promise<TestUser> {
  const [row] = await db
    .insert(schema.user)
    .values({
      email: `p-${rand()}@${domain}`,
      name: options.name ?? null,
      emailVerified: options.verified ?? true,
    })
    .returning();
  return { id: row!.id, email: row!.email };
}

/** A workspace owned by a fresh user on `domain`, with that policy and (by default) that domain listed. */
async function company(
  policy: JoinPolicy,
  domain = newDomain(),
  options: { domains?: string[]; name?: string } = {},
) {
  const owner = await person(domain, { name: 'Olive Owner' });
  const [ws] = await db
    .insert(schema.workspace)
    .values({
      name: options.name ?? `Co ${rand()}`,
      slug: `co-${rand()}`,
      createdBy: owner.id,
      joinPolicy: policy,
    })
    .returning();
  await db
    .insert(schema.membership)
    .values({ workspaceId: ws!.id, userId: owner.id, role: 'owner' });
  const domains = options.domains ?? [domain];
  if (domains.length > 0) {
    await db
      .insert(schema.workspaceDomain)
      .values(domains.map((d) => ({ workspaceId: ws!.id, domain: d, addedBy: owner.id })));
  }
  return { id: ws!.id, name: ws!.name, domain, owner };
}

async function addMember(workspaceId: string, domain: string, role: Role): Promise<TestUser> {
  const user = await person(domain);
  await db.insert(schema.membership).values({ workspaceId, userId: user.id, role });
  return user;
}

const membershipsOf = (workspaceId: string, userId: string) =>
  db
    .select({ role: schema.membership.role })
    .from(schema.membership)
    .where(
      and(eq(schema.membership.workspaceId, workspaceId), eq(schema.membership.userId, userId)),
    );

const requestsOf = (workspaceId: string, userId: string) =>
  db
    .select()
    .from(schema.joinRequest)
    .where(
      and(eq(schema.joinRequest.workspaceId, workspaceId), eq(schema.joinRequest.userId, userId)),
    );

const offered = async (userId: string) =>
  (await getJoinChoices(db, userId)).workspaces.map((w) => [w.id, w.option]);

const outcomes = (results: PromiseSettledResult<unknown>[]) => ({
  ok: results.filter((r) => r.status === 'fulfilled').length,
  errors: results.flatMap((r) => (r.status === 'rejected' ? [r.reason as Error] : [])),
});

// ---------------------------------------------------------------------------------------------------
// What a newcomer is shown
// ---------------------------------------------------------------------------------------------------

describe('what a matching stranger is shown', () => {
  it('invite_only: never shown; request: "request"; auto_join: "join"', async () => {
    const domain = newDomain();
    const closed = await company('invite_only', domain, { name: 'A closed' });
    const asking = await company('request', domain, { name: 'B asking' });
    const open = await company('auto_join', domain, { name: 'C open' });
    const sam = await person(domain);

    expect(await offered(sam.id)).toEqual([
      [asking.id, 'request'],
      [open.id, 'join'],
    ]);
    const choices = await getJoinChoices(db, sam.id);
    expect(choices.invites).toEqual([]);
    expect(choices.workspaces[1]).toEqual({
      id: open.id,
      name: 'C open',
      logo: null,
      memberCount: 1,
      option: 'join',
    });
    // The invite-only workspace can't be joined or asked either, by id.
    await expect(joinWorkspace(db, { userId: sam.id, workspaceId: closed.id })).rejects.toThrow(
      NotFoundError,
    );
    await expect(requestToJoin(db, { userId: sam.id, workspaceId: closed.id })).rejects.toThrow(
      NotFoundError,
    );
    expect(await membershipsOf(closed.id, sam.id)).toEqual([]);
    expect(await requestsOf(closed.id, sam.id)).toEqual([]);
  });

  it('nothing for an unverified email, another domain, a subdomain or an unknown user', async () => {
    const co = await company('auto_join');
    const unverified = await person(co.domain, { verified: false });
    const other = await person(newDomain());
    const sub = await person(`mail.${co.domain}`);
    for (const user of [unverified, other, sub]) {
      expect(await offered(user.id), user.email).toEqual([]);
      await expect(joinWorkspace(db, { userId: user.id, workspaceId: co.id })).rejects.toThrow(
        NotFoundError,
      );
      expect(await membershipsOf(co.id, user.id)).toEqual([]);
    }
    expect(await getJoinChoices(db, 'no-such-user')).toEqual({ invites: [], workspaces: [] });
    await expect(joinWorkspace(db, { userId: 'no-such-user', workspaceId: co.id })).rejects.toThrow(
      NotFoundError,
    );
  });

  it('nothing for a public mailbox domain, even when a workspace row lists it', async () => {
    // Such a row can't be made through `addOwnDomain`; it is written directly to prove matching refuses it.
    const co = await company('auto_join', 'gmail.com');
    const asking = await company('request', 'gmail.com');
    const sam = await person('gmail.com');
    expect(await offered(sam.id)).toEqual([]);
    await expect(joinWorkspace(db, { userId: sam.id, workspaceId: co.id })).rejects.toThrow(
      NotFoundError,
    );
    await expect(requestToJoin(db, { userId: sam.id, workspaceId: asking.id })).rejects.toThrow(
      NotFoundError,
    );
    expect(await membershipsOf(co.id, sam.id)).toEqual([]);
    expect(await requestsOf(asking.id, sam.id)).toEqual([]);
  });

  it('nothing for a workspace they are already in, or a soft-deleted one', async () => {
    const domain = newDomain();
    const co = await company('auto_join', domain);
    const gone = await company('auto_join', domain);
    const also = await company('request', domain);
    // The owner keeps another workspace, so deleting `gone` isn't deleting their last one.
    await db
      .insert(schema.membership)
      .values({ workspaceId: co.id, userId: gone.owner.id, role: 'member' });
    await deleteWorkspace(db, { actorId: gone.owner.id, workspaceId: gone.id });

    const sam = await person(domain);
    expect(await offered(sam.id)).toEqual(
      expect.arrayContaining([
        [co.id, 'join'],
        [also.id, 'request'],
      ]),
    );
    expect((await offered(sam.id)).map(([id]) => id)).not.toContain(gone.id);
    await expect(joinWorkspace(db, { userId: sam.id, workspaceId: gone.id })).rejects.toThrow(
      NotFoundError,
    );
    await expect(requestToJoin(db, { userId: sam.id, workspaceId: gone.id })).rejects.toThrow(
      NotFoundError,
    );
    expect(await membershipsOf(gone.id, sam.id)).toEqual([]);

    await joinWorkspace(db, { userId: sam.id, workspaceId: co.id });
    expect((await offered(sam.id)).map(([id]) => id)).toEqual([also.id]);
  });

  it('a workspace that invited them is offered once, as the invitation', async () => {
    const co = await company('auto_join');
    const sam = await person(co.domain);
    const [invitation] = await db
      .insert(schema.invite)
      .values({
        workspaceId: co.id,
        email: sam.email.toUpperCase(),
        role: 'admin',
        inviterId: co.owner.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .returning();
    expect(await getJoinChoices(db, sam.id)).toEqual({
      invites: [
        {
          token: invitation!.token,
          role: 'admin',
          workspace: { id: co.id, name: co.name, logo: null },
          invitedBy: 'Olive Owner',
        },
      ],
      workspaces: [],
    });

    // An invite whose sender lost the right to send it is not offered (accepting it would be refused).
    await db
      .update(schema.membership)
      .set({ role: 'member' })
      .where(eq(schema.membership.userId, co.owner.id));
    expect(await getJoinChoices(db, sam.id)).toEqual({
      invites: [],
      workspaces: [expect.objectContaining({ id: co.id, option: 'join' })],
    });
  });
});

// ---------------------------------------------------------------------------------------------------
// auto_join
// ---------------------------------------------------------------------------------------------------

describe('auto_join', () => {
  it('joins as member, once, however often and however concurrently it is asked', async () => {
    const co = await company('auto_join');
    const sam = await person(co.domain);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => joinWorkspace(db, { userId: sam.id, workspaceId: co.id })),
    );
    expect(results.filter((r) => r.joined)).toHaveLength(1);
    expect(await membershipsOf(co.id, sam.id)).toEqual([{ role: 'member' }]);
    expect(await joinWorkspace(db, { userId: sam.id, workspaceId: co.id })).toEqual({
      joined: false,
    });
    expect((await listUserWorkspaces(db, sam.id)).map((w) => [w.id, w.role])).toEqual([
      [co.id, 'member'],
    ]);
  });

  it('is refused for a request workspace, and once the policy or the domain is gone', async () => {
    const asking = await company('request');
    const sam = await person(asking.domain);
    await expect(joinWorkspace(db, { userId: sam.id, workspaceId: asking.id })).rejects.toThrow(
      NotFoundError,
    );

    const co = await company('auto_join');
    const pat = await person(co.domain);
    await setJoinPolicy(db, { actorId: co.owner.id, workspaceId: co.id, policy: 'invite_only' });
    await expect(joinWorkspace(db, { userId: pat.id, workspaceId: co.id })).rejects.toThrow(
      NotFoundError,
    );
    await setJoinPolicy(db, { actorId: co.owner.id, workspaceId: co.id, policy: 'auto_join' });
    await removeDomain(db, { actorId: co.owner.id, workspaceId: co.id, domain: co.domain });
    await expect(joinWorkspace(db, { userId: pat.id, workspaceId: co.id })).rejects.toThrow(
      NotFoundError,
    );
    expect(await membershipsOf(co.id, pat.id)).toEqual([]);
    await expect(joinWorkspace(db, { userId: pat.id, workspaceId: 'no-such-ws' })).rejects.toThrow(
      NotFoundError,
    );
  });

  it('a join racing with the workspace being deleted never lands in a deleted workspace', async () => {
    for (let round = 0; round < 5; round++) {
      const domain = newDomain();
      const keep = await company('invite_only', domain);
      const co = await company('auto_join', domain);
      await db
        .insert(schema.membership)
        .values({ workspaceId: keep.id, userId: co.owner.id, role: 'member' });
      const sam = await person(domain);
      const [joined, deleted] = await Promise.allSettled([
        joinWorkspace(db, { userId: sam.id, workspaceId: co.id }),
        deleteWorkspace(db, { actorId: co.owner.id, workspaceId: co.id }),
      ]);
      expect(deleted.status).toBe('fulfilled');
      // Either they got in just before it was deleted, or were refused; never a join after the delete.
      if (joined.status === 'rejected') {
        expect(joined.reason).toBeInstanceOf(NotFoundError);
        expect(await membershipsOf(co.id, sam.id)).toEqual([]);
      }
      // Whichever way it went, the deleted workspace is not one of theirs.
      expect(await listUserWorkspaces(db, sam.id)).toEqual([]);
    }
  });

  it('settles a request the person made while the workspace still asked for one', async () => {
    const co = await company('request');
    const sam = await person(co.domain);
    await requestToJoin(db, { userId: sam.id, workspaceId: co.id });
    await setJoinPolicy(db, { actorId: co.owner.id, workspaceId: co.id, policy: 'auto_join' });
    expect(await offered(sam.id)).toEqual([[co.id, 'join']]);
    await joinWorkspace(db, { userId: sam.id, workspaceId: co.id });
    expect(await requestsOf(co.id, sam.id)).toEqual([
      expect.objectContaining({ status: 'approved', role: 'member', decidedBy: null }),
    ]);
    expect(await listJoinRequests(db, co.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
// request
// ---------------------------------------------------------------------------------------------------

describe('request', () => {
  it('one pending request per person per workspace, however concurrently it is asked', async () => {
    const co = await company('request');
    const admin = await addMember(co.id, co.domain, 'admin');
    await addMember(co.id, co.domain, 'member');
    const sam = await person(co.domain, { name: 'Sam Stranger' });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => requestToJoin(db, { userId: sam.id, workspaceId: co.id })),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.requestId)).size).toBe(1);
    expect(await requestsOf(co.id, sam.id)).toHaveLength(1);
    // Asking is not joining.
    expect(await membershipsOf(co.id, sam.id)).toEqual([]);
    // Only the request that was created says whom to tell: the owners and admins, not members.
    const notices = results.flatMap((r) => (r.notice ? [r.notice] : []));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toEqual({
      workspace: { id: co.id, name: co.name },
      requester: { name: 'Sam Stranger', email: sam.email },
      recipients: expect.arrayContaining([co.owner.email, admin.email]),
    });
    expect(notices[0]!.recipients).toHaveLength(2);

    expect(await offered(sam.id)).toEqual([[co.id, 'requested']]);
    expect(await listJoinRequests(db, co.id)).toEqual([
      expect.objectContaining({ userId: sam.id, email: sam.email, name: 'Sam Stranger' }),
    ]);
  });

  it('is refused for an auto_join workspace, an unverified email and a domain that is not listed', async () => {
    const open = await company('auto_join');
    const sam = await person(open.domain);
    await expect(requestToJoin(db, { userId: sam.id, workspaceId: open.id })).rejects.toThrow(
      NotFoundError,
    );

    const co = await company('request');
    const unverified = await person(co.domain, { verified: false });
    const other = await person(newDomain());
    const member = await addMember(co.id, co.domain, 'member');
    for (const user of [unverified, other, member]) {
      await expect(requestToJoin(db, { userId: user.id, workspaceId: co.id })).rejects.toThrow(
        NotFoundError,
      );
      expect(await requestsOf(co.id, user.id)).toEqual([]);
    }
    await expect(requestToJoin(db, { userId: 'no-such-user', workspaceId: co.id })).rejects.toThrow(
      NotFoundError,
    );
  });

  it('approve creates the membership with the chosen role; the request is settled', async () => {
    const co = await company('request');
    const sam = await person(co.domain);
    const { requestId } = await requestToJoin(db, { userId: sam.id, workspaceId: co.id });

    const result = await decideJoinRequest(db, {
      actorId: co.owner.id,
      requestId,
      decision: { approve: 'viewer' },
    });
    expect(result).toEqual({
      status: 'approved',
      notice: {
        to: sam.email,
        workspace: { id: co.id, name: co.name },
        approved: true,
        role: 'viewer',
      },
    });
    expect(await membershipsOf(co.id, sam.id)).toEqual([{ role: 'viewer' }]);
    expect(await requestsOf(co.id, sam.id)).toEqual([
      expect.objectContaining({ status: 'approved', role: 'viewer', decidedBy: co.owner.id }),
    ]);
    expect(await listJoinRequests(db, co.id)).toEqual([]);
    expect(await offered(sam.id)).toEqual([]);
  });

  it('decline creates no membership, and the person can’t ask again', async () => {
    const co = await company('request');
    const sam = await person(co.domain);
    const { requestId } = await requestToJoin(db, { userId: sam.id, workspaceId: co.id });

    const result = await decideJoinRequest(db, {
      actorId: co.owner.id,
      requestId,
      decision: 'decline',
    });
    expect(result).toEqual({
      status: 'declined',
      notice: { to: sam.email, workspace: { id: co.id, name: co.name }, approved: false },
    });
    expect(await membershipsOf(co.id, sam.id)).toEqual([]);
    expect(await requestsOf(co.id, sam.id)).toEqual([
      expect.objectContaining({ status: 'declined', role: null, decidedBy: co.owner.id }),
    ]);

    // No spam: the workspace is no longer offered, and asking again is refused — also concurrently.
    expect(await offered(sam.id)).toEqual([]);
    const again = await Promise.allSettled(
      Array.from({ length: 4 }, () => requestToJoin(db, { userId: sam.id, workspaceId: co.id })),
    );
    expect(outcomes(again).ok).toBe(0);
    for (const error of outcomes(again).errors) expect(error).toBeInstanceOf(NotFoundError);
    expect(await requestsOf(co.id, sam.id)).toHaveLength(1);
    // With nothing left to choose from, they get a workspace of their own.
    expect(await ensureFirstWorkspace(db, sam.id)).toMatchObject({ created: true });
  });

  it('someone approved once and removed since may ask again', async () => {
    const co = await company('request');
    const sam = await person(co.domain);
    const first = await requestToJoin(db, { userId: sam.id, workspaceId: co.id });
    await decideJoinRequest(db, {
      actorId: co.owner.id,
      requestId: first.requestId,
      decision: { approve: 'member' },
    });
    await db.delete(schema.membership).where(eq(schema.membership.userId, sam.id));
    const second = await requestToJoin(db, { userId: sam.id, workspaceId: co.id });
    expect(second.created).toBe(true);
    expect(second.requestId).not.toBe(first.requestId);
  });

  it('only owners and admins decide, and nobody approves above their own role', async () => {
    const co = await company('request');
    const admin = await addMember(co.id, co.domain, 'admin');
    const member = await addMember(co.id, co.domain, 'member');
    const viewer = await addMember(co.id, co.domain, 'viewer');
    const outsider = (await company('request')).owner;
    const sam = await person(co.domain);
    const { requestId } = await requestToJoin(db, { userId: sam.id, workspaceId: co.id });

    for (const actor of [member, viewer]) {
      for (const decision of [{ approve: 'viewer' } as const, 'decline' as const]) {
        await expect(
          decideJoinRequest(db, { actorId: actor.id, requestId, decision }),
        ).rejects.toThrow(ForbiddenError);
      }
    }
    // An owner of some other workspace, the requester themself, an unknown request: not found.
    for (const actorId of [outsider.id, sam.id]) {
      await expect(
        decideJoinRequest(db, { actorId, requestId, decision: { approve: 'owner' } }),
      ).rejects.toThrow(NotFoundError);
    }
    await expect(
      decideJoinRequest(db, { actorId: co.owner.id, requestId: 'nope', decision: 'decline' }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      decideJoinRequest(db, { actorId: admin.id, requestId, decision: { approve: 'owner' } }),
    ).rejects.toThrow(ForbiddenError);
    expect(await membershipsOf(co.id, sam.id)).toEqual([]);
    expect(await requestsOf(co.id, sam.id)).toEqual([
      expect.objectContaining({ status: 'pending', decidedBy: null }),
    ]);

    await decideJoinRequest(db, { actorId: admin.id, requestId, decision: { approve: 'admin' } });
    expect(await membershipsOf(co.id, sam.id)).toEqual([{ role: 'admin' }]);
  });

  it('concurrent decisions: exactly one counts, and approving twice makes one membership', async () => {
    for (let round = 0; round < 4; round++) {
      const co = await company('request');
      const admin = await addMember(co.id, co.domain, 'admin');
      const sam = await person(co.domain);
      const { requestId } = await requestToJoin(db, { userId: sam.id, workspaceId: co.id });

      const results = await Promise.allSettled([
        decideJoinRequest(db, {
          actorId: co.owner.id,
          requestId,
          decision: { approve: 'member' },
        }),
        decideJoinRequest(db, { actorId: admin.id, requestId, decision: { approve: 'viewer' } }),
        decideJoinRequest(db, { actorId: co.owner.id, requestId, decision: 'decline' }),
        decideJoinRequest(db, { actorId: admin.id, requestId, decision: 'decline' }),
      ]);
      const { ok, errors } = outcomes(results);
      expect(ok).toBe(1);
      expect(errors).toHaveLength(3);
      for (const error of errors) expect(error).toBeInstanceOf(JoinRequestDecidedError);

      const [request] = await requestsOf(co.id, sam.id);
      const memberships = await membershipsOf(co.id, sam.id);
      if (request!.status === 'approved') {
        expect(memberships).toEqual([{ role: request!.role }]);
      } else {
        expect(request!.status).toBe('declined');
        expect(memberships).toEqual([]);
      }
    }
  });

  it('a request can’t be decided twice, or after the workspace is deleted', async () => {
    const domain = newDomain();
    const keep = await company('invite_only', domain);
    const co = await company('request', domain);
    await db
      .insert(schema.membership)
      .values({ workspaceId: keep.id, userId: co.owner.id, role: 'member' });
    const sam = await person(domain);
    const pat = await person(domain);
    const first = await requestToJoin(db, { userId: sam.id, workspaceId: co.id });
    const second = await requestToJoin(db, { userId: pat.id, workspaceId: co.id });

    await decideJoinRequest(db, {
      actorId: co.owner.id,
      requestId: first.requestId,
      decision: 'decline',
    });
    await expect(
      decideJoinRequest(db, {
        actorId: co.owner.id,
        requestId: first.requestId,
        decision: { approve: 'member' },
      }),
    ).rejects.toThrow(/already declined/);
    expect(await membershipsOf(co.id, sam.id)).toEqual([]);

    await deleteWorkspace(db, { actorId: co.owner.id, workspaceId: co.id });
    await expect(
      decideJoinRequest(db, {
        actorId: co.owner.id,
        requestId: second.requestId,
        decision: { approve: 'member' },
      }),
    ).rejects.toThrow(NotFoundError);
    expect(await membershipsOf(co.id, pat.id)).toEqual([]);
  });

  it('someone who became a member meanwhile keeps their role when the request is approved', async () => {
    const co = await company('request');
    const sam = await person(co.domain);
    const { requestId } = await requestToJoin(db, { userId: sam.id, workspaceId: co.id });
    await db
      .insert(schema.membership)
      .values({ workspaceId: co.id, userId: sam.id, role: 'admin' });
    await decideJoinRequest(db, {
      actorId: co.owner.id,
      requestId,
      decision: { approve: 'viewer' },
    });
    expect(await membershipsOf(co.id, sam.id)).toEqual([{ role: 'admin' }]);
  });
});

// ---------------------------------------------------------------------------------------------------
// Join settings
// ---------------------------------------------------------------------------------------------------

describe('join settings', () => {
  it('a new workspace is invite_only with no domains', async () => {
    const owner = await person(newDomain());
    const { workspaceId } = await createOwnWorkspace(db, owner.id);
    expect(await getJoinSettings(db, workspaceId)).toEqual({ policy: 'invite_only', domains: [] });
    await expect(getJoinSettings(db, 'no-such-ws')).rejects.toThrow(NotFoundError);
  });

  it('only owners and admins change the policy or the domains', async () => {
    const co = await company('invite_only', newDomain(), { domains: [] });
    const admin = await addMember(co.id, co.domain, 'admin');
    const member = await addMember(co.id, co.domain, 'member');
    const viewer = await addMember(co.id, co.domain, 'viewer');
    const outsider = await person(co.domain);

    for (const actor of [member, viewer]) {
      await expect(
        setJoinPolicy(db, { actorId: actor.id, workspaceId: co.id, policy: 'auto_join' }),
      ).rejects.toThrow(ForbiddenError);
      await expect(addOwnDomain(db, { actorId: actor.id, workspaceId: co.id })).rejects.toThrow(
        ForbiddenError,
      );
      await expect(
        removeDomain(db, { actorId: actor.id, workspaceId: co.id, domain: co.domain }),
      ).rejects.toThrow(ForbiddenError);
    }
    await expect(
      setJoinPolicy(db, { actorId: outsider.id, workspaceId: co.id, policy: 'auto_join' }),
    ).rejects.toThrow(NotFoundError);
    await expect(addOwnDomain(db, { actorId: outsider.id, workspaceId: co.id })).rejects.toThrow(
      NotFoundError,
    );
    await expect(
      removeDomain(db, { actorId: outsider.id, workspaceId: co.id, domain: co.domain }),
    ).rejects.toThrow(NotFoundError);
    expect(await getJoinSettings(db, co.id)).toEqual({ policy: 'invite_only', domains: [] });

    await setJoinPolicy(db, { actorId: admin.id, workspaceId: co.id, policy: 'request' });
    expect(await addOwnDomain(db, { actorId: admin.id, workspaceId: co.id })).toEqual({
      domain: co.domain,
    });
    // Idempotent: the pair is unique.
    await addOwnDomain(db, { actorId: co.owner.id, workspaceId: co.id });
    expect(await getJoinSettings(db, co.id)).toEqual({ policy: 'request', domains: [co.domain] });

    await removeDomain(db, { actorId: admin.id, workspaceId: co.id, domain: ` @${co.domain} ` });
    await removeDomain(db, { actorId: admin.id, workspaceId: co.id, domain: 'not a domain' });
    expect(await getJoinSettings(db, co.id)).toEqual({ policy: 'request', domains: [] });
  });

  it('an owner can only list their own verified, non-public domain', async () => {
    const cases: Array<[string, { verified?: boolean }, 'unverified' | 'public']> = [
      ['gmail.com', {}, 'public'],
      ['outlook.com', {}, 'public'],
      [newDomain(), { verified: false }, 'unverified'],
    ];
    for (const [domain, options, reason] of cases) {
      const owner = await person(domain, options);
      const { workspaceId } = await createOwnWorkspace(db, owner.id);
      expect(
        listableDomain({ email: owner.email, emailVerified: options.verified ?? true }),
      ).toEqual({ domain: null, reason });
      await expect(addOwnDomain(db, { actorId: owner.id, workspaceId })).rejects.toThrow(
        ForbiddenError,
      );
      expect((await getJoinSettings(db, workspaceId)).domains).toEqual([]);
    }
    expect(listableDomain({ email: 'a@acme.test', emailVerified: true })).toEqual({
      domain: 'acme.test',
    });
  });

  it('the database refuses a second row for the same pair and a domain that isn’t normalised', async () => {
    const co = await company('request');
    await expect(
      db.insert(schema.workspaceDomain).values({ workspaceId: co.id, domain: co.domain }),
    ).rejects.toThrow();
    await expect(
      db.insert(schema.workspaceDomain).values({ workspaceId: co.id, domain: 'Shouty.Test' }),
    ).rejects.toThrow();
    const sam = await person(co.domain);
    await db.insert(schema.joinRequest).values({ workspaceId: co.id, userId: sam.id });
    await expect(
      db.insert(schema.joinRequest).values({ workspaceId: co.id, userId: sam.id }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------
// The first workspace, with something to join
// ---------------------------------------------------------------------------------------------------

describe('a newcomer with a workspace to join', () => {
  it('gets no workspace until they choose; "create my own" makes exactly one', async () => {
    const co = await company('auto_join');
    const sam = await person(co.domain, { name: 'Sam Stranger' });
    expect(await ensureFirstWorkspace(db, sam.id)).toEqual({
      workspaceId: undefined,
      created: false,
      choices: true,
    });
    expect(await listUserWorkspaces(db, sam.id)).toEqual([]);

    const results = await Promise.all(
      Array.from({ length: 6 }, () => createOwnWorkspace(db, sam.id)),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.workspaceId)).size).toBe(1);
    expect((await listUserWorkspaces(db, sam.id)).map((w) => [w.name, w.role])).toEqual([
      ['Sam’s workspace', 'owner'],
    ]);
    // The workspace they could join is still theirs to join later.
    expect(await offered(sam.id)).toEqual([[co.id, 'join']]);
    await expect(createOwnWorkspace(db, 'no-such-user')).rejects.toThrow(/unknown user/);
  });

  it('joining instead leaves them with that workspace only', async () => {
    const co = await company('auto_join');
    const sam = await person(co.domain);
    await joinWorkspace(db, { userId: sam.id, workspaceId: co.id });
    expect(await ensureFirstWorkspace(db, sam.id)).toEqual({ workspaceId: co.id, created: false });
    expect(await createOwnWorkspace(db, sam.id)).toEqual({ workspaceId: co.id, created: false });
  });

  it('an invite_only workspace on their domain holds nothing back: they get their own', async () => {
    const co = await company('invite_only');
    const sam = await person(co.domain);
    expect(await ensureFirstWorkspace(db, sam.id)).toMatchObject({ created: true });
  });

  it('signing up for real with a matching address creates no workspace and no active one', async () => {
    const co = await company('request');
    const email = `real-${rand()}@${co.domain}`;
    const res = await auth.handler(
      new Request(`${BASE}/api/auth/sign-in/magic-link`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE },
        body: JSON.stringify({ email, callbackURL: '/home' }),
      }),
    );
    expect(res.status).toBe(200);
    const token = outbox.findLast((m) => m.to === email)?.text.match(/token=([^&\s]+)/)?.[1];
    const verify = await auth.handler(
      new Request(magicLinkVerifyUrl(BASE, decodeURIComponent(token!), '/home'), {
        redirect: 'manual',
      }),
    );
    const cookie = verify.headers
      .getSetCookie()
      .map((c) => c.split(';')[0]!)
      .join('; ');
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session?.user.emailVerified).toBe(true);
    expect(session?.session.activeOrganizationId ?? null).toBeNull();
    expect(await listUserWorkspaces(db, session!.user.id)).toEqual([]);
    expect(await offered(session!.user.id)).toEqual([[co.id, 'request']]);
  });

  it('accepting an invitation settles a request that was waiting', async () => {
    const co = await company('request');
    const ownerEmail = co.owner.email;
    // A real session for the invitee (Better Auth accepts the invitation).
    const email = `invitee-${rand()}@${co.domain}`;
    await auth.handler(
      new Request(`${BASE}/api/auth/sign-in/magic-link`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE },
        body: JSON.stringify({ email, callbackURL: '/home' }),
      }),
    );
    const token = outbox.findLast((m) => m.to === email)?.text.match(/token=([^&\s]+)/)?.[1];
    const verify = await auth.handler(
      new Request(magicLinkVerifyUrl(BASE, decodeURIComponent(token!), '/home'), {
        redirect: 'manual',
      }),
    );
    const headers = new Headers({
      cookie: verify.headers
        .getSetCookie()
        .map((c) => c.split(';')[0]!)
        .join('; '),
    });
    const session = await auth.api.getSession({ headers });
    const userId = session!.user.id;
    await requestToJoin(db, { userId, workspaceId: co.id });
    const [invitation] = await db
      .insert(schema.invite)
      .values({
        workspaceId: co.id,
        email,
        role: 'viewer',
        inviterId: co.owner.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .returning();
    await auth.api.acceptInvitation({ body: { invitationId: invitation!.id }, headers });
    expect(await membershipsOf(co.id, userId)).toEqual([{ role: 'viewer' }]);
    expect(await requestsOf(co.id, userId)).toEqual([
      expect.objectContaining({ status: 'approved', role: 'viewer', decidedBy: null }),
    ]);
    expect(await listJoinRequests(db, co.id)).toEqual([]);
    expect(ownerEmail).toContain(co.domain);
  });
});

// ---------------------------------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------------------------------

describe('join emails', () => {
  it('a request mails every owner and admin; a decision mails the requester', async () => {
    const sent: EmailMessage[] = [];
    const capture: Mailer = { send: async (message) => void sent.push(message) };
    await sendJoinRequestEmails(capture, BASE, {
      workspace: { id: 'w', name: 'Acme' },
      requester: { name: 'Sam Stranger', email: 'sam@acme.test' },
      recipients: ['olive@acme.test', 'adam@acme.test'],
    });
    expect(sent.map((m) => m.to)).toEqual(['olive@acme.test', 'adam@acme.test']);
    expect(sent[0]!.subject).toBe('Sam Stranger asked to join Acme on Oat');
    expect(sent[0]!.text).toContain(`${BASE}/settings/workspace/members`);

    sent.length = 0;
    await sendJoinDecisionEmail(capture, BASE, {
      to: 'sam@acme.test',
      workspace: { id: 'w', name: 'Acme' },
      approved: true,
      role: 'admin',
    });
    await sendJoinDecisionEmail(capture, BASE, {
      to: 'sam@acme.test',
      workspace: { id: 'w', name: 'Acme' },
      approved: false,
    });
    expect(sent.map((m) => [m.to, m.subject])).toEqual([
      ['sam@acme.test', 'You’re in: Acme on Oat'],
      ['sam@acme.test', 'Your request to join Acme on Oat was declined'],
    ]);
    expect(sent[0]!.text).toContain('You’re now an admin.');
  });

  it('a mail server that is down does not fail the request or the decision', async () => {
    const broken: Mailer = {
      send: async () => {
        throw new Error('smtp down');
      },
    };
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      await expect(
        sendJoinRequestEmails(broken, BASE, {
          workspace: { id: 'w', name: 'Acme' },
          requester: { name: 'Sam', email: 'sam@acme.test' },
          recipients: ['olive@acme.test'],
        }),
      ).resolves.toBeUndefined();
    } finally {
      console.error = original;
    }
    expect(errors).toHaveLength(1);
  });
});
