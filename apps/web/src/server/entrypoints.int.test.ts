/**
 * Every way into the server refuses callers without permission (5.5 authz audit, D-25), against a
 * throwaway database and an in-process Better Auth:
 *
 * 1. Every route handler and server action the coverage check enumerates (`api/authz-enumerate.ts`),
 *    except the PUBLIC ones, refuses an anonymous caller — route handlers with 401, server actions by
 *    redirecting to sign-in before doing anything. Imported from the real route/action modules, so a new
 *    entry point is covered the moment it exists.
 * 2. Deny cases for the server actions, run as the real actions (Next's request APIs stubbed, `getAuth` /
 *    `getDb` pointed at the harness): a signed-in user without permission gets an error result and nothing
 *    changes. Each has a happy-path control so a broken setup can't pass as a refusal.
 */
import { findFirstWorkspaceId } from '@oat/auth';
import {
  invite,
  joinRequest,
  membership,
  session,
  user,
  workspace,
  workspaceDomain,
} from '@oat/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import * as joining from './actions/joining';
import * as members from './actions/members';
import * as workspaces from './actions/workspaces';
import { handlers } from './api/authz-enumerate';
import { PUBLIC } from './api/authz-registry';
import { BASE, createHarness, denies, type Harness, type TestUser } from './api/test-harness';

const env = vi.hoisted(() => {
  /** What our `next/navigation` stub throws: the server action / page would have redirected. */
  class Redirected extends Error {
    constructor(readonly url: string) {
      super(`redirect → ${url}`);
    }
  }
  return {
    Redirected,
    headers: new Headers(),
    harness: undefined as Harness | undefined,
  };
});

vi.mock('next/headers', () => ({
  headers: async () => env.headers,
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set() {} }),
}));
vi.mock('next/cache', () => ({ refresh() {}, revalidatePath() {}, revalidateTag() {} }));
vi.mock('next/navigation', () => ({
  redirect(url: string): never {
    throw new env.Redirected(url);
  },
  notFound(): never {
    throw new env.Redirected('/404');
  },
}));
vi.mock('./auth', () => ({
  getAuth: () => env.harness!.auth,
  getAuthConfig: () => ({ baseURL: BASE, trustedOrigins: [] }),
  getMailer: () => ({
    send: async (message: { to: string; subject: string; text: string; html: string }) =>
      void env.harness!.outbox.push(message),
  }),
}));
vi.mock('./db', () => ({
  getDb: () => env.harness!.db,
  pingDb: async () => {},
}));

let h: Harness;
let owner: TestUser;
let admin: TestUser;
let member: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let team: string;

beforeAll(async () => {
  h = await createHarness();
  env.harness = h;
  [owner, admin, member, viewer, outsider] = await Promise.all([
    h.signUp('owner'),
    h.signUp('admin'),
    h.signUp('member'),
    h.signUp('viewer'),
    h.signUp('outsider'),
  ]);
  team = await h.teamWorkspace(owner, [
    [admin, 'admin'],
    [member, 'member'],
    [viewer, 'viewer'],
  ]);
}, 60_000);

afterAll(async () => {
  await h?.close();
});

/** Acts as `user` (their session cookie) for the following action calls; `null` = anonymous. */
function as(user: TestUser | null): void {
  env.headers = new Headers(user ? { cookie: user.cookie, origin: BASE } : { origin: BASE });
}

const refusedWith = (message: RegExp) => ({ ok: false, error: expect.stringMatching(message) });
const FORBIDDEN = /permission|can’t|only/i;
const NOT_FOUND = /no longer exists|no longer valid|unknown/i;

// ---------------------------------------------------------------------------------------------------
// 1. Anonymous callers, every entry point
// ---------------------------------------------------------------------------------------------------

