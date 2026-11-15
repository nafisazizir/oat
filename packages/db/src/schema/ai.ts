/** Templates, enhancements (D-20), retrieval chunks and assistant chat (SPEC §6). */
import { EMBEDDING_DIMENSIONS, type TemplateSection } from '@oat/core';
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, vector } from 'drizzle-orm/pg-core';
import { user } from './auth.ts';
import { createdAt, id, timestamps, timestamptz } from './columns.ts';
import { document } from './documents.ts';
import {
  chatMessageRoleEnum,
  chatScopeEnum,
  chunkSourceEnum,
  enhancementStatusEnum,
} from './enums.ts';
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

/** Why a snapshot was taken: the body was about to be replaced by a regenerate or a restore/undo/redo. */
export const SNAPSHOT_REASONS = ['regenerate', 'restore'] as const;
export type SnapshotReason = (typeof SNAPSHOT_REASONS)[number];

/**
 * A note body that was about to be replaced by an enhancement or a restore (4.5, "never lose text"): kept only
 * when it matched no stored output, input notes or earlier snapshot of the note, i.e. the user's own edits.
 * Immutable; listed in Note history and restorable like a version. Server-only (not synced).
 */
export const documentSnapshot = pgTable(
  'document_snapshot',
  {
    id: id(),
    documentId: text('document_id')
      .notNull()
      .references(() => document.id, { onDelete: 'cascade' }),
    contentJson: jsonb('content_json').notNull(),
    /** The note version this body had. */
    documentVersion: integer('document_version').notNull(),
    reason: text('reason').$type<SnapshotReason>().notNull(),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('document_snapshot_document_created_idx').on(t.documentId, t.createdAt.desc()),
    check('document_snapshot_reason_ck', sql`${t.reason} in ('regenerate', 'restore')`),
  ],
);

/**
 * A retrieval chunk of a document (notes and/or transcript) with its embedding. Written only by the indexer
 * (`@oat/indexing`, 6.1): derived data, never synced, rebuilt by `index:backfill`. Readers join `document` for
 * permissions at query time, so visibility/trash changes never require re-indexing.
 */
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
    /** `notes`: cut from the document body; `transcript`: a window of the meeting's transcript segments. */
    source: chunkSourceEnum('source').notNull().default('notes'),
    /** Position within (document, source), from 0. */
    ordinal: integer('ordinal').notNull().default(0),
    /**
     * What the chunk cites, in document order: TipTap block ids (`notes`) or `transcript_segment` ids
     * (`transcript`). The first/last entries are the range.
     */
    refIds: text('ref_ids')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /**
     * SPEC `segment_range?`: the transcript time range this chunk covers (recording-clock ms), both null for
     * chunks of the notes body.
     */
    segmentStartMs: integer('segment_start_ms'),
    segmentEndMs: integer('segment_end_ms'),
    text: text('text').notNull(),
    /**
     * sha256 of (embedding model id, text). An unchanged hash keeps its embedding on re-index; `''` (rows from
     * before 6.1) never matches, so those get re-embedded.
     */
    contentHash: text('content_hash').notNull().default(''),
    /** Estimated tokens of `text` (≈ chars / 4), for context budgeting. */
    tokenCount: integer('token_count').notNull().default(0),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('chunk_document_source_ordinal_idx').on(t.documentId, t.source, t.ordinal),
    index('chunk_workspace_id_idx').on(t.workspaceId),
    // Segment deletes find the chunks that cite them (the change log only carries the segment id).
    index('chunk_ref_ids_gin_idx').using('gin', t.refIds),
    // Approximate nearest neighbour by cosine distance (`<=>`).
    index('chunk_embedding_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    check(
      'chunk_segment_range_ck',
      sql`(${t.segmentStartMs} is null) = (${t.segmentEndMs} is null) and (${t.segmentStartMs} is null or ${t.segmentEndMs} >= ${t.segmentStartMs})`,
    ),
    check(
      'chunk_source_range_ck',
      sql`(${t.source} = 'transcript') = (${t.segmentStartMs} is not null)`,
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
