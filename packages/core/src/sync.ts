/**
 * Desktop ⇄ server sync protocol (D-19, task 2.6): the wire shapes of `POST /api/sync/push` and
 * `GET /api/sync/pull`, shared by apps/web (validates) and `@oat/local-store` (produces/consumes).
 *
 * - Rows travel in camelCase with ISO-8601 timestamps. Segment rows are always finals (D-19: only finals
 *   sync); an empty-text final is a retraction and travels as a `delete`.
 * - Push: outbox entries in the client's outbox `version` order, each acknowledged by that version
 *   (`ok` / `conflict` / `rejected`), so a late ack never clears an entry for a newer edit of the same row.
 *   Documents carry the `baseVersion` they were edited on; a stale one is a per-row `conflict` with the
 *   server copy (the client keeps the server copy and files its own as a conflicted copy).
 * - Pull: opaque cursor over the server change log (D-22), current rows (or deletes) of what changed, only
 *   for rows the user can read; `workspaceIds` lets the client drop workspaces it lost and re-fetch from
 *   the start when it joined one.
 */
import { z } from 'zod';

import {
  DocumentKindSchema,
  DocumentVisibilitySchema,
  ParticipantSourceSchema,
  TranscriptSourceSchema,
  WorkspaceKindSchema,
} from './types.ts';

/** Tables a client may push, in the order the server applies them (parents first). */
export const SYNC_PUSH_TABLES = [
  'document',
  'meeting',
  'participant',
  'transcript_segment',
] as const;
export type SyncPushTable = (typeof SYNC_PUSH_TABLES)[number];

/** Tables a pull returns today (3.5 adds folders, templates, …: clients then re-pull from the start). */
export const SYNC_PULL_TABLES = ['workspace', ...SYNC_PUSH_TABLES] as const;
export type SyncPullTable = (typeof SYNC_PULL_TABLES)[number];

/** Bumped whenever {@link SYNC_PULL_TABLES} grows: a client with an older scope restarts its cursor. */
export const SYNC_PULL_SCOPE = 1;

/** Most entries in one push; most changes in one pull page. */
export const MAX_PUSH_ENTRIES = 500;
export const MAX_PULL_LIMIT = 500;

const Id = z.string().min(1).max(100);
const Iso = z.iso.datetime({ offset: true });
const Title = z.string().max(1000);
/** TipTap JSON; the server checks the shape against the editor schema. */
const Content = z.looseObject({ type: z.literal('doc') });

// ---------------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------------

export const syncWorkspaceRowSchema = z.object({
  id: Id,
  name: z.string(),
  kind: WorkspaceKindSchema,
});
export type SyncWorkspaceRow = z.infer<typeof syncWorkspaceRowSchema>;

/** What a client may write on a document: create it (root, private) or change title/content. */
export const syncDocumentPushSchema = z.strictObject({
  id: Id,
  workspaceId: Id,
  kind: DocumentKindSchema,
  title: Title,
  contentJson: Content,
});
export type SyncDocumentPush = z.infer<typeof syncDocumentPushSchema>;

export const syncDocumentRowSchema = z.object({
  id: Id,
  workspaceId: Id,
  folderId: Id.nullable(),
  ownerId: Id,
  kind: DocumentKindSchema,
  title: z.string(),
  contentJson: Content,
  visibility: DocumentVisibilitySchema,
  version: z.int().nonnegative(),
  createdAt: Iso,
  updatedAt: Iso,
  deletedAt: Iso.nullable(),
});
export type SyncDocumentRow = z.infer<typeof syncDocumentRowSchema>;

export const syncMeetingPushSchema = z.strictObject({
  id: Id,
  documentId: Id,
  calendarEventId: z.string().min(1).max(1024).nullable(),
  startedAt: Iso.nullable(),
  endedAt: Iso.nullable(),
  platform: z.string().min(1).max(100).nullable(),
});
export type SyncMeetingPush = z.infer<typeof syncMeetingPushSchema>;

export const syncMeetingRowSchema = z.object({
  ...syncMeetingPushSchema.shape,
  templateId: Id.nullable(),
});
export type SyncMeetingRow = z.infer<typeof syncMeetingRowSchema>;

export const syncParticipantRowSchema = z.strictObject({
  id: Id,
  meetingId: Id,
  name: z.string().min(1).max(500),
  email: z.string().max(320).nullable(),
  source: ParticipantSourceSchema,
});
export type SyncParticipantRow = z.infer<typeof syncParticipantRowSchema>;

/** A final transcript segment (meeting clock, ms). */
export const syncSegmentRowSchema = z
  .strictObject({
    id: z.string().min(1).max(64),
    meetingId: Id,
    source: TranscriptSourceSchema,
    speakerLabel: z.string().min(1).max(200).nullable(),
    startMs: z.int().nonnegative().max(2_147_483_647),
    endMs: z.int().nonnegative().max(2_147_483_647),
    text: z.string().min(1).max(10_000),
  })
  .refine((s) => s.endMs >= s.startMs, { message: 'endMs must be >= startMs', path: ['endMs'] });
export type SyncSegmentRow = z.infer<typeof syncSegmentRowSchema>;

