import {
  canCreateInWorkspace,
  canDeleteDocument,
  canDeleteWorkspace,
  canEditDocument,
  canManageMembers,
  canReadDocument,
  canShareDocument,
  createPermissionContext,
  type DocumentAccess,
  type Role,
  ROLES,
} from '@oat/core';
import { describe, expect, it } from 'vitest';

import { roles, statements } from './access.ts';

/**
 * Better Auth's role statements must agree with `@oat/core` for a workspace, so the two can't drift.
 * Documents here are workspace-visible and owned by someone else (the per-role case). The actor also
 * belongs to a second workspace: "never your last workspace" (D-36) depends on how many they have, which a
 * role statement can't say — `members.ts` enforces it.
 */
const team = { id: 'ws-team' };
const someoneElsesDoc: DocumentAccess = {
  workspaceId: team.id,
  ownerId: 'other-user',
  visibility: 'workspace',
  shareToken: null,
  deletedAt: null,
};

function ctxFor(role: Role) {
  return createPermissionContext({
    userId: 'actor',
    memberships: [
      { workspaceId: team.id, userId: 'actor', role },
      { workspaceId: 'ws-elsewhere', userId: 'actor', role: 'viewer' },
    ],
  });
}

function allows(role: Role, resource: keyof typeof statements, action: string): boolean {
  const r = roles[role];
  return r.authorize({ [resource]: [action] } as Parameters<typeof r.authorize>[0]).success;
}

describe('access control mirrors @oat/core', () => {
  it('defines exactly the core roles', () => {
    expect(Object.keys(roles).sort()).toEqual([...ROLES].sort());
  });

  it.each(ROLES)('%s', (role) => {
    const ctx = ctxFor(role);
    expect(allows(role, 'document', 'create')).toBe(canCreateInWorkspace(ctx, team));
    expect(allows(role, 'document', 'read')).toBe(canReadDocument(ctx, someoneElsesDoc));
    expect(allows(role, 'document', 'update')).toBe(canEditDocument(ctx, someoneElsesDoc));
    expect(allows(role, 'document', 'delete')).toBe(canDeleteDocument(ctx, someoneElsesDoc));
    expect(allows(role, 'document', 'share')).toBe(canShareDocument(ctx, someoneElsesDoc));
    for (const action of statements.member) {
      expect(allows(role, 'member', action), `member:${action}`).toBe(canManageMembers(ctx, team));
    }
    for (const action of statements.invitation) {
      expect(allows(role, 'invitation', action), `invitation:${action}`).toBe(
        canManageMembers(ctx, team),
      );
    }
    expect(allows(role, 'organization', 'delete')).toBe(canDeleteWorkspace(ctx, team));
    // Renaming the workspace: owner/admin.
    expect(allows(role, 'organization', 'update')).toBe(role === 'owner' || role === 'admin');
  });
});
