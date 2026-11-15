/** Templates, enhancements (D-20), retrieval chunks and assistant chat (SPEC §6). */
import { EMBEDDING_DIMENSIONS, type TemplateSection } from '@oat/core';
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, vector } from 'drizzle-orm/pg-core';
import { user } from './auth.ts';
import { createdAt, id, timestamps, timestamptz } from './columns.ts';
import { document } from './documents.ts';
import { chatMessageRoleEnum, chatScopeEnum, enhancementStatusEnum } from './enums.ts';
import { workspace } from './workspace.ts';

/**
 * Embedding width, shared with `@oat/ai` via `@oat/core`. Changing it needs a migration + re-embed.
 * Re-exported so schema consumers don't need a second import.
 */
export { EMBEDDING_DIMENSIONS };

export const template = pgTable(
  'template',
  {
    id: id(),
    /** `null` = built-in template available in every workspace. */
    workspaceId: text('workspace_id').references(() => workspace.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    instructions: text('instructions').notNull().default(''),
    sectionsJson: jsonb('sections_json').$type<TemplateSection[]>().notNull().default([]),
    isBuiltin: boolean('is_builtin').notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    index('template_workspace_id_idx').on(t.workspaceId),
    check('template_builtin_ck', sql`${t.isBuiltin} = (${t.workspaceId} is null)`),
  ],
);

/**
 * One enhancement run (D-20): a server job with an idempotency key. The user's notes at enhance time
 * (`inputNotesJson`) and every output (`outputJson`) are kept immutably for undo/restore.
 */
export const enhancement = pgTable(
  'enhancement',
  {
    id: id(),
    documentId: text('document_id')
      .notNull()
      .references(() => document.id, { onDelete: 'cascade' }),
    templateId: text('template_id').references(() => template.id, { onDelete: 'set null' }),
    model: text('model').notNull(),
    /** Hash of everything that went into the prompt (notes, transcript, template); detects staleness. */
    inputHash: text('input_hash').notNull(),
    inputNotesJson: jsonb('input_notes_json').notNull(),
    /** `null` until the run completes. */
    outputJson: jsonb('output_json'),
    status: enhancementStatusEnum('status').notNull().default('generating'),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    startedAt: timestamptz('started_at').notNull().defaultNow(),
    completedAt: timestamptz('completed_at'),
    ...timestamps(),
  },
  (t) => [
    index('enhancement_document_created_idx').on(t.documentId, t.createdAt.desc()),
    index('enhancement_template_id_idx').on(t.templateId),
    check(
      'enhancement_completed_ck',
      sql`${t.status} <> 'completed' or (${t.outputJson} is not null and ${t.completedAt} is not null)`,
    ),
  ],
);

/** A retrieval chunk of a document (notes and/or transcript) with its embedding. */
export const chunk = pgTable(
  'chunk',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    documentId: text('document_id')
      .notNull()
      .references(() => document.id, { onDelete: 'cascade' }),
    /**
     * SPEC `segment_range?`: the transcript time range this chunk covers (recording-clock ms), both null for
     * chunks of the notes body.
     */
    segmentStartMs: integer('segment_start_ms'),
    segmentEndMs: integer('segment_end_ms'),
    text: text('text').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('chunk_document_id_idx').on(t.documentId),
    index('chunk_workspace_id_idx').on(t.workspaceId),
    // Approximate nearest neighbour by cosine distance (`<=>`).
    index('chunk_embedding_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    check(
      'chunk_segment_range_ck',
      sql`(${t.segmentStartMs} is null) = (${t.segmentEndMs} is null) and (${t.segmentStartMs} is null or ${t.segmentEndMs} >= ${t.segmentStartMs})`,
    ),
  ],
);

export const chatThread = pgTable(
  'chat_thread',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    scope: chatScopeEnum('scope').notNull(),
    documentId: text('document_id').references(() => document.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    ...timestamps(),
  },
  (t) => [
    index('chat_thread_user_workspace_updated_idx').on(t.userId, t.workspaceId, t.updatedAt.desc()),
    index('chat_thread_document_id_idx').on(t.documentId),
    check('chat_thread_scope_ck', sql`(${t.scope} = 'document') = (${t.documentId} is not null)`),
  ],
);

export const chatMessage = pgTable(
  'chat_message',
  {
    id: id(),
    threadId: text('thread_id')
      .notNull()
      .references(() => chatThread.id, { onDelete: 'cascade' }),
    role: chatMessageRoleEnum('role').notNull(),
    /** Message parts (owned by `@oat/ai`). */
    partsJson: jsonb('parts_json').$type<unknown[]>().notNull(),
    /** What the assistant was given (D-20 `buildMeetingContext()` refs, retrieved chunk ids, …). */
    contextJson: jsonb('context_json'),
    createdAt: createdAt(),
  },
  (t) => [index('chat_message_thread_created_idx').on(t.threadId, t.createdAt)],
);
