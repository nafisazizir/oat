import { createPermissionContext, type Role } from '@oat/core';
import { describe, expect, it } from 'vitest';

import { buildWorkspaceSettings, type WorkspaceSettings } from './workspace-settings';

const ws: WorkspaceSettings['workspace'] = {
  id: 'w1',
  name: 'Acme',
  slug: 'acme-1',
  icon: null,
};
const joinedAt = new Date('2026-11-01T00:00:00Z');
const member = (userId: string, role: Role) => ({
  userId,
  name: userId,
  email: `${userId}@example.test`,
  image: null,
  role,
  joinedAt,
});
const members = [
  member('own', 'owner'),
  member('adm', 'admin'),
  member('mem', 'member'),
  member('vie', 'viewer'),
];
const invites = [
  {
    id: 'i1',
    email: 'new@example.test',
    role: 'admin' as Role,
    state: 'pending' as const,
    expiresAt: new Date('2026-11-21T00:00:00Z'),
    invitedBy: 'own',
    createdAt: joinedAt,
  },
];

/**
 * `only`: this is the viewer's only workspace. By default they also belong to another one, so leaving and
 * deleting depend on their role here alone (D-36: the last workspace can't be left or deleted).
 */
function settingsFor(userId: string, list = members, { only = false } = {}) {
  const workspace = ws;
  const ctx = createPermissionContext({
    userId,
    memberships: [
      ...list.map((m) => ({ workspaceId: workspace.id, userId: m.userId, role: m.role })),
      ...(only ? [] : [{ workspaceId: 'elsewhere', userId, role: 'viewer' as Role }]),
    ],
  });
  return buildWorkspaceSettings({ userId, ctx, workspace, members: list, invites });
}

const byId = (s: ReturnType<typeof settingsFor>, id: string) =>
  s.members.find((m) => m.userId === id)!;

describe('buildWorkspaceSettings (what each role sees, from @oat/core)', () => {
  it('owner: manages everyone, invites any role, deletes; the only owner cannot leave', () => {
    const s = settingsFor('own');
    expect(s).toMatchObject({
      role: 'owner',
      canManage: true,
      canDelete: true,
      canLeave: false,
      lastWorkspace: false,
    });
    expect(s.inviteRoles).toEqual(['owner', 'admin', 'member', 'viewer']);
    expect(byId(s, 'adm')).toMatchObject({
      assignableRoles: ['owner', 'member', 'viewer'],
      canRemove: true,
    });
    // Last owner: can't be demoted (not even by themselves) and isn't removable.
    expect(byId(s, 'own')).toMatchObject({ isYou: true, assignableRoles: [], canRemove: false });
    expect(s.invites).toEqual([
      expect.objectContaining({ id: 'i1', canResend: true, expiresAt: '2026-11-21T00:00:00.000Z' }),
    ]);
  });

  it('admin: members/viewers only, invites up to admin, cannot delete', () => {
    const s = settingsFor('adm');
    expect(s).toMatchObject({ canManage: true, canDelete: false, canLeave: true });
    expect(s.inviteRoles).toEqual(['admin', 'member', 'viewer']);
    expect(byId(s, 'own')).toMatchObject({ assignableRoles: [], canRemove: false });
    expect(byId(s, 'adm')).toMatchObject({ assignableRoles: [], canRemove: false });
    expect(byId(s, 'mem')).toMatchObject({
      assignableRoles: ['admin', 'viewer'],
      canRemove: true,
    });
  });

  it('member and viewer: read-only list, no invites, may leave', () => {
    for (const id of ['mem', 'vie']) {
      const s = settingsFor(id);
      expect(s).toMatchObject({ canManage: false, canDelete: false, canLeave: true, invites: [] });
      expect(s.inviteRoles).toEqual([]);
      expect(s.members.every((m) => m.assignableRoles.length === 0 && !m.canRemove)).toBe(true);
    }
  });

  it('with two owners, an owner may leave or be demoted', () => {
    const list = [...members, member('own2', 'owner')];
    const s = settingsFor('own', list);
    expect(s.canLeave).toBe(true);
    expect(byId(s, 'own2')).toMatchObject({ canRemove: true });
    expect(byId(s, 'own').assignableRoles).toEqual(['admin', 'member', 'viewer']);
  });

  it('a workspace of one is an ordinary workspace: its owner manages it and invites into it', () => {
    const s = settingsFor('own', [member('own', 'owner')]);
    expect(s).toMatchObject({ canManage: true, canDelete: true, canLeave: false });
    expect(s.inviteRoles).toEqual(['owner', 'admin', 'member', 'viewer']);
  });

  it('the last workspace can’t be left or deleted, whatever the role — and the page says why', () => {
    for (const id of ['own', 'adm', 'mem', 'vie']) {
      const s = settingsFor(id, members, { only: true });
      expect(s, id).toMatchObject({ canLeave: false, canDelete: false, lastWorkspace: true });
    }
    // Two owners: still not their last workspace to give up.
    const two = settingsFor('own', [...members, member('own2', 'owner')], { only: true });
    expect(two).toMatchObject({ canLeave: false, canDelete: false, lastWorkspace: true });
    // Everything else about managing it is unchanged.
    expect(settingsFor('own', members, { only: true })).toMatchObject({ canManage: true });
    expect(byId(settingsFor('own', members, { only: true }), 'mem').canRemove).toBe(true);
  });

  it('refuses a non-member', () => {
    expect(() => settingsFor('stranger')).toThrow(/not a member/);
  });
});
