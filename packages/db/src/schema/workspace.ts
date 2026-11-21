/**
 * Workspaces, membership and invites (SPEC §6). These are Better Auth organization-plugin tables under our
 * names: organization → `workspace`, member → `membership`, invitation → `invite` (mapping in
 * `auth-mapping.ts`). Columns Better Auth needs but SPEC doesn't (`slug`, `logo`, `metadata`, `status`,
 * `inviterId`, membership `id`) are kept; columns we add on top have defaults so Better Auth inserts work.
 */
import { sql } from 'drizzle-orm';
import { check, index, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { newToken } from '../id.ts';
import { user } from './auth.ts';
import { createdAt, id, timestamps, timestamptz } from './columns.ts';
import { inviteStatusEnum, joinPolicyEnum, joinRequestStatusEnum, roleEnum } from './enums.ts';

export const workspace = pgTable(
  'workspace',
  {
    id: id(),
    name: text('name').notNull(),
    /** Better Auth organization slug; unique. Generated as `<words-from-name>-<random>`. */
    slug: text('slug').notNull().unique(),
    logo: text('logo'),
    /** Better Auth organization metadata (JSON-encoded string). */
    metadata: text('metadata'),
    /**
     * Creator. `restrict`: deleting a user must first hand over or delete the workspaces they created
     * (account deletion flow, later task).
     */
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    /**
     * Soft delete (D-22: Better Auth's hard delete is disabled). A deleted workspace is hidden everywhere
     * (`@oat/auth` workspace lists and permission contexts skip it) and stays restorable for 30 days;
     * purging is a later job.
     */
    deletedAt: timestamptz('deleted_at'),
    /**
     * How people who weren't invited get in (D-36): never (`invite_only`, the default), by asking
     * (`request`), or straight in as a member (`auto_join`) — the last two only for verified emails on one
     * of the workspace's {@link workspaceDomain}s. Set only by `@oat/auth` joining.ts, never from a Better
     * Auth request body.
     */
    joinPolicy: joinPolicyEnum('join_policy').notNull().default('invite_only'),
    ...timestamps(),
  },
  (t) => [
    // FK lookups when deleting a user.
    index('workspace_created_by_idx').on(t.createdBy),
  ],
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
    // Invitations are looked up by address case-insensitively (the join screen, the app shell).
    index('invite_email_lower_idx').on(sql`lower(${t.email})`),
    index('invite_inviter_id_idx').on(t.inviterId),
    check('invite_accepted_at_ck', sql`${t.acceptedAt} is null or ${t.status} = 'accepted'`),
  ],
);

/**
 * Email domains whose verified addresses may find the workspace (D-36), subject to its `join_policy`.
 * Stored normalised (lower case, `@oat/core` `normalizeDomain`); never a public mailbox domain, and only
 * ever the domain of the owner/admin who added it (`@oat/core` `canAddDomain`). Server-only: not synced.
 */
export const workspaceDomain = pgTable(
  'workspace_domain',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(),
    /** Who listed it (kept for the record; the row outlives their membership). */
    addedBy: text('added_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'workspace_domain_pk', columns: [t.workspaceId, t.domain] }),
    // "Which workspaces list my domain?" — the join screen's lookup.
    index('workspace_domain_domain_idx').on(t.domain),
    check('workspace_domain_normalised_ck', sql`${t.domain} = lower(btrim(${t.domain}))`),
  ],
);

/**
 * Someone asking to join a `request` workspace (D-36). At most one pending request per user per workspace
 * (the partial unique index); a decision records who made it, when, and — when approved — the role
 * granted. Server-only: not synced.
 */
export const joinRequest = pgTable(
  'join_request',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    status: joinRequestStatusEnum('status').notNull().default('pending'),
    /** The owner/admin who approved or declined; null while pending (or if that user is gone). */
    decidedBy: text('decided_by').references(() => user.id, { onDelete: 'set null' }),
    decidedAt: timestamptz('decided_at'),
    /** Role granted on approval. */
    role: roleEnum('role'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('join_request_one_pending_uq')
      .on(t.workspaceId, t.userId)
      .where(sql`${t.status} = 'pending'`),
    // The members page lists a workspace's pending requests; the join screen a user's latest ones.
    index('join_request_workspace_status_idx').on(t.workspaceId, t.status),
    index('join_request_user_id_idx').on(t.userId),
    index('join_request_decided_by_idx').on(t.decidedBy),
    check('join_request_decision_ck', sql`(${t.status} = 'pending') = (${t.decidedAt} is null)`),
    check('join_request_role_ck', sql`${t.role} is null or ${t.status} = 'approved'`),
  ],
);
