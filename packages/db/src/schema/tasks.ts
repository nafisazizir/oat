/** Action items (8.4): the task items of every document, derived for querying ("My tasks"). */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { user } from './auth.ts';
import { id, timestamps } from './columns.ts';
import { document } from './documents.ts';
import { workspace } from './workspace.ts';

/**
 * One row per `taskItem` block of a document. Derived data, like `chunk`: written only by the indexing worker
 * (`@oat/indexing` `syncActionItems`, following `change_log`, D-22) and by the task toggle API right after it
 * writes the document; never synced, rebuilt by `index:backfill`. The document body stays canonical (D-4):
 * toggling an item writes the document, and this row follows.
 *
 * Readers join `document` for permissions at query time (like `chunk`), so visibility/trash changes never
 * require re-extraction. "Assigned to me" matches `owner_user_id` or, for owners known only by email (an
 * attendee who joined later), `lower(owner_email)`.
 */
export const actionItem = pgTable(
  'action_item',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    documentId: text('document_id')
      .notNull()
      .references(() => document.id, { onDelete: 'cascade' }),
    /** The `taskItem`'s TipTap block id (links jump to it: `/d/<doc>?block=<id>`). */
    blockId: text('block_id').notNull(),
    /** Position among the document's task items, from 0. */
    ordinal: integer('ordinal').notNull().default(0),
    /** The item's own line as plain text (mentions as `@Name`), at most 2000 characters. */
    text: text('text').notNull(),
    /** Owner resolved to a member of the document's workspace, when the owner is one. */
    ownerUserId: text('owner_user_id').references(() => user.id, { onDelete: 'set null' }),
    ownerName: text('owner_name'),
    ownerEmail: text('owner_email'),
    /** Calendar day, no time zone (`YYYY-MM-DD`). */
    due: date('due', { mode: 'string' }),
    done: boolean('done').notNull().default(false),
    /** The document version the row was extracted from. */
    documentVersion: integer('document_version').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('action_item_document_block_uq').on(t.documentId, t.blockId),
    index('action_item_workspace_done_due_idx').on(t.workspaceId, t.done, t.due),
    index('action_item_owner_user_idx').on(t.ownerUserId, t.done),
    index('action_item_owner_email_idx').on(sql`lower(${t.ownerEmail})`),
    check('action_item_text_len_ck', sql`char_length(${t.text}) <= 2000`),
  ],
);
