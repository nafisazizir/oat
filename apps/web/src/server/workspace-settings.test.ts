import { createPermissionContext, type Role } from '@oat/core';
import { describe, expect, it } from 'vitest';

import { buildWorkspaceSettings, type WorkspaceSettings } from './workspace-settings';

const ws: WorkspaceSettings['workspace'] = {
  id: 'w1',
  name: 'Acme',
  slug: 'acme-1',
  kind: 'team',
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

function settingsFor(userId: string, list = members, workspace = ws) {
  const ctx = createPermissionContext({
    userId,
    memberships: list.map((m) => ({ workspaceId: workspace.id, userId: m.userId, role: m.role })),
  });
  return buildWorkspaceSettings({ userId, ctx, workspace, members: list, invites });
}

const byId = (s: ReturnType<typeof settingsFor>, id: string) =>
  s.members.find((m) => m.userId === id)!;

describe('buildWorkspaceSettings (what each role sees, from @oat/core)', () => {
  it('owner: manages everyone, invites any role, deletes; the only owner cannot leave', () => {
    const s = settingsFor('own');
    expect(s).toMatchObject({ role: 'owner', canManage: true, canDelete: true, canLeave: false });
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

  it('personal workspace: nothing to manage', () => {
    const personal = { ...ws, kind: 'personal' as const };
    const s = settingsFor('own', [member('own', 'owner')], personal);
    expect(s).toMatchObject({
      canManage: false,
      canDelete: false,
      canLeave: false,
      inviteRoles: [],
    });
  });

  it('refuses a non-member', () => {
    expect(() => settingsFor('stranger')).toThrow(/not a member/);
  });
});
