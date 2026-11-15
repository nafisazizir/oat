import { assertCan, canReadDocument } from '@oat/core';
import {
  type Db,
  document,
  type DocumentRow,
  documentSnapshot,
  type DocumentSnapshotRow,
  enhancement,
  type EnhancementRow,
  type SnapshotReason,
  template,
} from '@oat/db';
import type { JSONContent } from '@oat/editor';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';

import type {
  EnhancementDetail,
  EnhancementVersionDto,
  EnhancementVersionList,
  NoteSnapshotDto,
  RestoreEnhancementInput,
  RestoreEnhancementResult,
} from '../dto/enhance.ts';
import { jsonEqual } from '../json-equal.ts';

import type { Actor } from '../actor.ts';
import { ApiError, badRequest, forbidden, notFound, staleVersion } from '../errors.ts';
import { prepareContent, toDetail } from '../documents.ts';
import type { Queryable } from '../folders.ts';
import type { EnhanceDeps, StoredOutput } from './service.ts';

/*
 * Versions, restore and undo (task 4.5, D-20). Every completed run is a version of the note: its output
 * (`output_json.doc`) and the user's notes it started from (`input_notes_json`) are kept immutably, so the
 * body can be set back to either at any time. Restoring is an ordinary body write (D-19: `baseVersion` check,
 * +1 version, the same `prepareContent` gate, change_log → re-index), refused while a run is writing the note.
 *
 * Never lose text: whatever replaces the body (a regenerate applying, a restore, undo or redo) first saves the
 * body it replaces as a `document_snapshot` — in the same transaction, with the row locked — unless that exact
 * body is already stored (an output, input notes or an earlier snapshot of the note). Snapshots are listed and
 * restorable like versions.
 *
 * History is for editors: earlier versions and the raw notes can hold text an editor removed before sharing,
 * so listing, viewing and restoring need `editDocument` (viewers get 403, non-readers 404).
 */

/** Newest entries listed per note (older ones stay restorable by id). */
const MAX_VERSIONS = 50;

/** Whether the body has any text at all (an empty note is never worth a snapshot). */
function hasText(node: JSONContent | undefined): boolean {
  if (!node) return false;
  if (node.type === 'text') return Boolean(node.text?.trim());
  if (node.type === 'mention' || node.type === 'image') return true;
  return (node.content ?? []).some(hasText);
}

/**
 * SQL: the `document` row's current body equals a stored output or input notes of one of its runs, or one of
 * its snapshots (`jsonb =` is structural, like `jsonEqual`).
 */
const bodyIsStored = sql<boolean>`(
  exists (
    select 1 from enhancement e
    where e.document_id = "document"."id"
      and (e.output_json -> 'doc' = "document"."content_json" or e.input_notes_json = "document"."content_json")
  )
  or exists (
    select 1 from document_snapshot s
    where s.document_id = "document"."id" and s.content_json = "document"."content_json"
  )
)`;

/**
 * Saves the note's current body as a snapshot if it is stored nowhere. Call inside the transaction that is
 * about to replace the body, with the row at `version` (it is locked here). `false` if the row isn't at that
 * version (or is trashed): the caller's version-checked UPDATE will then not apply either.
 */
export async function snapshotBeforeReplace(
  tx: Queryable,
  documentId: string,
  version: number,
  reason: SnapshotReason,
  userId: string | null,
): Promise<{ atVersion: boolean; snapshot: DocumentSnapshotRow | null }> {
  const [row] = await tx
    .select({ contentJson: document.contentJson, stored: bodyIsStored })
    .from(document)
    .where(
      and(eq(document.id, documentId), eq(document.version, version), isNull(document.deletedAt)),
    )
    .for('update');
  if (!row) return { atVersion: false, snapshot: null };
  if (row.stored || !hasText(row.contentJson as JSONContent)) {
    return { atVersion: true, snapshot: null };
  }
  const [snapshot] = await tx
    .insert(documentSnapshot)
    .values({
      documentId,
      contentJson: row.contentJson,
      documentVersion: version,
      reason,
      createdBy: userId,
    })
    .returning();
  return { atVersion: true, snapshot: snapshot ?? null };
}

/** A note the actor may see the history of: 404 if unreadable, 403 if read-only. */
async function editableDocument(db: Queryable, actor: Actor, id: string): Promise<DocumentRow> {
  const [row] = await db.select().from(document).where(eq(document.id, id));
  if (!row || !canReadDocument(actor.ctx, row)) throw notFound();
  assertCan('editDocument', actor.ctx, row);
  return row;
}

