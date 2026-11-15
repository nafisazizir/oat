/** Third-party integrations (SPEC §6). */
import { index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth.ts';
import { id, timestamps } from './columns.ts';
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
    settingsJson: jsonb('settings_json').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('integration_workspace_user_provider_uq').on(t.workspaceId, t.userId, t.provider),
    index('integration_user_id_idx').on(t.userId),
  ],
);
