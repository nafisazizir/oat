import 'server-only';

import { createHash } from 'node:crypto';

import {
  canCreateInWorkspace,
  canDeleteDocument,
  canEditDocument,
  canReadDocument,
  documentContentKey,
  isForbiddenError,
  roleIn,
  sameDocumentContent,
  SYNC_PUSH_TABLES,
  type SyncDocumentRow,
  type SyncPushEntry,
  type SyncPushResponse,
  type SyncPushResult,
  type SyncRejectCode,
  type SyncSegmentRow,
  syncPushEntrySchema,
} from '@oat/core';
import {
  type Db,
  document,
  type DocumentRow,
  meeting,
  type MeetingRow,
  participant,
  syncReceipt,
  transcriptSegment,
  workspace,
} from '@oat/db';
import { and, eq, isNull, notInArray, sql } from 'drizzle-orm';

import type { Actor } from '../actor';
import { ApiError } from '../api/errors';
import { normalizeTitle, prepareContent } from '../documents';
import type { Queryable, Tx } from '../folders';

/*
 * `POST /api/sync/push` (D-19, task 2.6): applies a desktop outbox batch. Every entry is answered by its
 * outbox `version`:
 * - `ok` — applied, or already applied (replays are idempotent: a lost response is simply re-sent);
 * - `conflict` — a document edit on a stale `baseVersion` whose text differs from the stored one (409
 *   semantics per row; the client keeps the server copy, D-19);
 * - `rejected` — can never succeed as sent (no access, unknown parent, malformed, unsupported).
 *
 * Authorization is per row through `@oat/core` (the same rules as the documents API): documents are
 * created only in workspaces where the actor may create, private and at the root, owned by the actor;
 * meetings, participants and segments need edit rights on their meeting's document. Segments are
 * insert-or-replace by their client id **within the same meeting only**: an id that already belongs to
 * another meeting is rejected, never moved. Only finals sync (the schema has no interim flag).
 *
 * Entries are applied parents first (documents, meetings, participants, segments), each in its own
 * savepoint, all in one transaction; segments of one meeting go in as one statement.
 *
 * 3.5: every document text a push writes leaves a receipt (`sync_receipt`, last 20 per document). A stale
 * base whose text matches a receipt is a replay of a write that already landed (lost answer, maybe
 * edited by others since) → `ok` with the current row, never a conflict. A create with `conflictOf` is a
 * conflicted copy: linked to its original only if the actor can read that original (same workspace),
 * stamped with the pushing device's name. A `delete` of a document is accepted for conflicted copies
 * (moved to the trash, `deleteDocument` rights) and for documents that don't exist (idempotent).
 */

/** Receipts kept per document. */
const MAX_RECEIPTS = 20;

/** What a document's text is remembered by (see `@oat/core` `documentContentKey`). */
export function contentReceiptKey(title: string, contentJson: unknown): string {
  return createHash('sha256').update(documentContentKey(title, contentJson)).digest('base64url');
}

type Entry = SyncPushEntry;
type DocEntry = Extract<Entry, { table: 'document'; op: 'upsert' }>;
type MeetingEntry = Extract<Entry, { table: 'meeting'; op: 'upsert' }>;
type ParticipantEntry = Extract<Entry, { table: 'participant'; op: 'upsert' }>;
type SegmentEntry = Extract<Entry, { table: 'transcript_segment'; op: 'upsert' }>;
type DeleteEntry = Extract<Entry, { op: 'delete' }>;

class Reject extends Error {
  constructor(
    readonly code: SyncRejectCode,
    message: string,
  ) {
    super(message);
  }
}

const RANK = Object.fromEntries(SYNC_PUSH_TABLES.map((t, i) => [t, i])) as Record<
  Entry['table'],
  number
>;

