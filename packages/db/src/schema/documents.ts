/** Folders and documents (SPEC §6, folder rules D-18, sync versioning D-19). */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
} from 'drizzle-orm/pg-core';
import { user } from './auth.ts';
import { id, timestamps, timestamptz } from './columns.ts';
import { documentKindEnum, documentVisibilityEnum, folderVisibilityEnum } from './enums.ts';
import { workspace } from './workspace.ts';

/** An empty TipTap document; the canonical body of a new document. */
export const EMPTY_DOC = { type: 'doc', content: [] } as const;

/**
 * D-18 (enforced in `@oat/core` permissions, not here): a private folder belongs to its owner and only the
 * owner adds children; no cross-workspace moves. The schema guarantees the tree stays in one workspace only
 * through application code (a composite FK would need `(workspace_id, id)` uniqueness everywhere).
 */
export const folder = pgTable(
  'folder',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    /** Deleting a folder deletes its subfolders; their documents fall back to the workspace root. */
    parentId: text('parent_id').references((): AnyPgColumn => folder.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    visibility: folderVisibilityEnum('visibility').notNull(),
    /** `restrict`: content must be reassigned or deleted before its owner's account is removed. */
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    ...timestamps(),
  },
  (t) => [
    index('folder_workspace_parent_idx').on(t.workspaceId, t.parentId),
    index('folder_owner_id_idx').on(t.ownerId),
    check('folder_not_own_parent_ck', sql`${t.parentId} is null or ${t.parentId} <> ${t.id}`),
  ],
);

/**
 * Also has a generated `search_tsv` column (+ GIN and title trigram indexes) from migration `0006_search`,
 * deliberately left out of this schema so selects never fetch it (queries: `src/search.ts`).
 */
export const document = pgTable(
  'document',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    folderId: text('folder_id').references(() => folder.id, { onDelete: 'set null' }),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    kind: documentKindEnum('kind').notNull(),
    title: text('title').notNull().default(''),
    /** TipTap JSON — canonical (shape owned by `@oat/editor`). */
    contentJson: jsonb('content_json').notNull().default(EMPTY_DOC),
    /** Markdown derived from `contentJson`. */
    contentMd: text('content_md').notNull().default(''),
    visibility: documentVisibilityEnum('visibility').notNull().default('private'),
    /** Secret for `link` visibility; rotated whenever the document enters `link` (D-18). */
    shareToken: text('share_token').unique(),
    /**
     * Whether people opening the share link also see the meeting transcript (5.3). Off by default: the
     * transcript stays private unless the sharer opts in. Only meaningful for `link` visibility.
     */
    shareTranscript: boolean('share_transcript').notNull().default(false),
    /**
     * Monotonic version for sync (D-19): every accepted write bumps it; a push carrying a stale base version
     * is rejected with 409.
     */
    version: integer('version').notNull().default(0),
    ...timestamps(),
    /** Soft delete: non-null = in trash. */
    deletedAt: timestamptz('deleted_at'),
  },
  (t) => [
    // Sidebar / "recent" lists: documents of a workspace (or folder) newest first.
    index('document_workspace_updated_idx').on(t.workspaceId, t.updatedAt.desc()),
    index('document_folder_updated_idx').on(t.folderId, t.updatedAt.desc()),
    index('document_owner_id_idx').on(t.ownerId),
    check('document_version_ck', sql`${t.version} >= 0`),
    check('document_link_token_ck', sql`${t.visibility} <> 'link' or ${t.shareToken} is not null`),
    check(
      'document_share_token_ck',
      sql`${t.shareToken} is null or ${t.shareToken} ~ '^[A-Za-z0-9_-]{22,}$'`,
    ),
  ],
);
