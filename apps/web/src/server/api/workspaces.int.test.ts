import { findGoogleCalendarConnection, findInvite, type Mailer } from '@oat/auth';
import { account, invite, joinRequest, membership } from '@oat/db';
import { and, eq } from 'drizzle-orm';
import type {
  CalendarConnectionStatus,
  WorkspaceSettings,
  WorkspaceList,
  WorkspaceMutationResult,
} from '@oat/services/dto/workspaces';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { OperationContext } from '../operation-context';
import { createWorkspaceApi } from './workspaces';
import type { RouteHandler } from './route';
import { BASE, call, createHarness, denies, type Harness, type TestUser } from './test-harness';

let h: Harness;
let api: ReturnType<typeof createWorkspaceApi>;
let owner: TestUser;
let member: TestUser;
let outsider: TestUser;
let team: string;
const disconnect = vi.fn(async (_id: string) => {});
beforeAll(async () => {
  h = await createHarness();
  [owner, member, outsider] = await Promise.all([
    h.signUp('api-owner'),
    h.signUp('api-member'),
    h.signUp('api-outsider'),
  ]);
  team = await h.teamWorkspace(owner, [[member, 'member']]);
  api = createWorkspaceApi(
    {
      db: () => h.db,
      getSession: (headers) => h.auth.api.getSession({ headers }),
      allowedOrigins: () => [BASE],
    },
    {
      context: async (_id, headers): Promise<OperationContext> => {
        const session = await h.auth.api.getSession({ headers });
        if (!session) throw new Error('missing test session');
        const mailer: Mailer = { send: async (message) => void h.outbox.push(message) };
        return {
          db: h.db,
          auth: h.auth,
          user: session.user,
          headers,
          mailer,
          baseURL: BASE,
          disconnectCalendar: disconnect,
        };
      },
    },
  );
}, 60_000);
afterAll(async () => {
  await h?.close();
});
type Options = {
  as?: TestUser | null;
  body?: unknown;
  params?: Record<string, string>;
  bearer?: boolean;
  origin?: string | null;
};
const send = (handler: unknown, method: string, options: Options = {}) =>
  call<
    WorkspaceSettings &
      WorkspaceList &
      WorkspaceMutationResult &
      CalendarConnectionStatus &
      unknown[] & { error: { message: string } }
  >(handler as RouteHandler<never>, method, '/api/workspaces', {
    as: options.as === undefined ? owner : options.as,
    bearer: true,
    ...options,
  });
const inTeam = (params: Record<string, string> = {}) => ({ id: team, ...params });