export function toSyncDocument(row: DocumentRow): SyncDocumentRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    folderId: row.folderId,
    ownerId: row.ownerId,
    kind: row.kind,
    title: row.title,
    contentJson: row.contentJson as SyncDocumentRow['contentJson'],
    visibility: row.visibility,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
    conflictOfId: row.conflictOfId,
    conflictDevice: row.conflictDevice,
    conflictAt: row.conflictAt?.toISOString() ?? null,
  };
}

/** Name stored on conflicted copies when the pushing client didn't say. */
const UNKNOWN_DEVICE = 'Another device';

/** What the caller learns about a push once it committed. */
export type PushHooks = {
  /** A meeting's `ended_at` went from unset to set (8.3: start its post-meeting pipeline). */
  onMeetingEnded?: (meetingId: string) => void;
};

/** Validates entries one by one, then applies the valid ones (see the module comment). */
export async function pushChanges(
  db: Db,
  actor: Actor,
  raw: readonly { version: number }[],
  device: { name: string } | null = null,
  hooks: PushHooks = {},
): Promise<SyncPushResponse> {
  const ctx: PushContext = { actor, deviceName: device?.name ?? UNKNOWN_DEVICE, ended: [] };
  const results = new Map<number, SyncPushResult>();
  const valid: Entry[] = [];
  for (const item of raw) {
    if (results.has(item.version)) continue; // a version is answered once
    const parsed = syncPushEntrySchema.safeParse(item);
    if (parsed.success) valid.push(parsed.data);
    else {
      const issue = parsed.error.issues[0]!;
      const path = issue.path.length ? `${issue.path.join('.')}: ` : '';
      results.set(item.version, reject(item.version, 'invalid', `${path}${issue.message}`));
    }
  }

  // One entry per row: an older entry for the same row is superseded by the newest one.
  const newest = new Map<string, Entry>();
  for (const e of valid) {
    const key = `${e.table}:${e.op === 'delete' ? e.id : e.row.id}`;
    const seen = newest.get(key);
    if (!seen || seen.version < e.version) {
      if (seen) results.set(seen.version, { version: seen.version, status: 'ok' });
      newest.set(key, e);
    } else results.set(e.version, { version: e.version, status: 'ok' });
  }
  const ordered = [...newest.values()].sort(
    (a, b) => RANK[a.table] - RANK[b.table] || a.version - b.version,
  );

  await db.transaction(async (tx) => {
    const segmentsByMeeting = new Map<string, SegmentEntry[]>();
    for (const entry of ordered) {
      if (entry.op === 'upsert' && entry.table === 'transcript_segment') {
        const list = segmentsByMeeting.get(entry.row.meetingId) ?? [];
        list.push(entry);
        segmentsByMeeting.set(entry.row.meetingId, list);
        continue;
      }
      results.set(
        entry.version,
        await guarded(tx, entry.version, (sp) => applyOne(sp, ctx, entry)),
      );
    }
    for (const [meetingId, entries] of segmentsByMeeting) {
      for (const r of await applySegments(tx, actor, meetingId, entries)) results.set(r.version, r);
    }
  });
  // Only after the commit, and after this push's segments landed (the pipeline reads the transcript).
  for (const meetingId of ctx.ended) hooks.onMeetingEnded?.(meetingId);

  return { results: raw.map((e) => results.get(e.version)!).filter(dedupe()) };
}

function dedupe() {
  const seen = new Set<number>();
  return (r: SyncPushResult | undefined): r is SyncPushResult => {
    if (!r || seen.has(r.version)) return false;
    seen.add(r.version);
    return true;
  };
}

const reject = (version: number, code: SyncRejectCode, message: string): SyncPushResult => ({
  version,
  status: 'rejected',
  code,
  message,
});

/** Runs `fn` in a savepoint; a rejection (or a data error) rolls back only this entry. */
async function guarded(
  tx: Tx,
  version: number,
  fn: (sp: Tx) => Promise<SyncPushResult>,
): Promise<SyncPushResult> {
  try {
    return await tx.transaction(fn);
  } catch (error) {
    const rejected = asRejection(error);
    if (!rejected) throw error;
    return reject(version, rejected.code, rejected.message);
  }
}