type Entry =
  | { kind: 'version'; run: EnhancementRow; doc: DocumentRow }
  | { kind: 'snapshot'; snapshot: DocumentSnapshotRow; doc: DocumentRow };

/** A run or snapshot of a note the actor can edit (404 when unreadable or unknown, 403 when read-only). */
async function editableEntry(db: Db, actor: Actor, id: string): Promise<Entry> {
  const [run] = await db.select().from(enhancement).where(eq(enhancement.id, id));
  const [snapshot] = run
    ? []
    : await db.select().from(documentSnapshot).where(eq(documentSnapshot.id, id));
  const documentId = run?.documentId ?? snapshot?.documentId;
  if (!documentId) throw notFound('Version');
  const [doc] = await db.select().from(document).where(eq(document.id, documentId));
  if (!doc || !canReadDocument(actor.ctx, doc)) throw notFound('Version');
  assertCan('editDocument', actor.ctx, doc);
  return run ? { kind: 'version', run, doc } : { kind: 'snapshot', snapshot: snapshot!, doc };
}

/** Completed runs of a note, oldest first (numbering order), without the outputs themselves. */
async function versionRows(db: Db, doc: DocumentRow) {
  return db
    .select({
      id: enhancement.id,
      documentId: enhancement.documentId,
      templateId: enhancement.templateId,
      templateName: template.name,
      status: enhancement.status,
      model: enhancement.model,
      startedAt: enhancement.startedAt,
      completedAt: enhancement.completedAt,
      applied: sql<boolean | null>`(${enhancement.outputJson} ->> 'applied')::boolean`,
      documentVersion: sql<number | null>`(${enhancement.outputJson} ->> 'documentVersion')::int`,
      current: sql<boolean>`coalesce(${enhancement.outputJson} -> 'doc' = "document"."content_json", false)`,
    })
    .from(enhancement)
    .innerJoin(document, eq(document.id, enhancement.documentId))
    .leftJoin(template, eq(template.id, enhancement.templateId))
    .where(and(eq(enhancement.documentId, doc.id), eq(enhancement.status, 'completed')))
    .orderBy(asc(enhancement.createdAt), asc(enhancement.id));
}

type VersionRow = Awaited<ReturnType<typeof versionRows>>[number];

const versionDto = (row: VersionRow, number: number): EnhancementVersionDto => ({
  id: row.id,
  documentId: row.documentId,
  templateId: row.templateId,
  status: row.status,
  model: row.model,
  startedAt: row.startedAt.toISOString(),
  completedAt: row.completedAt?.toISOString() ?? null,
  applied: row.applied,
  documentVersion: row.documentVersion,
  error: null,
  number,
  templateName: row.templateName ?? null,
  current: row.current,
});

const snapshotDto = (
  row: Pick<DocumentSnapshotRow, 'id' | 'createdAt' | 'reason' | 'documentVersion'>,
  current: boolean,
): NoteSnapshotDto => ({
  id: row.id,
  createdAt: row.createdAt.toISOString(),
  reason: row.reason,
  documentVersion: row.documentVersion,
  current,
});

/** `GET /api/documents/:id/enhancements`: versions and snapshots, newest first, and whether the body is unsaved. */
export async function listEnhancementVersions(
  db: Db,
  actor: Actor,
  documentId: string,
): Promise<EnhancementVersionList> {
  const doc = await editableDocument(db, actor, documentId);
  const [runs, snapshots, [state]] = await Promise.all([
    versionRows(db, doc),
    db
      .select({
        id: documentSnapshot.id,
        createdAt: documentSnapshot.createdAt,
        reason: documentSnapshot.reason,
        documentVersion: documentSnapshot.documentVersion,
        current: sql<boolean>`${documentSnapshot.contentJson} = "document"."content_json"`,
      })
      .from(documentSnapshot)
      .innerJoin(document, eq(document.id, documentSnapshot.documentId))
      .where(eq(documentSnapshot.documentId, doc.id))
      .orderBy(desc(documentSnapshot.createdAt), desc(documentSnapshot.id))
      .limit(MAX_VERSIONS),
    db
      .select({
        version: document.version,
        stored: bodyIsStored,
        enhanced: sql<boolean>`exists (select 1 from enhancement e where e.document_id = "document"."id" and e.status = 'completed')`,
      })
      .from(document)
      .where(eq(document.id, doc.id)),
  ]);
  return {
    versions: runs
      .map((row, i) => versionDto(row, i + 1))
      .reverse()
      .slice(0, MAX_VERSIONS),
    snapshots: snapshots.map((row) => snapshotDto(row, row.current)),
    body: {
      version: state?.version ?? doc.version,
      edited: Boolean(state?.enhanced && !state.stored && hasText(doc.contentJson as JSONContent)),
    },
  };
}