// ---------------------------------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------------------------------

const version = z.int().positive();

export const syncPushEntrySchema = z.discriminatedUnion('op', [
  z.discriminatedUnion('table', [
    z.strictObject({
      version,
      op: z.literal('upsert'),
      table: z.literal('document'),
      /** The server `version` the local edit was made on (0 for a document never acknowledged). */
      baseVersion: z.int().nonnegative(),
      row: syncDocumentPushSchema,
    }),
    z.strictObject({
      version,
      op: z.literal('upsert'),
      table: z.literal('meeting'),
      row: syncMeetingPushSchema,
    }),
    z.strictObject({
      version,
      op: z.literal('upsert'),
      table: z.literal('participant'),
      row: syncParticipantRowSchema,
    }),
    z.strictObject({
      version,
      op: z.literal('upsert'),
      table: z.literal('transcript_segment'),
      row: syncSegmentRowSchema,
    }),
  ]),
  z.strictObject({
    version,
    op: z.literal('delete'),
    table: z.enum(SYNC_PUSH_TABLES),
    id: z.string().min(1).max(100),
  }),
]);
export type SyncPushEntry = z.infer<typeof syncPushEntrySchema>;

/**
 * The request body. Entries are validated one by one on the server (a malformed entry is `rejected`
 * with `invalid` rather than failing the batch), so only the envelope and `version` are checked here.
 */
export const syncPushRequestSchema = z.strictObject({
  entries: z.array(z.looseObject({ version })).min(1).max(MAX_PUSH_ENTRIES),
});
export type SyncPushRequest = { entries: SyncPushEntry[] };

export const SYNC_REJECT_CODES = ['forbidden', 'not_found', 'invalid', 'unsupported'] as const;
export type SyncRejectCode = (typeof SYNC_REJECT_CODES)[number];

export const syncPushResultSchema = z.discriminatedUnion('status', [
  /** Applied (or already applied: replays are idempotent). Documents return the stored row. */
  z.object({
    version,
    status: z.literal('ok'),
    row: syncDocumentRowSchema.optional(),
  }),
  /** Stale `baseVersion`: the server copy, which the client keeps (its own becomes a conflicted copy). */
  z.object({ version, status: z.literal('conflict'), row: syncDocumentRowSchema }),
  /** Can never succeed as sent (no access, unknown parent, invalid): the client drops the entry. */
  z.object({
    version,
    status: z.literal('rejected'),
    code: z.enum(SYNC_REJECT_CODES),
    message: z.string(),
  }),
]);
export type SyncPushResult = z.infer<typeof syncPushResultSchema>;

export const syncPushResponseSchema = z.object({ results: z.array(syncPushResultSchema) });
export type SyncPushResponse = z.infer<typeof syncPushResponseSchema>;

// ---------------------------------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------------------------------

export const syncPullChangeSchema = z.discriminatedUnion('op', [
  z.discriminatedUnion('table', [
    z.object({
      op: z.literal('upsert'),
      table: z.literal('workspace'),
      row: syncWorkspaceRowSchema,
    }),
    z.object({ op: z.literal('upsert'), table: z.literal('document'), row: syncDocumentRowSchema }),
    z.object({ op: z.literal('upsert'), table: z.literal('meeting'), row: syncMeetingRowSchema }),
    z.object({
      op: z.literal('upsert'),
      table: z.literal('participant'),
      row: syncParticipantRowSchema,
    }),
    z.object({
      op: z.literal('upsert'),
      table: z.literal('transcript_segment'),
      row: syncSegmentRowSchema,
    }),
  ]),
  /** Hard-deleted, or no longer readable by this user. */
  z.object({ op: z.literal('delete'), table: z.enum(SYNC_PULL_TABLES), id: z.string().min(1) }),
]);
export type SyncPullChange = z.infer<typeof syncPullChangeSchema>;

export const syncPullResponseSchema = z.object({
  changes: z.array(syncPullChangeSchema),
  /** Pass back as `?cursor=`; unchanged (possibly `null`) when nothing new. */
  cursor: z.string().nullable(),
  /** More changes are ready: pull again right away. */
  hasMore: z.boolean(),
  /** Every workspace the user belongs to right now. */
  workspaceIds: z.array(Id),
});
export type SyncPullResponse = z.infer<typeof syncPullResponseSchema>;

// ---------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------

/** JSON with sorted keys, block ids (`attrs.id`) and then-empty `attrs` dropped. */
function canonicalContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalContent);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    let v = (value as Record<string, unknown>)[key];
    if (v === undefined) continue;
    if (key === 'attrs' && v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const { id: _id, ...rest } = v as Record<string, unknown>;
      if (Object.values(rest).every((x) => x === undefined)) continue;
      v = rest;
    }
    out[key] = canonicalContent(v);
  }
  return out;
}

/**
 * Whether two TipTap documents say the same thing, ignoring key order (Postgres `jsonb` reorders keys)
 * and block ids (the server assigns missing ones). Used to recognise a replayed push and to skip a
 * conflicted copy that would be identical to the server copy.
 */
export function sameDocumentContent(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalContent(a)) === JSON.stringify(canonicalContent(b));
}