describe('anonymous callers are refused everywhere', () => {
  const entries = [...handlers().keys.entries()].filter(([key]) => !(key in PUBLIC));
  const routes = entries.filter(([key]) => !key.startsWith('action '));
  const actions = entries.filter(([key]) => key.startsWith('action '));

  it('finds the entry points', () => {
    expect(routes.length).toBeGreaterThan(10);
    expect(actions.length).toBeGreaterThan(10);
  });

  it.each(routes)('%s → 401', async (key, file) => {
    const method = key.split(' ')[0]!;
    const mod = (await import(/* @vite-ignore */ file)) as Record<
      string,
      (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>
    >;
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const request = new Request(`${BASE}/api/anything?workspaceId=${team}&q=x`, {
      method,
      headers: { origin: BASE, ...(hasBody ? { 'content-type': 'application/json' } : {}) },
      ...(hasBody ? { body: JSON.stringify({ workspaceId: team, title: 'x', name: 'x' }) } : {}),
    });
    const res = await mod[method]!(request, { params: Promise.resolve({ id: team }) });
    expect(res.status).toBe(401);
  });

  it.each(actions)('%s → sign-in', async (key, file) => {
    const name = key.split('#')[1]!;
    const mod = (await import(/* @vite-ignore */ file)) as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    as(null);
    await expect(
      mod[name]!({ workspaceId: team, userId: owner.id, role: 'viewer', email: 'a@b.test' }),
    ).rejects.toMatchObject({ url: '/sign-in' });
  });
});

// ---------------------------------------------------------------------------------------------------
// 2. Server actions: signed in, without permission
// ---------------------------------------------------------------------------------------------------

const roleOf = async (workspaceId: string, userId: string) =>
  (
    await h.db
      .select({ role: membership.role })
      .from(membership)
      .where(and(eq(membership.workspaceId, workspaceId), eq(membership.userId, userId)))
  )[0]?.role;

const workspaceRow = async (id: string) =>
  (await h.db.select().from(workspace).where(eq(workspace.id, id)))[0]!;

const invitesTo = (email: string) => h.db.select().from(invite).where(eq(invite.email, email));

async function pendingInvite(email: string, role: 'member' | 'admin' = 'member') {
  as(owner);
  expect(await members.inviteMember({ workspaceId: team, email, role })).toEqual({ ok: true });
  const [row] = await invitesTo(email);
  return row!;
}

let counter = 0;
const address = (label: string) => `${label}-${Date.now()}-${counter++}@example.test`;

describe('workspace actions', () => {
  it('switchWorkspace: a non-member cannot make a workspace active', async () => {
    denies('action server/actions/workspaces.ts#switchWorkspace');
    as(outsider);
    expect(await workspaces.switchWorkspace(team)).toMatchObject({ ok: false });
    const [row] = await h.db.select().from(session).where(eq(session.userId, outsider.id));
    expect(row!.activeWorkspaceId).not.toBe(team);

    as(member);
    expect(await workspaces.switchWorkspace(team)).toEqual({ ok: true, workspaceId: team });
  });

  it('updateWorkspace: members, viewers and outsiders are refused; the workspace made at sign-up can be renamed', async () => {
    denies('action server/actions/members.ts#updateWorkspace');
    const rename = (workspaceId: string) =>
      members.updateWorkspace({ workspaceId, name: 'Hijacked', icon: null });
    for (const user of [member, viewer]) {
      as(user);
      expect(await rename(team), user.email).toEqual(refusedWith(FORBIDDEN));
    }
    as(outsider);
    expect(await rename(team)).toEqual(refusedWith(NOT_FOUND));
    expect((await workspaceRow(team)).name).toBe('Team');

    // D-36: the workspace made for a user at sign-up is an ordinary one — its owner renames it, and
    // nobody else does.
    const own = (await findFirstWorkspaceId(h.db, owner.id))!;
    as(admin);
    expect(await rename(own)).toEqual(refusedWith(NOT_FOUND));
    as(owner);
    expect(
      await members.updateWorkspace({ workspaceId: own, name: 'Owner HQ', icon: null }),
    ).toEqual({ ok: true });
    expect((await workspaceRow(own)).name).toBe('Owner HQ');

    as(admin);
    expect(await members.updateWorkspace({ workspaceId: team, name: 'Team', icon: '🌾' })).toEqual({
      ok: true,
    });
  });

  it('deleteWorkspace: only an owner deletes', async () => {
    denies('action server/actions/members.ts#deleteWorkspace');
    const { name } = await workspaceRow(team);
    for (const user of [admin, member, viewer]) {
      as(user);
      expect(await members.deleteWorkspace({ workspaceId: team, confirmName: name })).toEqual(
        refusedWith(FORBIDDEN),
      );
    }
    as(outsider);
    expect(await members.deleteWorkspace({ workspaceId: team, confirmName: name })).toEqual(
      refusedWith(NOT_FOUND),
    );
    expect((await workspaceRow(team)).deletedAt).toBeNull();
  });

  it('leaveWorkspace: the last owner cannot leave; non-members have nothing to leave', async () => {
    denies('action server/actions/members.ts#leaveWorkspace');
    as(owner);
    expect(await members.leaveWorkspace(team)).toMatchObject({ ok: false });
    as(outsider);
    expect(await members.leaveWorkspace(team)).toEqual(refusedWith(NOT_FOUND));
    expect(await roleOf(team, owner.id)).toBe('owner');
  });

  // D-36: nobody ends up without a workspace by their own action.
  it('leaveWorkspace and deleteWorkspace: never your only workspace, and the refusal says so', async () => {
    denies('action server/actions/members.ts#leaveWorkspace');
    denies('action server/actions/members.ts#deleteWorkspace');
    const solo = await h.signUp('only-one');
    const own = (await findFirstWorkspaceId(h.db, solo.id))!;
    const { name } = await workspaceRow(own);
    as(solo);
    expect(await members.leaveWorkspace(own)).toEqual(
      refusedWith(
        /^This is your only workspace\. Create or join another one before you leave it\.$/,
      ),
    );
    expect(await members.deleteWorkspace({ workspaceId: own, confirmName: name })).toEqual(
      refusedWith(
        /^This is your only workspace\. Create or join another one before you delete it\.$/,
      ),
    );
    expect((await workspaceRow(own)).deletedAt).toBeNull();
    expect(await roleOf(own, solo.id)).toBe('owner');

    // A member whose only workspace is someone else's can't leave it either.
    const guest = await h.signUp('only-guest');
    const theirs = (await findFirstWorkspaceId(h.db, guest.id))!;
    await h.db.insert(membership).values({ workspaceId: own, userId: guest.id, role: 'member' });
    await h.db.delete(membership).where(eq(membership.workspaceId, theirs));
    as(guest);
    expect(await members.leaveWorkspace(own)).toMatchObject({
      ok: false,
      error: expect.stringContaining('only workspace'),
    });
    expect(await roleOf(own, guest.id)).toBe('member');
  });
});

describe('member actions', () => {
  it('changeRole: admins can’t touch owners or grant owner; members, viewers, outsiders can’t at all', async () => {
    denies('action server/actions/members.ts#changeRole');
    const change = (actor: TestUser, target: TestUser, role: 'owner' | 'admin' | 'viewer') => {
      as(actor);
      return members.changeRole({ workspaceId: team, userId: target.id, role });
    };
    expect(await change(admin, owner, 'viewer')).toMatchObject({ ok: false });
    expect(await change(admin, member, 'owner')).toMatchObject({ ok: false });
    expect(await change(member, viewer, 'admin')).toMatchObject({ ok: false });
    expect(await change(viewer, viewer, 'admin')).toMatchObject({ ok: false });
    expect(await change(outsider, member, 'viewer')).toMatchObject({ ok: false });
    expect(await roleOf(team, owner.id)).toBe('owner');
    expect(await roleOf(team, member.id)).toBe('member');
    expect(await roleOf(team, viewer.id)).toBe('viewer');
  });

  it('removeMember: admins can’t remove owners; members, viewers, outsiders remove nobody', async () => {
    denies('action server/actions/members.ts#removeMember');
    const removeAs = (actor: TestUser, target: TestUser) => {
      as(actor);
      return members.removeMember({ workspaceId: team, userId: target.id });
    };
    expect(await removeAs(admin, owner)).toEqual(refusedWith(FORBIDDEN));
    expect(await removeAs(member, viewer)).toEqual(refusedWith(FORBIDDEN));
    expect(await removeAs(viewer, member)).toEqual(refusedWith(FORBIDDEN));
    expect(await removeAs(outsider, member)).toMatchObject({ ok: false });
    for (const [user, role] of [
      [owner, 'owner'],
      [member, 'member'],
      [viewer, 'viewer'],
    ] as const) {
      expect(await roleOf(team, user.id)).toBe(role);
    }
  });
});

describe('invitation actions', () => {
  it('inviteMember: members, viewers and outsiders can’t invite; admins can’t invite owners', async () => {
    denies('action server/actions/members.ts#inviteMember');
    const attempts: Array<[TestUser, 'member' | 'owner']> = [
      [member, 'member'],
      [viewer, 'member'],
      [outsider, 'member'],
      [admin, 'owner'],
    ];
    for (const [actor, role] of attempts) {
      const email = address('nope');
      as(actor);
      expect(await members.inviteMember({ workspaceId: team, email, role }), actor.email).toEqual(
        expect.objectContaining({ ok: false }),
      );
      expect(await invitesTo(email)).toEqual([]);
    }
    as(admin);
    expect(
      await members.inviteMember({ workspaceId: team, email: address('ok'), role: 'admin' }),
    ).toEqual({ ok: true });
  });

  it('resendInvite and revokeInvite: only owners and admins of that workspace', async () => {
    denies(
      'action server/actions/members.ts#resendInvite',
      'action server/actions/members.ts#revokeInvite',
    );
    const pending = await pendingInvite(address('pending'));
    for (const actor of [member, viewer, outsider]) {
      as(actor);
      expect(await members.resendInvite(pending.id), actor.email).toMatchObject({ ok: false });
      expect(await members.revokeInvite(pending.id), actor.email).toMatchObject({ ok: false });
    }
    const [after] = await invitesTo(pending.email);
    expect(after).toMatchObject({ status: 'pending', expiresAt: pending.expiresAt });

    as(admin);
    expect(await members.revokeInvite(pending.id)).toEqual({ ok: true });
  });

  it('acceptInvite and declineInvite: only the invited address', async () => {
    denies(
      'action server/actions/members.ts#acceptInvite',
      'action server/actions/members.ts#declineInvite',
    );
    const invitee = await h.signUp('invitee');
    const pending = await pendingInvite(invitee.email);
    for (const actor of [outsider, member, owner]) {
      as(actor);
      expect(await members.acceptInvite(pending.token), actor.email).toEqual(
        refusedWith(/different address/),
      );
      expect(await members.declineInvite(pending.token), actor.email).toEqual(
        refusedWith(/different address/),
      );
    }
    expect(await roleOf(team, outsider.id)).toBeUndefined();
    expect((await invitesTo(invitee.email))[0]!.status).toBe('pending');

    as(invitee);
    expect(await members.declineInvite(pending.token)).toEqual({ ok: true });
    expect((await invitesTo(invitee.email))[0]!.status).toBe('rejected');
    expect(await roleOf(team, invitee.id)).toBeUndefined();
  });
});

// D-36, step B: joining by email domain. Its own company and domain, so nobody else in this file matches.
describe('joining actions', () => {
  const domain = `join-${Date.now()}.test`;
  let boss: TestUser;
  let coAdmin: TestUser;
  let coMember: TestUser;
  let coViewer: TestUser;
  let co: string;

  const NOT_OPEN = /isn’t open to you/;
  const joinSettings = async (workspaceId: string) => ({
    policy: (await workspaceRow(workspaceId)).joinPolicy,
    domains: (
      await h.db
        .select({ domain: workspaceDomain.domain })
        .from(workspaceDomain)
        .where(eq(workspaceDomain.workspaceId, workspaceId))
    ).map((d) => d.domain),
  });
  const requestsBy = (userId: string) =>
    h.db.select().from(joinRequest).where(eq(joinRequest.userId, userId));
  const mailsTo = (email: string, subject: RegExp) =>
    h.outbox.filter((m) => m.to === email && subject.test(m.subject));
  /** Runs an action that ends in a redirect and returns where it went. */
  const redirected = async (action: Promise<unknown>) =>
    (await action.then(
      () => undefined,
      (error: unknown) => error,
    )) as { url?: string } | undefined;

  beforeAll(async () => {
    [boss, coAdmin, coMember, coViewer] = await Promise.all([
      h.signUp('boss', domain),
      h.signUp('co-admin', domain),
      h.signUp('co-member', domain),
      h.signUp('co-viewer', domain),
    ]);
    co = await h.teamWorkspace(boss, [
      [coAdmin, 'admin'],
      [coMember, 'member'],
      [coViewer, 'viewer'],
    ]);
  }, 60_000);

  it('setJoinPolicy, allowMyDomain, removeAllowedDomain: only owners and admins of that workspace', async () => {
    denies(
      'action server/actions/joining.ts#setJoinPolicy',
      'action server/actions/joining.ts#allowMyDomain',
      'action server/actions/joining.ts#removeAllowedDomain',
    );
    as(boss);
    expect(await joining.allowMyDomain(co)).toEqual({ ok: true });
    expect(await joinSettings(co)).toEqual({ policy: 'invite_only', domains: [domain] });

    for (const actor of [coMember, coViewer, outsider]) {
      as(actor);
      const expected = refusedWith(actor === outsider ? NOT_FOUND : FORBIDDEN);
      expect(
        await joining.setJoinPolicy({ workspaceId: co, policy: 'auto_join' }),
        actor.email,
      ).toEqual(expected);
      expect(await joining.allowMyDomain(co), actor.email).toEqual({
        ok: false,
        error: expect.stringMatching(
          actor === outsider ? NOT_FOUND : /your own verified work email/,
        ),
      });
      expect(await joining.removeAllowedDomain({ workspaceId: co, domain }), actor.email).toEqual(
        expected,
      );
    }
    expect(await joinSettings(co)).toEqual({ policy: 'invite_only', domains: [domain] });

    // An admin may: an unknown policy is still refused, a domain can be removed and added back.
    as(coAdmin);
    expect(
      await joining.setJoinPolicy({ workspaceId: co, policy: 'bogus' as never }),
    ).toMatchObject({ ok: false });
    expect(await joining.removeAllowedDomain({ workspaceId: co, domain })).toEqual({ ok: true });
    expect(await joining.allowMyDomain(co)).toEqual({ ok: true });
    expect(await joinSettings(co)).toEqual({ policy: 'invite_only', domains: [domain] });
  });

  it('allowMyDomain: never a client-sent domain, never a public mailbox domain', async () => {
    denies('action server/actions/joining.ts#allowMyDomain');
    // There is no domain argument; smuggling one in is refused outright.
    as(boss);
    expect(
      await joining.allowMyDomain({ workspaceId: co, domain: 'evil.test' } as never),
    ).toMatchObject({ ok: false });
    expect((await joinSettings(co)).domains).toEqual([domain]);

    // An owner with a public mailbox address has no domain to add, even to their own workspace.
    const gmailer = await h.signUp('gmailer', 'gmail.com');
    const own = (await findFirstWorkspaceId(h.db, gmailer.id))!;
    as(gmailer);
    expect(await joining.allowMyDomain(own)).toEqual(refusedWith(/Public mail services/));
    expect((await joinSettings(own)).domains).toEqual([]);
  });

  it('joinWorkspace and requestAccess: an invite-only workspace is closed; only a verified address on an allowed domain gets in', async () => {
    denies(
      'action server/actions/joining.ts#joinWorkspace',
      'action server/actions/joining.ts#requestAccess',
    );
    // invite_only: a matching stranger can neither join nor ask (and gets their own workspace at sign-up).
    const early = await h.signUp('early', domain);
    expect(await findFirstWorkspaceId(h.db, early.id)).toBeDefined();
    as(early);
    expect(await joining.joinWorkspace(co)).toEqual(refusedWith(NOT_OPEN));
    expect(await joining.requestAccess(co)).toEqual(refusedWith(NOT_OPEN));

    // request: asking works for a matching address only; joining outright doesn't.
    as(boss);
    expect(await joining.setJoinPolicy({ workspaceId: co, policy: 'request' })).toEqual({
      ok: true,
    });
    as(outsider); // example.test: not an allowed domain
    expect(await joining.requestAccess(co)).toEqual(refusedWith(NOT_OPEN));
    expect(await joining.joinWorkspace(co)).toEqual(refusedWith(NOT_OPEN));
    as(coMember); // already in
    expect(await joining.requestAccess(co)).toEqual(refusedWith(NOT_OPEN));

    const asker = await h.signUp('asker', domain);
    // With a workspace to ask, sign-up created none for them.
    expect(await findFirstWorkspaceId(h.db, asker.id)).toBeUndefined();
    await h.db.update(user).set({ emailVerified: false }).where(eq(user.id, asker.id));
    as(asker);
    expect(await joining.requestAccess(co)).toEqual(refusedWith(NOT_OPEN));
    await h.db.update(user).set({ emailVerified: true }).where(eq(user.id, asker.id));
    expect(await joining.joinWorkspace(co)).toEqual(refusedWith(NOT_OPEN));
    expect(await requestsBy(asker.id)).toEqual([]);

    expect(await joining.requestAccess(co)).toEqual({ ok: true });
    expect(await joining.requestAccess(co)).toEqual({ ok: true }); // again: still one, no second mail
    expect(await requestsBy(asker.id)).toEqual([
      expect.objectContaining({ workspaceId: co, status: 'pending' }),
    ]);
    expect(await roleOf(co, asker.id)).toBeUndefined();
    for (const manager of [boss, coAdmin]) {
      expect(mailsTo(manager.email, /asked to join Team on Oat$/)).toHaveLength(1);
    }
    for (const other of [coMember, coViewer]) {
      expect(mailsTo(other.email, /asked to join/)).toEqual([]);
    }

    // auto_join: a matching address joins as member and lands in the workspace.
    as(coAdmin);
    expect(await joining.setJoinPolicy({ workspaceId: co, policy: 'auto_join' })).toEqual({
      ok: true,
    });
    as(outsider);
    expect(await joining.joinWorkspace(co)).toEqual(refusedWith(NOT_OPEN));
    expect(await roleOf(co, outsider.id)).toBeUndefined();
    const joiner = await h.signUp('joiner', domain);
    as(joiner);
    expect(await redirected(joining.joinWorkspace(co))).toMatchObject({ url: '/home' });
    expect(await roleOf(co, joiner.id)).toBe('member');
    const [row] = await h.db.select().from(session).where(eq(session.userId, joiner.id));
    expect(row!.activeWorkspaceId).toBe(co);

    as(boss);
    expect(await joining.setJoinPolicy({ workspaceId: co, policy: 'request' })).toEqual({
      ok: true,
    });
  });

  it('approveJoinRequest and declineJoinRequest: only owners and admins, never above their own role', async () => {
    denies(
      'action server/actions/joining.ts#approveJoinRequest',
      'action server/actions/joining.ts#declineJoinRequest',
    );
    const first = await h.signUp('wants-in', domain);
    const second = await h.signUp('wants-in-too', domain);
    for (const requester of [first, second]) {
      as(requester);
      expect(await joining.requestAccess(co)).toEqual({ ok: true });
    }
    const [one] = await requestsBy(first.id);
    const [two] = await requestsBy(second.id);

    for (const actor of [coMember, coViewer, outsider, first]) {
      as(actor);
      const expected = refusedWith(
        actor === coMember || actor === coViewer ? FORBIDDEN : NOT_FOUND,
      );
      expect(
        await joining.approveJoinRequest({ requestId: one!.id, role: 'viewer' }),
        actor.email,
      ).toEqual(expected);
      expect(await joining.declineJoinRequest(one!.id), actor.email).toEqual(expected);
    }
    as(coAdmin);
    expect(await joining.approveJoinRequest({ requestId: one!.id, role: 'owner' })).toEqual(
      refusedWith(FORBIDDEN),
    );
    expect(
      await joining.approveJoinRequest({ requestId: one!.id, role: 'root' as never }),
    ).toMatchObject({ ok: false });
    expect(await roleOf(co, first.id)).toBeUndefined();
    expect((await requestsBy(first.id))[0]!.status).toBe('pending');
    expect(mailsTo(first.email, /You’re in|declined/)).toEqual([]);

    expect(await joining.approveJoinRequest({ requestId: one!.id, role: 'viewer' })).toEqual({
      ok: true,
    });
    expect(await roleOf(co, first.id)).toBe('viewer');
    expect(mailsTo(first.email, /^You’re in: Team on Oat$/)).toHaveLength(1);
    // Decided once: a second decision is refused and changes nothing.
    as(boss);
    expect(await joining.declineJoinRequest(one!.id)).toEqual(refusedWith(/already approved/));
    expect(await roleOf(co, first.id)).toBe('viewer');

    expect(await joining.declineJoinRequest(two!.id)).toEqual({ ok: true });
    expect(await roleOf(co, second.id)).toBeUndefined();
    expect(mailsTo(second.email, /was declined$/)).toHaveLength(1);
    // A declined person can't ask again.
    as(second);
    expect(await joining.requestAccess(co)).toEqual(refusedWith(NOT_OPEN));
    expect(await requestsBy(second.id)).toHaveLength(1);
  });

  it('createMyWorkspace: makes one workspace for a user without one, and nothing for a user who has one', async () => {
    const chooser = await h.signUp('chooser', domain);
    expect(await findFirstWorkspaceId(h.db, chooser.id)).toBeUndefined();
    as(chooser);
    expect(await redirected(joining.createMyWorkspace())).toMatchObject({ url: '/home' });
    const own = await findFirstWorkspaceId(h.db, chooser.id);
    expect(own).toBeDefined();
    expect(await roleOf(own!, chooser.id)).toBe('owner');
    expect(await redirected(joining.createMyWorkspace())).toMatchObject({ url: '/home' });
    const created = await h.db.select().from(workspace).where(eq(workspace.createdBy, chooser.id));
    expect(created).toHaveLength(1);
    expect(await roleOf(co, chooser.id)).toBeUndefined();
  });
});