/**
 * What a failed entry becomes. Known refusals map to their code; **anything unexpected** (a bug in a
 * converter, an odd database error) becomes `rejected/invalid` for that entry alone (the client parks it,
 * D-28) and is logged — it must never fail the whole batch. Only infrastructure trouble is rethrown (the
 * request fails and the client retries it): connection (08), transaction rollback / serialization /
 * deadlock (40), insufficient resources (53), operator intervention (57), system errors (58), and
 * non-Postgres connection errors (ECONNRESET, CONNECTION_CLOSED, …).
 */
export function asRejection(error: unknown): { code: SyncRejectCode; message: string } | undefined {
  if (error instanceof Reject) return { code: error.code, message: error.message };
  if (isForbiddenError(error)) return { code: 'forbidden', message: 'Not allowed.' };
  if (error instanceof ApiError) {
    if (error.status === 404) return { code: 'not_found', message: error.message };
    if (error.status === 403) return { code: 'forbidden', message: error.message };
    if (error.status >= 500) return undefined;
    return { code: 'invalid', message: error.message };
  }
  const pgCode = pgErrorCode(error);
  if (pgCode && ['08', '40', '53', '57', '58'].includes(pgCode.slice(0, 2))) return undefined;
  if (!pgCode && connectionErrorCode(error)) return undefined;
  if (pgCode?.startsWith('23') || pgCode?.startsWith('22')) {
    return { code: 'invalid', message: 'The row was refused by the database.' };
  }
  console.error('[sync] push entry failed unexpectedly; rejected as invalid', error);
  return { code: 'invalid', message: 'The server couldn’t store this change.' };
}

/** A non-Postgres error code that means the connection, not the entry, failed. */
function connectionErrorCode(error: unknown): boolean {
  for (let e: unknown = error, i = 0; e && i < 3; e = (e as { cause?: unknown }).cause, i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^(E[A-Z]+|CONNECT[A-Z_]*|CONNECTION_[A-Z_]+)$/.test(code)) {
      return true;
    }
  }
  return false;
}