describe('workspace REST reads and writes', () => {
  it('self-scoped routes refuse anonymous requests', async () => {
    denies(
      'GET /api/workspaces/joinable',
      'GET /api/workspaces',
      'POST /api/workspaces',
      'POST /api/workspaces/mine',
      'GET /api/calendar/google',
      'DELETE /api/calendar/google',
    );
    for (const [handler, method] of [
      [api.joinable.GET, 'GET'],
      [api.workspaces.GET, 'GET'],
      [api.workspaces.POST, 'POST'],
      [api.mine.POST, 'POST'],
      [api.calendar.GET, 'GET'],
      [api.calendar.DELETE, 'DELETE'],
    ] as const) {
      expect((await send(handler, method, { as: null })).status).toBe(401);
    }
  });
  it('lists only own workspaces with active id; bearer creates and switches', async () => {
    expect(
      (await send(api.workspaces.GET, 'GET')).body.workspaces.some(
        (w: { id: string }) => w.id === team,
      ),
    ).toBe(true);
    const created = await send(api.workspaces.POST, 'POST', {
      body: { name: 'API-created' },
      origin: null,
    });
    expect(created.status).toBe(200);
    const list = await send(api.workspaces.GET, 'GET');
    expect(list.body.activeWorkspaceId).toBe(created.body.workspaceId);
    expect((await send(api.active.PUT, 'PUT', { body: { workspaceId: team } })).status).toBe(200);
    expect((await send(api.workspaces.GET, 'GET')).body.activeWorkspaceId).toBe(team);
    expect((await send(api.mine.POST, 'POST')).status).toBe(200);
    expect((await send(api.workspaces.POST, 'POST', { body: { name: '' } })).status).toBe(400);
  });
  it('refuses switching into a foreign workspace', async () => {
    denies('PUT /api/workspaces/active');
    const denied = await send(api.active.PUT, 'PUT', { as: outsider, body: { workspaceId: team } });
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(denied.body.error.message).toBeTruthy();
  });
  it('settings and members hide foreign workspaces; members cannot edit', async () => {
    denies(
      'GET /api/workspaces/[id]',
      'PATCH /api/workspaces/[id]',
      'GET /api/workspaces/[id]/members',
    );
    for (const handler of [api.workspace.GET, api.members.GET]) {
      expect((await send(handler, 'GET', { as: outsider, params: inTeam() })).status).toBe(404);
      expect((await send(handler, 'GET', { as: member, params: inTeam() })).status).toBe(200);
    }
    const body = { name: 'Renamed', icon: null };
    expect(
      (await send(api.workspace.PATCH, 'PATCH', { as: member, params: inTeam(), body })).status,
    ).toBe(403);
    expect((await send(api.workspace.PATCH, 'PATCH', { params: inTeam(), body })).status).toBe(200);
    const snapshot = await send(api.workspace.GET, 'GET', { params: inTeam() });
    expect(snapshot.body.workspace.name).toBe('Renamed');
    expect(snapshot.body.joining?.policy).toBe('invite_only');
    expect((await send(api.members.GET, 'GET', { params: inTeam() })).body).toHaveLength(2);
    expect(
      (await send(api.workspace.GET, 'GET', { as: member, params: inTeam() })).body.joining,
    ).toBeNull();
  });
  it('CSRF refuses cookie writes without origin while bearer writes work', async () => {
    expect(
      (
        await send(api.workspaces.POST, 'POST', {
          body: { name: 'No' },
          bearer: false,
          origin: null,
        })
      ).status,
    ).toBe(403);
  });
  it('only owners delete; leaving requires membership and another workspace', async () => {
    denies('DELETE /api/workspaces/[id]', 'POST /api/workspaces/[id]/leave');
    const extra = await h.teamWorkspace(owner, [[member, 'member']]);
    const params = { id: extra };
    expect(
      (
        await send(api.workspace.DELETE, 'DELETE', {
          as: member,
          params,
          body: { confirmName: 'Team' },
        })
      ).status,
    ).toBe(403);
    expect((await send(api.leave.POST, 'POST', { as: outsider, params })).status).toBe(404);
    expect(
      (await send(api.workspace.DELETE, 'DELETE', { params, body: { confirmName: 'wrong' } }))
        .status,
    ).toBe(400);
    expect((await send(api.leave.POST, 'POST', { as: member, params })).status).toBe(200);
    expect(
      (await send(api.workspace.DELETE, 'DELETE', { params, body: { confirmName: 'Team' } }))
        .status,
    ).toBe(200);
  });
});

