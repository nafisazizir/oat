/** Third-party integrations (SPEC §6) and where documents were exported to (8.1). */
import { index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth.ts';
import { id, timestamps, timestamptz } from './columns.ts';
import { document } from './documents.ts';
import { integrationProviderEnum } from './enums.ts';
import { workspace } from './workspace.ts';

export const integration = pgTable(
  'integration',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    provider: integrationProviderEnum('provider').notNull(),
    /** Reference to where the secret lives (e.g. an encrypted secrets row / KMS key id), never the secret. */
    credentialsRef: text('credentials_ref'),
    /**
     * The provider credential (e.g. Notion's OAuth access token), encrypted with the auth secret
     * (`@oat/auth` `encryptSecret`: XChaCha20-Poly1305, versioned with `BETTER_AUTH_SECRETS`). Never plaintext;
     * never sent to a client. Not a synced table.
     */
    secretEncrypted: text('secret_encrypted'),
    settingsJson: jsonb('settings_json').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('integration_workspace_user_provider_uq').on(t.workspaceId, t.userId, t.provider),
    index('integration_user_id_idx').on(t.userId),
  ],
);

/**
 * A document pushed to an external tool through one integration (8.1: the Notion page a note was sent to),
 * so the next push updates that page instead of creating another. One row per (document, integration): team
 * members each send through their own connection. `lease_until` keeps two pushes of the same pair from
 * running at once (`lease_id` fences a push that outlived its lease). Server-only (not synced).
 */
export const documentExport = pgTable(
  'document_export',
  {
    id: id(),
    documentId: text('document_id')
      .notNull()
      .references(() => document.id, { onDelete: 'cascade' }),
    integrationId: text('integration_id')
      .notNull()
      .references(() => integration.id, { onDelete: 'cascade' }),
    /** The external object (Notion page id); null until the first push created it. */
    externalId: text('external_id'),
    externalUrl: text('external_url'),
    /**
     * Top-level block ids Oat wrote on the external page (Notion). A re-push archives only these, never
     * blocks the user added there (sub-pages, databases, their own notes). `null` = unknown (none written yet).
     */
    blockIds: jsonb('block_ids').$type<string[]>(),
    /** `document.version` that was last pushed (to tell "changed since"). */
    pushedVersion: integer('pushed_version'),
    pushedAt: timestamptz('pushed_at'),
    /** A push in progress holds the row until then (renewed as it goes). */
    leaseUntil: timestamptz('lease_until'),
    /** Random id of the push holding the lease: writes and the release are fenced on it. */
    leaseId: text('lease_id'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('document_export_document_integration_uq').on(t.documentId, t.integrationId),
    index('document_export_integration_id_idx').on(t.integrationId),
  ],
);
