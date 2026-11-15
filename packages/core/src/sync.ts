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
 *   the start when it joined one; `lagging` says committed changes are still held back (pull again soon).
 *
 * 3.5 additions: the push names the device (`device.name`, stored on conflicted copies); a document
 * create may say it is a conflicted copy (`conflictOf`); `GET /api/sync/backfill?document=` returns a
 * document's meeting subtree the first time a client sees it; `GET /api/sync/events` is an SSE
 * invalidation channel ({@link SyncEvent}); conflicted copies are resolved with
 * `POST /api/sync/conflicts/:id` ({@link syncConflictResolveSchema}) or by syncing a delete of the copy.
 */
import { z } from 'zod';

import {
  DocumentKindSchema,
  DocumentVisibilitySchema,
  ParticipantSourceSchema,
  RoleSchema,
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

/**
 * Bumped whenever {@link SYNC_PULL_TABLES} or a pulled row grows: a client with an older scope restarts its
 * cursor. 2 = 3.5 (conflicted-copy fields on documents). 3 = 3.9 (the user's `role` on workspace rows).
 */
export const SYNC_PULL_SCOPE = 3;

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
  /**
   * 3.9: the pulling user's role in this workspace (the desktop decides where new notes may go; the server
   * still checks every push). A change of the user's membership re-sends the row. `null` = not known (a row
   * from before scope 3).
   */
  role: RoleSchema.nullable().default(null),
});
export type SyncWorkspaceRow = z.infer<typeof syncWorkspaceRowSchema>;

/** What a client may write on a document: create it (root, private) or change title/content. */
export const syncDocumentPushSchema = z.strictObject({
  id: Id,
  workspaceId: Id,
  kind: DocumentKindSchema,
  title: Title,
  contentJson: Content,
  /** Only on create: this document is a conflicted copy of that one (D-19, 3.5). Ignored on updates. */
  conflictOf: Id.optional(),
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
  /** Conflicted copy (3.5): the document it was split from, the device whose edit lost, and when. */
  conflictOfId: Id.nullable().default(null),
  conflictDevice: z.string().max(200).nullable().default(null),
  conflictAt: Iso.nullable().default(null),
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
export const syncDeviceSchema = z.strictObject({ name: z.string().trim().min(1).max(100) });
export type SyncDevice = z.infer<typeof syncDeviceSchema>;

export const syncPushRequestSchema = z.strictObject({
  entries: z.array(z.looseObject({ version })).min(1).max(MAX_PUSH_ENTRIES),
  /** The pushing device (3.5): its name is stored on the conflicted copies it creates. */
  device: syncDeviceSchema.optional(),
});
export type SyncPushRequest = { entries: SyncPushEntry[]; device?: SyncDevice };

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
  /**
   * Committed changes after `cursor` are still held back because an older transaction is open somewhere
   * (D-22): the pull isn't complete; try again in a moment instead of at the next scheduled pull.
   */
  lagging: z.boolean().optional(),
});
export type SyncPullResponse = z.infer<typeof syncPullResponseSchema>;

// ---------------------------------------------------------------------------------------------------
// Backfill (3.5)
// ---------------------------------------------------------------------------------------------------

/** Most rows in one backfill page. */
export const MAX_BACKFILL_LIMIT = 500;

/**
 * `GET /api/sync/backfill?document=<id>&after=<token>`: the current rows under a document the client
 * has just seen for the first time (its meeting, participants, final segments) — they may have changed
 * before the client's cursor while it couldn't read them. Upserts only, parents first; page with `next`.
 */
export const syncBackfillResponseSchema = z.object({
  changes: z.array(syncPullChangeSchema),
  /** Pass back as `?after=` for the next page; `null` = done. */
  next: z.string().nullable(),
});
export type SyncBackfillResponse = z.infer<typeof syncBackfillResponseSchema>;

// ---------------------------------------------------------------------------------------------------
// Events (3.5): SSE invalidation channel
// ---------------------------------------------------------------------------------------------------

/**
 * One `data:` of `GET /api/sync/events` (`event: change`). `seq` is also the SSE `id` (send it back as
 * `Last-Event-ID` to replay what was missed). Says *what* to pull, never the rows: `tables` that changed
 * in the user's workspaces and the `ids` of affected **documents** the user can read (a meeting, segment
 * or participant change names its document). `workspaces: true` = the user's workspace list changed.
 */
export const syncEventSchema = z.object({
  seq: z.string(),
  tables: z.array(z.string()),
  ids: z.array(z.string()),
  workspaces: z.boolean().optional(),
});
export type SyncEvent = z.infer<typeof syncEventSchema>;

