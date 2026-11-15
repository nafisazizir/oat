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
import { invite, membership, session, workspace } from '@oat/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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

  it('updateWorkspace: members, viewers, outsiders and personal workspaces are refused', async () => {
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

    // Settings belong to team workspaces (core manageMembers); a personal one is refused too.
    const [personal] = await h.db
      .select({ id: workspace.id })
      .from(workspace)
      .innerJoin(membership, eq(membership.workspaceId, workspace.id))
      .where(and(eq(membership.userId, owner.id), eq(workspace.kind, 'personal')));
    as(owner);
    expect(await rename(personal!.id)).toEqual(refusedWith(FORBIDDEN));

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