/** `GET /api/enhancements/:id`: a version's output + starting notes, or a snapshot's body (read-only views). */
export async function getEnhancementVersion(
  db: Db,
  actor: Actor,
  id: string,
): Promise<EnhancementDetail> {
  const entry = await editableEntry(db, actor, id);
  if (entry.kind === 'snapshot') {
    const { snapshot, doc } = entry;
    return {
      kind: 'snapshot',
      snapshot: snapshotDto(snapshot, jsonEqual(snapshot.contentJson, doc.contentJson)),
      doc: snapshot.contentJson as JSONContent,
    };
  }
  const { run, doc } = entry;
  const out = run.outputJson as StoredOutput | null;
  if (run.status !== 'completed' || !out || !('doc' in out)) throw notFound('Version');
  const rows = await versionRows(db, doc);
  const index = rows.findIndex((r) => r.id === run.id);
  return {
    kind: 'version',
    enhancement: versionDto(rows[index]!, index + 1),
    doc: out.doc,
    notes: run.inputNotesJson as JSONContent,
  };
}

/**
 * `POST /api/enhancements/:id/restore`: sets the note body to a version's output (`output`), the notes it
 * started from (`notes` — "undo enhancement"), or a snapshot's body (`output`). Editors only, live notes only,
 * not while a run is writing; a stale `baseVersion` is 409 with the server copy. The replaced body is saved as a
 * snapshot first when it is stored nowhere.
 */
export async function restoreEnhancementVersion(
  db: Db,
  deps: Pick<EnhanceDeps, 'staleAfterMs'>,
  actor: Actor,
  id: string,
  input: RestoreEnhancementInput,
): Promise<RestoreEnhancementResult> {
  const entry = await editableEntry(db, actor, id);
  const { doc } = entry;
  if (doc.deletedAt) throw forbidden('Restore this note from the trash first.');

  let source: unknown;
  if (entry.kind === 'snapshot') {
    if (input.target !== 'output')
      throw badRequest('target: a saved note can only be restored as is.');
    source = entry.snapshot.contentJson;
  } else {
    const out = entry.run.outputJson as StoredOutput | null;
    if (entry.run.status !== 'completed' || !out || !('doc' in out)) throw notFound('Version');
    const notes = entry.run.inputNotesJson as JSONContent;
    // A run from a transcript alone started from no notes: undo gives an empty note.
    source =
      input.target === 'output'
        ? out.doc
        : notes.content?.length
          ? notes
          : { type: 'doc', content: [{ type: 'paragraph' }] };
  }
  const content = prepareContent(source);

  const result = await db.transaction(async (tx) => {
    // Same lock as starting a run: a restore never interleaves with a start for this note.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`enhance:${doc.id}`}, 0))`,
    );
    const staleSecs = (deps.staleAfterMs ?? 3 * 60_000) / 1000;
    const [running] = await tx
      .select({ id: enhancement.id })
      .from(enhancement)
      .where(
        and(
          eq(enhancement.documentId, doc.id),
          eq(enhancement.status, 'generating'),
          sql`${enhancement.startedAt} >= now() - make_interval(secs => ${staleSecs})`,
        ),
      )
      .limit(1);
    if (running) {
      throw new ApiError(
        409,
        'enhance_busy',
        'The AI is writing this note right now. Try again when it’s done.',
      );
    }
    const saved = await snapshotBeforeReplace(
      tx,
      doc.id,
      input.baseVersion,
      'restore',
      actor.userId,
    );
    if (!saved.atVersion) return null;
    const [row] = await tx
      .update(document)
      .set({ ...content, version: sql`${document.version} + 1` })
      .where(
        and(
          eq(document.id, doc.id),
          eq(document.version, input.baseVersion),
          isNull(document.deletedAt),
        ),
      )
      .returning();
    return row ? { row, snapshot: saved.snapshot } : null;
  });
  if (result) {
    return {
      document: toDetail(actor, result.row),
      snapshot: result.snapshot ? snapshotDto(result.snapshot, false) : null,
    };
  }

  const [current] = await db.select().from(document).where(eq(document.id, doc.id));
  if (!current || !canReadDocument(actor.ctx, current)) throw notFound();
  if (current.deletedAt) throw forbidden('Restore this note from the trash first.');
  throw staleVersion(toDetail(actor, current));
}