// ---------------------------------------------------------------------------------------------------
// Conflicted copies (3.5)
// ---------------------------------------------------------------------------------------------------

/**
 * `POST /api/sync/conflicts/:copyId`: `copy` = the copy's title/body replace the original's (one new
 * version of the original), `original` = keep the original as it is. Either way the copy goes to the
 * trash.
 */
export const syncConflictResolveSchema = z.strictObject({
  keep: z.enum(['copy', 'original']),
  /** The original's version the user compared against; a newer one is a 409 (compare again). */
  baseVersion: z.int().nonnegative().optional(),
});
export type SyncConflictResolve = z.infer<typeof syncConflictResolveSchema>;

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

/** The title as the server stores it (one line, collapsed whitespace). */
export function normalizeSyncTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim();
}

/**
 * A stable string for a document's title + body, equal for two versions exactly when
 * {@link sameDocumentContent} and the normalized titles agree. Clients hash it to recognise their own
 * earlier write in a conflict (3.5: a lost acknowledgement must not become a conflicted copy).
 */
export function documentContentKey(title: string, contentJson: unknown): string {
  return JSON.stringify([normalizeSyncTitle(title), canonicalContent(contentJson)]);
}

/**
 * Whether two TipTap documents say the same thing, ignoring key order (Postgres `jsonb` reorders keys)
 * and block ids (the server assigns missing ones). Used to recognise a replayed push and to skip a
 * conflicted copy that would be identical to the server copy.
 */
export function sameDocumentContent(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalContent(a)) === JSON.stringify(canonicalContent(b));
}

// ---------------------------------------------------------------------------------------------------
// Comparing a conflicted copy with its original (3.5, desktop + web)
// ---------------------------------------------------------------------------------------------------

const LINE_BLOCKS = new Set([
  'paragraph',
  'heading',
  'codeBlock',
  'horizontalRule',
  'image',
  'tableRow',
]);

/**
 * A TipTap document as plain lines for a side-by-side compare: one line per text block, list items
 * prefixed with "• " (task items with "☐ " / "☑ "), headings with "#"s. Not a renderer — just enough to
 * see what differs.
 */
export function documentLines(json: unknown): string[] {
  const lines: string[] = [];
  const text = (node: unknown): string => {
    if (!node || typeof node !== 'object') return '';
    const n = node as { type?: string; text?: string; content?: unknown[] };
    if (n.type === 'text') return n.text ?? '';
    if (n.type === 'hardBreak') return ' ';
    return (n.content ?? []).map(text).join('');
  };
  const walk = (node: unknown, prefix: string): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: string; attrs?: Record<string, unknown>; content?: unknown[] };
    const type = n.type ?? '';
    if (type === 'listItem' || type === 'taskItem') {
      const mark = type === 'taskItem' ? (n.attrs?.checked ? '☑ ' : '☐ ') : '• ';
      let first = true;
      for (const child of n.content ?? []) {
        walk(child, first ? prefix + mark : prefix + '  ');
        first = false;
      }
      return;
    }
    if (LINE_BLOCKS.has(type)) {
      const level = type === 'heading' ? Number(n.attrs?.level ?? 1) : 0;
      const head = level > 0 ? `${'#'.repeat(Math.min(level, 6))} ` : '';
      const value = type === 'horizontalRule' ? '———' : text(n);
      if (type === 'codeBlock') for (const l of value.split('\n')) lines.push(prefix + l);
      else lines.push(prefix + head + value);
      return;
    }
    for (const child of n.content ?? []) walk(child, prefix);
  };
  walk(json, '');
  while (lines.length > 0 && lines.at(-1)!.trim() === '') lines.pop();
  return lines;
}

export interface DiffLine {
  text: string;
  /** Not in the other side (outside the longest common subsequence). */
  changed: boolean;
}

/** Marks the lines of `a` and `b` that aren't part of their longest common subsequence. */
export function diffLines(
  a: readonly string[],
  b: readonly string[],
): { left: DiffLine[]; right: DiffLine[] } {
  // Quadratic; compare views are short. Past 2000 lines the rest is shown as changed.
  const n = Math.min(a.length, 2_000);
  const m = Math.min(b.length, 2_000);
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const keepA = new Array<boolean>(a.length).fill(false);
  const keepB = new Array<boolean>(b.length).fill(false);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) {
      keepA[i++] = true;
      keepB[j++] = true;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) i++;
    else j++;
  }
  return {
    left: a.map((text, i) => ({ text, changed: !keepA[i] })),
    right: b.map((text, j) => ({ text, changed: !keepB[j] })),
  };
}