function pgErrorCode(error: unknown): string | undefined {
  for (let e: unknown = error, i = 0; e && i < 3; e = (e as { cause?: unknown }).cause, i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

type PushContext = {
  actor: Actor;
  deviceName: string;
  /** Meetings this push ended (see {@link PushHooks}). */
  ended: string[];
};

function applyOne(tx: Tx, ctx: PushContext, entry: Entry): Promise<SyncPushResult> {
  const { actor } = ctx;
  if (entry.op === 'delete') return applyDelete(tx, actor, entry);
  switch (entry.table) {
    case 'document':
      return upsertDocument(tx, ctx, entry);
    case 'meeting':
      return upsertMeeting(tx, ctx, entry);
    case 'participant':
      return upsertParticipant(tx, actor, entry);
    case 'transcript_segment':
      return applySegments(tx, actor, entry.row.meetingId, [entry]).then((r) => r[0]!);
  }
}

// --- access -------------------------------------------------------------------------------------------

async function loadDocument(
  q: Queryable,
  id: string,
  lock = false,
): Promise<DocumentRow | undefined> {
  const query = q.select().from(document).where(eq(document.id, id));
  const [row] = lock ? await query.for('update') : await query;
  return row;
}

/** The document, if the actor may edit it (unreadable = `not_found`, read-only = `forbidden`). */
function requireEditable(actor: Actor, doc: DocumentRow | undefined): DocumentRow {
  if (!doc || !canReadDocument(actor.ctx, doc))
    throw new Reject('not_found', 'Document not found.');
  if (!canEditDocument(actor.ctx, doc)) throw new Reject('forbidden', 'Not allowed to edit.');
  return doc;
}

async function editableMeeting(
  q: Queryable,
  actor: Actor,
  meetingId: string,
): Promise<{ meeting: MeetingRow; doc: DocumentRow }> {
  const [row] = await q
    .select({ meeting, doc: document })
    .from(meeting)
    .innerJoin(document, eq(document.id, meeting.documentId))
    .where(eq(meeting.id, meetingId));
  if (!row || !canReadDocument(actor.ctx, row.doc)) {
    throw new Reject('not_found', 'Meeting not found.');
  }
  requireEditable(actor, row.doc);
  return row;
}

// --- documents ---------------------------------------------------------------------------------------

async function upsertDocument(
  tx: Tx,
  { actor, deviceName }: PushContext,
  entry: DocEntry,
): Promise<SyncPushResult> {
  const { row } = entry;
  const ok = (stored: DocumentRow): SyncPushResult => ({
    version: entry.version,
    status: 'ok',
    row: toSyncDocument(stored),
  });
  const title = normalizeTitle(row.title);
  const content = prepareContent(row.contentJson);
  let existing = await loadDocument(tx, row.id, true);

  if (!existing) {
    if (roleIn(actor.ctx, row.workspaceId) === undefined) {
      throw new Reject('not_found', 'Workspace not found.');
    }
    const [ws] = await tx
      .select({ id: workspace.id })
      .from(workspace)
      .where(and(eq(workspace.id, row.workspaceId), isNull(workspace.deletedAt)));
    if (!ws) throw new Reject('not_found', 'Workspace not found.');
    if (!canCreateInWorkspace(actor.ctx, ws))
      throw new Reject('forbidden', 'Not allowed to create.');
    // A conflicted copy is linked only to an original the actor can read in the same workspace (an
    // unknown or foreign id just makes an ordinary page: no existence leak).
    const original = row.conflictOf ? await loadDocument(tx, row.conflictOf) : undefined;
    const linked =
      original && original.workspaceId === ws.id && canReadDocument(actor.ctx, original)
        ? { conflictOfId: original.id, conflictDevice: deviceName, conflictAt: new Date() }
        : {};
    const [created] = await tx
      .insert(document)
      .values({
        id: row.id,
        workspaceId: ws.id,
        ownerId: actor.userId,
        kind: row.kind,
        title,
        visibility: 'private',
        ...content,
        ...linked,
      })
      .onConflictDoNothing({ target: document.id })
      .returning();
    if (created) {
      await addReceipt(tx, created);
      return ok(created);
    }
    existing = await loadDocument(tx, row.id, true); // created concurrently: treat as an update
  }

  const doc = requireEditable(actor, existing);
  if (doc.workspaceId !== row.workspaceId) {
    throw new Reject('invalid', 'Documents can’t move between workspaces.');
  }
  if (doc.kind !== row.kind) throw new Reject('invalid', 'A document’s kind can’t change.');
  const same = doc.title === title && sameDocumentContent(doc.contentJson, content.contentJson);
  if (same) return ok(doc); // nothing to do, or a replay of what was already applied
  if (doc.version !== entry.baseVersion) {
    // This text already landed through an earlier push (whose answer was lost): a replay, not a conflict.
    const [receipt] = await tx
      .select({ version: syncReceipt.version })
      .from(syncReceipt)
      .where(
        and(
          eq(syncReceipt.documentId, doc.id),
          eq(syncReceipt.contentKey, contentReceiptKey(title, content.contentJson)),
        ),
      );
    if (receipt) return ok(doc);
    return { version: entry.version, status: 'conflict', row: toSyncDocument(doc) };
  }
  const [updated] = await tx
    .update(document)
    .set({ title, ...content, version: sql`${document.version} + 1` })
    .where(and(eq(document.id, doc.id), eq(document.version, entry.baseVersion)))
    .returning();
  await addReceipt(tx, updated!);
  return ok(updated!); // the row is locked: the version can't have moved
}

/** Records that a push wrote this text (keeps the newest {@link MAX_RECEIPTS} per document). */
async function addReceipt(tx: Tx, doc: DocumentRow): Promise<void> {
  const key = contentReceiptKey(doc.title, doc.contentJson);
  await tx
    .insert(syncReceipt)
    .values({ documentId: doc.id, contentKey: key, version: doc.version })
    .onConflictDoUpdate({
      target: [syncReceipt.documentId, syncReceipt.contentKey],
      set: { version: doc.version, createdAt: new Date() },
    });
  const keep = tx
    .select({ key: syncReceipt.contentKey })
    .from(syncReceipt)
    .where(eq(syncReceipt.documentId, doc.id))
    .orderBy(sql`${syncReceipt.version} desc`)
    .limit(MAX_RECEIPTS);
  await tx
    .delete(syncReceipt)
    .where(and(eq(syncReceipt.documentId, doc.id), notInArray(syncReceipt.contentKey, keep)));
}

// --- meetings + participants ---------------------------------------------------------------------------

async function upsertMeeting(
  tx: Tx,
  { actor, ended }: PushContext,
  entry: MeetingEntry,
): Promise<SyncPushResult> {
  const { row } = entry;
  const doc = requireEditable(actor, await loadDocument(tx, row.documentId));
  if (doc.kind !== 'meeting') throw new Reject('invalid', 'Not a meeting document.');
  const [clash] = await tx
    .select({ id: meeting.id, documentId: meeting.documentId })
    .from(meeting)
    .where(
      sql`(${meeting.id} = ${row.id} and ${meeting.documentId} <> ${row.documentId})
        or (${meeting.documentId} = ${row.documentId} and ${meeting.id} <> ${row.id})`,
    );
  if (clash) throw new Reject('invalid', 'Meeting and document don’t match.');
  const [before] = await tx
    .select({ endedAt: meeting.endedAt })
    .from(meeting)
    .where(eq(meeting.id, row.id));
  const values = {
    calendarEventId: row.calendarEventId,
    startedAt: row.startedAt ? new Date(row.startedAt) : null,
    endedAt: row.endedAt ? new Date(row.endedAt) : null,
    platform: row.platform,
  };
  await tx
    .insert(meeting)
    .values({ id: row.id, documentId: row.documentId, ...values })
    .onConflictDoUpdate({
      target: meeting.id,
      set: { ...values, updatedAt: new Date() },
      setWhere: eq(meeting.documentId, row.documentId),
    });
  if (values.endedAt && !before?.endedAt) ended.push(row.id);
  return { version: entry.version, status: 'ok' };
}

async function upsertParticipant(
  tx: Tx,
  actor: Actor,
  entry: ParticipantEntry,
): Promise<SyncPushResult> {
  const { row } = entry;
  await editableMeeting(tx, actor, row.meetingId);
  const values = { name: row.name, email: row.email, source: row.source };
  const stored = await tx
    .insert(participant)
    .values({ id: row.id, meetingId: row.meetingId, ...values })
    .onConflictDoUpdate({
      target: participant.id,
      set: { ...values, updatedAt: new Date() },
      setWhere: eq(participant.meetingId, row.meetingId),
    })
    .returning({ id: participant.id });
  if (stored.length === 0) throw new Reject('invalid', 'Participant belongs to another meeting.');
  return { version: entry.version, status: 'ok' };
}

// --- transcript segments --------------------------------------------------------------------------------

/**
 * Upserts final segments of one meeting in one statement (in a savepoint). Ids that already belong to
 * another meeting are left alone and rejected. If the statement fails as a whole, each segment is retried
 * on its own so one bad row can't sink the others.
 */
async function applySegments(
  tx: Tx,
  actor: Actor,
  meetingId: string,
  entries: SegmentEntry[],
): Promise<SyncPushResult[]> {
  try {
    await tx.transaction((sp) => editableMeeting(sp, actor, meetingId));
  } catch (error) {
    const r = asRejection(error);
    if (!r) throw error;
    return entries.map((e) => reject(e.version, r.code, r.message));
  }
  const write = async (sp: Tx, list: SegmentEntry[]) => {
    const now = new Date();
    const stored = await sp
      .insert(transcriptSegment)
      .values(list.map((e) => segmentValues(e.row)))
      .onConflictDoUpdate({
        target: transcriptSegment.id,
        set: {
          source: sql`excluded.source`,
          speakerLabel: sql`excluded.speaker_label`,
          startMs: sql`excluded.start_ms`,
          endMs: sql`excluded.end_ms`,
          text: sql`excluded.text`,
          isFinal: true,
          updatedAt: now,
        },
        // Never move a segment to another meeting (cross-meeting id spoofing).
        setWhere: sql`${transcriptSegment.meetingId} = excluded.meeting_id`,
      })
      .returning({ id: transcriptSegment.id });
    const ids = new Set(stored.map((s) => s.id));
    return list.map((e) =>
      ids.has(e.row.id)
        ? ({ version: e.version, status: 'ok' } as const)
        : reject(e.version, 'invalid', 'Segment belongs to another meeting.'),
    );
  };
  try {
    return await tx.transaction((sp) => write(sp, entries));
  } catch (error) {
    const r = asRejection(error);
    if (!r) throw error;
    if (entries.length === 1) return [reject(entries[0]!.version, r.code, r.message)];
    const out: SyncPushResult[] = [];
    for (const e of entries) {
      out.push(await guarded(tx, e.version, (sp) => write(sp, [e]).then((r) => r[0]!)));
    }
    return out;
  }
}

function segmentValues(row: SyncSegmentRow) {
  return {
    id: row.id,
    meetingId: row.meetingId,
    source: row.source,
    speakerLabel: row.speakerLabel,
    startMs: row.startMs,
    endMs: row.endMs,
    text: row.text,
    isFinal: true,
  };
}

// --- deletes ---------------------------------------------------------------------------------------------

async function applyDelete(tx: Tx, actor: Actor, entry: DeleteEntry): Promise<SyncPushResult> {
  const ok = { version: entry.version, status: 'ok' } as const;
  switch (entry.table) {
    case 'document': {
      // Only conflicted copies (resolving a conflict, 3.5) are deleted by sync — into the trash. Other
      // documents go through the documents API (D-18 rules, trash).
      const doc = await loadDocument(tx, entry.id, true);
      if (!doc) return ok; // never arrived, or already gone
      if (!canReadDocument(actor.ctx, doc)) throw new Reject('not_found', 'Document not found.');
      if (!doc.conflictOfId) {
        throw new Reject('unsupported', 'Only conflicted copies can be deleted by sync.');
      }
      if (!canDeleteDocument(actor.ctx, doc))
        throw new Reject('forbidden', 'Not allowed to delete.');
      if (!doc.deletedAt) {
        await tx
          .update(document)
          .set({ deletedAt: new Date(), version: sql`${document.version} + 1` })
          .where(eq(document.id, doc.id));
      }
      return ok;
    }
    case 'meeting':
      // Meetings go with their document (documents API); not deleted by sync.
      throw new Reject('unsupported', `Deleting a ${entry.table} isn’t supported by sync.`);
    case 'participant': {
      const [row] = await tx
        .select({ meetingId: participant.meetingId })
        .from(participant)
        .where(eq(participant.id, entry.id));
      if (!row) return ok; // already gone
      await editableMeeting(tx, actor, row.meetingId);
      await tx.delete(participant).where(eq(participant.id, entry.id));
      return ok;
    }
    case 'transcript_segment': {
      const [row] = await tx
        .select({ meetingId: transcriptSegment.meetingId })
        .from(transcriptSegment)
        .where(eq(transcriptSegment.id, entry.id));
      if (!row) return ok;
      await editableMeeting(tx, actor, row.meetingId);
      await tx.delete(transcriptSegment).where(eq(transcriptSegment.id, entry.id));
      return ok;
    }
  }
}