describe('members and invitations REST', () => {
  it('role changes/removals deny members and non-members, then succeed for owner', async () => {
    denies(
      'PATCH /api/workspaces/[id]/members/[memberId]',
      'DELETE /api/workspaces/[id]/members/[memberId]',
    );
    const target = await h.signUp('api-target');
    const id = await h.teamWorkspace(owner, [
      [member, 'member'],
      [target, 'viewer'],
    ]);
    const params = { id, memberId: target.id };
    for (const actor of [member, outsider]) {
      expect(
        (await send(api.member.PATCH, 'PATCH', { as: actor, params, body: { role: 'member' } }))
          .status,
      ).toBeGreaterThanOrEqual(400);
      expect(
        (await send(api.member.DELETE, 'DELETE', { as: actor, params })).status,
      ).toBeGreaterThanOrEqual(400);
    }
    expect(
      (await send(api.member.PATCH, 'PATCH', { params, body: { role: 'member' } })).status,
    ).toBe(200);
    expect((await send(api.member.DELETE, 'DELETE', { params })).status).toBe(200);
  });
  it('invites list/create/resend/revoke enforce admin rights and path workspace', async () => {
    denies(
      'GET /api/workspaces/[id]/invites',
      'POST /api/workspaces/[id]/invites',
      'POST /api/workspaces/[id]/invites/[inviteId]/resend',
      'DELETE /api/workspaces/[id]/invites/[inviteId]',
    );
    const email = 'rest-invite@example.test';
    const body = { email, role: 'viewer' };
    for (const actor of [member, outsider]) {
      expect(
        (await send(api.invites.GET, 'GET', { as: actor, params: inTeam() })).status,
      ).toBeGreaterThanOrEqual(400);
      expect(
        (await send(api.invites.POST, 'POST', { as: actor, params: inTeam(), body })).status,
      ).toBeGreaterThanOrEqual(400);
    }
    expect((await send(api.invites.GET, 'GET', { params: inTeam() })).body).toEqual([]);
    expect((await send(api.invites.POST, 'POST', { params: inTeam(), body })).status).toBe(200);
    const [row] = await h.db.select().from(invite).where(eq(invite.email, email));
    const params = inTeam({ inviteId: row!.id });
    for (const actor of [member, outsider]) {
      expect(
        (await send(api.resend.POST, 'POST', { as: actor, params })).status,
      ).toBeGreaterThanOrEqual(400);
      expect(
        (await send(api.invite.DELETE, 'DELETE', { as: actor, params })).status,
      ).toBeGreaterThanOrEqual(400);
    }
    const foreign = await h.teamWorkspace(owner, []);
    expect(
      (await send(api.resend.POST, 'POST', { params: { id: foreign, inviteId: row!.id } })).status,
    ).toBe(404);
    expect((await send(api.resend.POST, 'POST', { params })).status).toBe(200);
    expect((await send(api.invite.DELETE, 'DELETE', { params })).status).toBe(200);
    expect((await findInvite(h.db, row!.id))!.status).toBe('canceled');
  });
  it('accept/decline require recipient identity; bearer acceptance sets membership', async () => {
    denies('POST /api/invites/accept', 'POST /api/invites/decline');
    for (const decision of ['accept', 'decline'] as const) {
      const recipient = await h.signUp('api-recipient-' + decision);
      await send(api.invites.POST, 'POST', {
        params: inTeam(),
        body: { email: recipient.email, role: 'member' },
      });
      const [row] = await h.db.select().from(invite).where(eq(invite.email, recipient.email));
      const body = { token: row!.token };
      expect(
        (await send(api[decision].POST, 'POST', { as: outsider, body })).status,
      ).toBeGreaterThanOrEqual(400);
      expect((await send(api[decision].POST, 'POST', { as: recipient, body })).status).toBe(200);
      if (decision === 'accept') {
        expect(
          await h.db
            .select()
            .from(membership)
            .where(and(eq(membership.workspaceId, team), eq(membership.userId, recipient.id))),
        ).toHaveLength(1);
      }
    }
    expect((await send(api.accept.POST, 'POST', { body: { token: 'invalid' } })).status).toBe(400);
  });
});

