import {
  findGoogleCalendarConnection,
  findInvite,
  findLiveWorkspace,
  getJoinSettings,
  getJoinChoices,
  lastActiveWorkspaceId,
  listJoinRequests,
  listMembers,
  listPendingInvites,
  listUserWorkspaces,
  loadPermissionContext,
  pickActiveWorkspace,
} from '@oat/auth';
import { assertCan } from '@oat/core';
import { joinRequest } from '@oat/db';
import {
  ActiveWorkspaceSchema,
  CreateWorkspaceSchema,
  DeleteWorkspaceSchema,
  InviteMemberSchema,
  InviteTokenSchema,
  JoinPolicyInputSchema,
  MemberRoleSchema,
  RemoveDomainSchema,
  UpdateWorkspaceSchema,
  type CalendarConnectionStatus,
  type WorkspaceList,
  type WorkspaceSettings,
  type JoinChoices,
} from '@oat/services/dto/workspaces';
import { and, eq } from 'drizzle-orm';

import { workspaceIcon } from '@/lib/workspace';

import type { OperationContext } from '../operation-context';
import * as calendar from '../operations/calendar';
import * as joining from '../operations/joining';
import * as members from '../operations/members';
import * as workspaces from '../operations/workspaces';
import { buildWorkspaceSettings } from '../workspace-settings';
import { ApiError, notFound, unauthorized } from './errors';
import { apiRoute, readJson, type ApiDeps } from './route';

export type WorkspaceApiDeps = {
  context(userId: string, headers: Headers): Promise<OperationContext>;
};

function result<T extends { ok: boolean; error?: string; status?: number }>(value: T): T {
  if (!value.ok) {
    const status = value.status ?? 400;
    throw new ApiError(
      status,
      status === 403 ? 'forbidden' : status === 404 ? 'not_found' : 'bad_request',
      value.error!,
    );
  }
  return value;
}

