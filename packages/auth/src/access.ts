/**
 * Better Auth access control for workspace roles (organization plugin). Mirrors the role rules in
 * `@oat/core` permissions, which stay the source of truth: `access.test.ts` checks every statement here
 * against the core functions for a team workspace. These statements are coarse (per role, not per
 * document); routes must still call `@oat/core` (`assertCan`) with the real resource.
 *
 * Imported by both the server config and the browser client, so it only depends on
 * `better-auth/plugins/access`.
 */
import { createAccessControl } from 'better-auth/plugins/access';

export const statements = {
  /** Workspace settings. `delete` is also disabled outright (D-22). */
  organization: ['update', 'delete'],
  /** Adding, re-roling and removing members. */
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  /** Documents of the workspace that are not private to someone else (core decides per document). */
  document: ['create', 'read', 'update', 'delete', 'share'],
} as const;

export const ac = createAccessControl(statements);

export const roles = {
  owner: ac.newRole({
    organization: ['update', 'delete'],
    member: ['create', 'update', 'delete'],
    invitation: ['create', 'cancel'],
    document: ['create', 'read', 'update', 'delete', 'share'],
  }),
  admin: ac.newRole({
    organization: ['update'],
    member: ['create', 'update', 'delete'],
    invitation: ['create', 'cancel'],
    document: ['create', 'read', 'update', 'delete', 'share'],
  }),
  member: ac.newRole({
    document: ['create', 'read', 'update'],
  }),
  viewer: ac.newRole({
    document: ['read'],
  }),
};

export type WorkspaceRoleName = keyof typeof roles;