describe('joining and calendar REST', () => {
  it('join settings are admin-only, domain comes from verified identity', async () => {
    denies(
      'PUT /api/workspaces/[id]/join-policy',
      'POST /api/workspaces/[id]/domains',
      'DELETE /api/workspaces/[id]/domains',
    );
    for (const actor of [member, outsider]) {
      expect(
        (
          await send(api.policy.PUT, 'PUT', {
            as: actor,
            params: inTeam(),
            body: { policy: 'request' },
          })
        ).status,
      ).toBeGreaterThanOrEqual(400);
      expect(
        (await send(api.domains.POST, 'POST', { as: actor, params: inTeam() })).status,
      ).toBeGreaterThanOrEqual(400);
      expect(
        (
          await send(api.domains.DELETE, 'DELETE', {
            as: actor,
            params: inTeam(),
            body: { domain: 'example.test' },
          })
        ).status,
      ).toBeGreaterThanOrEqual(400);
    }
    expect((await send(api.domains.POST, 'POST', { params: inTeam() })).status).toBe(200);
    expect(
      (await send(api.policy.PUT, 'PUT', { params: inTeam(), body: { policy: 'request' } })).status,
    ).toBe(200);
    expect(
      (
        await send(api.domains.DELETE, 'DELETE', {
          params: inTeam(),
          body: { domain: 'example.test' },
        })
      ).status,
    ).toBe(200);
    expect((await send(api.domains.POST, 'POST', { params: inTeam() })).status).toBe(200);
  });
  it('request/list/approve/decline and auto-join enforce policy and scoped identifiers', async () => {
    denies(
      'POST /api/workspaces/[id]/join',
      'POST /api/workspaces/[id]/request-access',
      'GET /api/workspaces/[id]/join-requests',
      'POST /api/workspaces/[id]/join-requests/[requestId]/approve',
      'POST /api/workspaces/[id]/join-requests/[requestId]/decline',
    );
    const requester = await h.signUp('rest-requester');
    const wrongDomain = await h.signUp('wrong-domain', 'different.test');
    const joinable = await send(api.joinable.GET, 'GET', { as: requester });
    expect(joinable.body.workspaces).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: team, option: 'request' })]),
    );
    const hidden = await send(api.joinable.GET, 'GET', { as: wrongDomain });
    expect(hidden.body.workspaces).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: team })]),
    );
    expect(
      (await send(api.join.POST, 'POST', { as: requester, params: inTeam() })).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await send(api.request.POST, 'POST', { as: wrongDomain, params: inTeam() })).status,
    ).toBeGreaterThanOrEqual(400);
    expect((await send(api.requests.GET, 'GET', { params: inTeam() })).body).toEqual([]);
    expect((await send(api.request.POST, 'POST', { as: requester, params: inTeam() })).status).toBe(
      200,
    );
    const [row] = await h.db.select().from(joinRequest).where(eq(joinRequest.userId, requester.id));
    const params = inTeam({ requestId: row!.id });
    for (const actor of [member, outsider]) {
      expect(
        (await send(api.requests.GET, 'GET', { as: actor, params: inTeam() })).status,
      ).toBeGreaterThanOrEqual(400);
      expect(
        (await send(api.approve.POST, 'POST', { as: actor, params, body: { role: 'viewer' } }))
          .status,
      ).toBeGreaterThanOrEqual(400);
      expect(
        (await send(api.reject.POST, 'POST', { as: actor, params })).status,
      ).toBeGreaterThanOrEqual(400);
    }
    const foreign = await h.teamWorkspace(owner, []);
    expect(
      (
        await send(api.approve.POST, 'POST', {
          params: { id: foreign, requestId: row!.id },
          body: { role: 'viewer' },
        })
      ).status,
    ).toBe(404);
    expect(
      (await send(api.approve.POST, 'POST', { params, body: { role: 'viewer' } })).status,
    ).toBe(200);
    expect((await send(api.reject.POST, 'POST', { params })).status).toBe(400);
    const second = await h.signUp('rest-declined');
    await send(api.request.POST, 'POST', { as: second, params: inTeam() });
    const [pending] = await h.db
      .select()
      .from(joinRequest)
      .where(eq(joinRequest.userId, second.id));
    expect(
      (await send(api.reject.POST, 'POST', { params: inTeam({ requestId: pending!.id }) })).status,
    ).toBe(200);
    await send(api.policy.PUT, 'PUT', { params: inTeam(), body: { policy: 'auto_join' } });
    const auto = await h.signUp('rest-auto');
    expect((await send(api.join.POST, 'POST', { as: auto, params: inTeam() })).status).toBe(200);
    expect(
      (await send(api.join.POST, 'POST', { as: wrongDomain, params: inTeam() })).status,
    ).toBeGreaterThanOrEqual(400);
  });
  it('calendar status is sanitized and disconnect uses authenticated user; errors are JSON', async () => {
    expect(await findGoogleCalendarConnection(h.db, owner.id)).toBeNull();
    expect((await send(api.calendar.GET, 'GET')).body).toEqual({
      connected: false,
      email: null,
      hasCalendarScope: false,
      connectedAt: null,
    });
    const connectedAt = new Date('2026-11-21T00:00:00Z');
    await h.db.insert(account).values({
      accountId: 'rest-calendar-account',
      providerId: 'google-calendar',
      userId: owner.id,
      scope: 'https://www.googleapis.com/auth/calendar.readonly',
      createdAt: connectedAt,
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
    });
    expect((await send(api.calendar.GET, 'GET')).body).toEqual({
      connected: true,
      email: null,
      hasCalendarScope: true,
      connectedAt: connectedAt.toISOString(),
    });
    expect((await send(api.calendar.GET, 'GET', { as: outsider })).body.connected).toBe(false);
    expect((await send(api.calendar.DELETE, 'DELETE')).status).toBe(200);
    expect(disconnect).toHaveBeenLastCalledWith(owner.id);
    disconnect.mockRejectedValueOnce(new Error('offline'));
    const failed = await send(api.calendar.DELETE, 'DELETE');
    expect(failed.body.error.message).toBe('Couldn’t disconnect Google Calendar. Try again.');
  });
});
