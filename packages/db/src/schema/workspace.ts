/**
 * Workspaces, membership and invites (SPEC §6). These are Better Auth organization-plugin tables under our
 * names: organization → `workspace`, member → `membership`, invitation → `invite` (mapping in
 * `auth-mapping.ts`). Columns Better Auth needs but SPEC doesn't (`slug`, `logo`, `metadata`, `status`,
 * `inviterId`, membership `id`) are kept; columns we add on top have defaults so Better Auth inserts work.
 */
import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { newToken } from '../id.ts';
import { user } from './auth.ts';
import { id, timestamps, timestamptz } from './columns.ts';
import { inviteStatusEnum, roleEnum, workspaceKindEnum } from './enums.ts';

export const workspace = pgTable(
  'workspace',
  {
    id: id(),
    name: text('name').notNull(),
    /** Better Auth organization slug; unique. Personal workspaces use `personal-<userId>`. */
    slug: text('slug').notNull().unique(),
    logo: text('logo'),
    /** Better Auth organization metadata (JSON-encoded string). */
    metadata: text('metadata'),
    kind: workspaceKindEnum('kind').notNull().default('team'),
    /**
     * Creator. `restrict`: deleting a user must first delete their personal workspace and hand over or delete
     * team workspaces they created (account deletion flow, later task).
     */
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    ...timestamps(),
  },
  // FK lookups when deleting a user.
  (t) => [index('workspace_created_by_idx').on(t.createdBy)],
);

export const membership = pgTable(
  'membership',
  {
    /** Better Auth's member table needs its own id. */
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** One role per member (Better Auth's comma-separated multi-role strings are rejected by the enum). */
    role: roleEnum('role').notNull().default('member'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('membership_workspace_user_uq').on(t.workspaceId, t.userId),
    // "Which workspaces am I in?" — the sidebar / permission context hot path.
    index('membership_user_id_idx').on(t.userId),
  ],
);

export const invite = pgTable(
  'invite',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: roleEnum('role').notNull().default('member'),
    status: inviteStatusEnum('status').notNull().default('pending'),
    /** Secret for invite links (SPEC §6). Generated when not supplied, so Better Auth inserts get one too. */
    token: text('token')
      .notNull()
      .unique()
      .$defaultFn(() => newToken()),
    inviterId: text('inviter_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    expiresAt: timestamptz('expires_at').notNull(),
    acceptedAt: timestamptz('accepted_at'),
    ...timestamps(),
  },
  (t) => [
    index('invite_workspace_id_idx').on(t.workspaceId),
    index('invite_email_idx').on(t.email),
    index('invite_inviter_id_idx').on(t.inviterId),
    check('invite_accepted_at_ck', sql`${t.acceptedAt} is null or ${t.status} = 'accepted'`),
  ],
);
