/**
 * Better Auth core tables (D-9; wired in task 1.6). Table names and JS property names follow Better Auth's
 * Drizzle shape (`user`, `session`, `account`, `verification`; camelCase fields), columns are snake_case.
 * The organization plugin is mapped onto `workspace` / `membership` / `invite` (see `workspace.ts` and
 * `auth-mapping.ts`).
 */
import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { id, timestamps, timestamptz } from './columns.ts';

export const user = pgTable(
  'user',
  {
    id: id(),
    /** Nullable per `@oat/core` (magic-link sign-ups may have no name). Better Auth writes '' or a name. */
    name: text('name'),
    /**
     * Better Auth lower-cases emails before writing (sign-up, internal adapter, magic link); the
     * `lower(email)` unique index also stops case-variant duplicates from any other writer.
     */
    email: text('email').notNull().unique(),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    ...timestamps(),
  },
  (t) => [uniqueIndex('user_email_lower_uq').on(sql`lower(${t.email})`)],
);

export const session = pgTable(
  'session',
  {
    id: id(),
    token: text('token').notNull().unique(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    expiresAt: timestamptz('expires_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    /**
     * Organization plugin's `activeOrganizationId`. No FK on purpose: sessions are short-lived, Better Auth
     * validates membership on use, and a FK would make `auth` ↔ `workspace` a cyclic dependency.
     */
    activeWorkspaceId: text('active_workspace_id'),
    ...timestamps(),
  },
  (t) => [index('session_user_id_idx').on(t.userId)],
);

export const account = pgTable(
  'account',
  {
    id: id(),
    /** Provider's account id (e.g. Google `sub`). */
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamptz('access_token_expires_at'),
    refreshTokenExpiresAt: timestamptz('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    ...timestamps(),
  },
  (t) => [
    index('account_user_id_idx').on(t.userId),
    uniqueIndex('account_provider_account_uq').on(t.providerId, t.accountId),
  ],
);

export const verification = pgTable(
  'verification',
  {
    id: id(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    ...timestamps(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);