export function createWorkspaceApi(deps: ApiDeps, operations: WorkspaceApiDeps) {
  const route = <P = Record<string, never>>(
    handler: (context: OperationContext, params: P, request: Request) => Promise<unknown>,
  ) =>
    apiRoute<P>(deps, async ({ actor, params, request }) => {
      const context = await operations.context(actor.userId, request.headers);
      if (context.user.id !== actor.userId) throw unauthorized();
      return handler(context, params, request);
    });

  async function settings(context: OperationContext, id: string): Promise<WorkspaceSettings> {
    const { db, user } = context;
    const [row, ctx] = await Promise.all([
      findLiveWorkspace(db, id),
      loadPermissionContext(db, user.id),
    ]);
    if (!row || !ctx.memberships.has(id)) throw notFound('Workspace');
    const manages = ctx.memberships.get(id) === 'owner' || ctx.memberships.get(id) === 'admin';
    const [people, invites, policy, requests] = await Promise.all([
      listMembers(db, id),
      manages ? listPendingInvites(db, id) : [],
      manages ? getJoinSettings(db, id) : undefined,
      manages ? listJoinRequests(db, id) : [],
    ]);
    return buildWorkspaceSettings({
      userId: user.id,
      ctx,
      workspace: { id: row.id, name: row.name, slug: row.slug, icon: workspaceIcon(row.logo) },
      members: people,
      invites,
      viewer: user,
      joining: policy,
      joinRequests: requests,
    });
  }
  async function manage(context: OperationContext, id: string) {
    const ctx = await loadPermissionContext(context.db, context.user.id);
    if (!ctx.memberships.has(id)) throw notFound('Workspace');
    assertCan('manageMembers', ctx, { id });
  }
  async function invitation(context: OperationContext, id: string, inviteId: string) {
    await manage(context, id);
    const invite = await findInvite(context.db, inviteId);
    if (!invite || invite.workspaceId !== id) throw notFound('Invitation');
  }
  async function requestIn(context: OperationContext, id: string, requestId: string) {
    await manage(context, id);
    const [row] = await context.db
      .select({ id: joinRequest.id })
      .from(joinRequest)
      .where(and(eq(joinRequest.id, requestId), eq(joinRequest.workspaceId, id)));
    if (!row) throw notFound('Request');
  }
  return {
    joinable: { GET: route(async (c): Promise<JoinChoices> => getJoinChoices(c.db, c.user.id)) },
    workspaces: {
      GET: route(async (c): Promise<WorkspaceList> => {
        const rows = await listUserWorkspaces(c.db, c.user.id);
        const session = await c.auth.api.getSession({ headers: c.headers });
        const active = pickActiveWorkspace(
          rows,
          session?.session.activeOrganizationId,
          await lastActiveWorkspaceId(c.db, c.user.id),
        );
        return {
          workspaces: rows.map(({ logo, joinedAt, ...row }) => ({
            ...row,
            icon: workspaceIcon(logo),
            joinedAt: joinedAt.toISOString(),
          })),
          activeWorkspaceId: active?.id ?? null,
        };
      }),
      POST: route(async (c, _, req) =>
        result(
          await workspaces.createWorkspace(c, (await readJson(req, CreateWorkspaceSchema)).name),
        ),
      ),
    },
    active: {
      PUT: route(async (c, _, req) =>
        result(
          await workspaces.switchWorkspace(
            c,
            (await readJson(req, ActiveWorkspaceSchema)).workspaceId,
          ),
        ),
      ),
    },
    workspace: {
      GET: route<{ id: string }>((c, p) => settings(c, p.id)),
      PATCH: route<{ id: string }>(async (c, p, req) =>
        result(
          await members.updateWorkspace(c, {
            ...(await readJson(req, UpdateWorkspaceSchema)),
            workspaceId: p.id,
          }),
        ),
      ),
      DELETE: route<{ id: string }>(async (c, p, req) =>
        result(
          await members.deleteWorkspace(c, {
            ...(await readJson(req, DeleteWorkspaceSchema)),
            workspaceId: p.id,
          }),
        ),
      ),
    },
    leave: {
      POST: route<{ id: string }>(async (c, p) => result(await members.leaveWorkspace(c, p.id))),
    },
    members: { GET: route<{ id: string }>(async (c, p) => (await settings(c, p.id)).members) },
    member: {
      PATCH: route<{ id: string; memberId: string }>(async (c, p, req) =>
        result(
          await members.changeRole(c, {
            ...(await readJson(req, MemberRoleSchema)),
            workspaceId: p.id,
            userId: p.memberId,
          }),
        ),
      ),
      DELETE: route<{ id: string; memberId: string }>(async (c, p) =>
        result(await members.removeMember(c, { workspaceId: p.id, userId: p.memberId })),
      ),
    },
    invites: {
      GET: route<{ id: string }>(async (c, p) => {
        await manage(c, p.id);
        return (await settings(c, p.id)).invites;
      }),
      POST: route<{ id: string }>(async (c, p, req) =>
        result(
          await members.inviteMember(c, {
            ...(await readJson(req, InviteMemberSchema)),
            workspaceId: p.id,
          }),
        ),
      ),
    },
    resend: {
      POST: route<{ id: string; inviteId: string }>(async (c, p) => {
        await invitation(c, p.id, p.inviteId);
        return result(await members.resendInvite(c, p.inviteId));
      }),
    },
    invite: {
      DELETE: route<{ id: string; inviteId: string }>(async (c, p) => {
        await invitation(c, p.id, p.inviteId);
        return result(await members.revokeInvite(c, p.inviteId));
      }),
    },
    accept: {
      POST: route(async (c, _, req) =>
        result(await members.acceptInvite(c, (await readJson(req, InviteTokenSchema)).token)),
      ),
    },
    decline: {
      POST: route(async (c, _, req) =>
        result(await members.declineInvite(c, (await readJson(req, InviteTokenSchema)).token)),
      ),
    },
    policy: {
      PUT: route<{ id: string }>(async (c, p, req) =>
        result(
          await joining.setJoinPolicy(c, {
            ...(await readJson(req, JoinPolicyInputSchema)),
            workspaceId: p.id,
          }),
        ),
      ),
    },
    domains: {
      POST: route<{ id: string }>(async (c, p) => result(await joining.allowMyDomain(c, p.id))),
      DELETE: route<{ id: string }>(async (c, p, req) =>
        result(
          await joining.removeAllowedDomain(c, {
            ...(await readJson(req, RemoveDomainSchema)),
            workspaceId: p.id,
          }),
        ),
      ),
    },
    requests: {
      GET: route<{ id: string }>(async (c, p) => {
        await manage(c, p.id);
        return (await settings(c, p.id)).joinRequests;
      }),
    },
    approve: {
      POST: route<{ id: string; requestId: string }>(async (c, p, req) => {
        await requestIn(c, p.id, p.requestId);
        return result(
          await joining.approveJoinRequest(c, {
            ...(await readJson(req, MemberRoleSchema)),
            requestId: p.requestId,
          }),
        );
      }),
    },
    reject: {
      POST: route<{ id: string; requestId: string }>(async (c, p) => {
        await requestIn(c, p.id, p.requestId);
        return result(await joining.declineJoinRequest(c, p.requestId));
      }),
    },
    join: {
      POST: route<{ id: string }>(async (c, p) => result(await joining.joinWorkspace(c, p.id))),
    },
    request: {
      POST: route<{ id: string }>(async (c, p) => result(await joining.requestAccess(c, p.id))),
    },
    mine: { POST: route(async (c) => result(await joining.createMyWorkspace(c))) },
    calendar: {
      GET: route(async (c): Promise<CalendarConnectionStatus> => {
        const connection = await findGoogleCalendarConnection(c.db, c.user.id);
        return {
          connected: connection !== null,
          email: connection?.email ?? null,
          hasCalendarScope: connection?.hasCalendarScope ?? false,
          connectedAt: connection?.connectedAt.toISOString() ?? null,
        };
      }),
      DELETE: route(async (c) => result(await calendar.disconnectGoogleCalendarAction(c))),
    },
  };
}
