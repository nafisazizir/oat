import 'server-only';

import { canReadDocument, type DocumentKind } from '@oat/core';
import { type Db, document, workspace } from '@oat/db';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import type { Actor } from '../actor';
import { requireMember } from '../folders';
import { asciiSlug, createFileNamer } from './names';
import { ZipWriter } from './zip';

/*
 * "Export my notes" (D-36): before leaving a workspace a member can take their own notes with them, as
 * Markdown (`content_md`, D-4) in one zip. Leaving means losing access to everything in the workspace,
 * private notes included, so this is offered in the leave dialog.
 *
 * What is in it — decided here, on the server, for the signed-in user only (the route takes a workspace
 * id and nothing else):
 * - documents (pages and meeting notes) of **that workspace** whose owner is the caller, whatever their
 *   visibility — "my notes", not "notes I can read": a teammate's shared note is not mine to take;
 * - each one is also asked of `@oat/core` (`canReadDocument`) on the row as read, so the export can never
 *   hold something the caller could not open (a non-member gets 404 before anything is read);
 * - not the trash: a note in the trash is one its owner threw away, and the export says what a person
 *   keeps. Restore it first to take it along.
 * - the note's text only: no transcript, audio, comments or other people's edits history.
 *
 * Bounded: at most `MAX_EXPORT_DOCUMENTS` notes (the first ones made; the archive then carries a file
 * saying it is incomplete), read `BATCH` at a time while the response streams, so memory stays at one
 * batch.
 */

export const MAX_EXPORT_DOCUMENTS = 2000;
const BATCH = 20;

/** Name of the file that says the archive is incomplete (only present when it is). */
export const INCOMPLETE_NOTE = '_Not everything was exported.txt';

export type NotesExport = {
  /** e.g. `oat-notes-acme-2026-11-21.zip` (ASCII). */
  filename: string;
  /** How many notes the archive will hold. */
  count: number;
  /** More notes exist than `MAX_EXPORT_DOCUMENTS`. */
  truncated: boolean;
  stream: ReadableStream<Uint8Array>;
};

/** The Markdown file of one note: its title as a heading, then its text. */
export function noteMarkdown(note: {
  title: string;
  kind: DocumentKind;
  contentMd: string;
}): string {
  const title = note.title.trim() || (note.kind === 'meeting' ? 'Untitled meeting' : 'Untitled');
  const body = note.contentMd.trim();
  return body ? `# ${title}\n\n${body}\n` : `# ${title}\n`;
}

/**
 * The caller's own live documents in `workspaceId` as a zip of Markdown files. 404 when they are not a
 * member (also for a workspace that doesn't exist or was deleted: memberships of those are not in the
 * actor's context).
 */
export async function exportOwnNotes(
  db: Db,
  actor: Actor,
  workspaceId: string,
  { now = new Date(), max = MAX_EXPORT_DOCUMENTS }: { now?: Date; max?: number } = {},
): Promise<NotesExport> {
  requireMember(actor, workspaceId);
  const [ws] = await db
    .select({ name: workspace.name })
    .from(workspace)
    .where(eq(workspace.id, workspaceId));

  const mine = and(
    eq(document.workspaceId, workspaceId),
    eq(document.ownerId, actor.userId),
    isNull(document.deletedAt),
  );
  // Ids first (no content), oldest first so numbered duplicates follow the order notes were made in.
  const listed = await db
    .select({
      id: document.id,
      workspaceId: document.workspaceId,
      ownerId: document.ownerId,
      visibility: document.visibility,
      shareToken: document.shareToken,
      deletedAt: document.deletedAt,
    })
    .from(document)
    .where(mine)
    .orderBy(asc(document.createdAt), asc(document.id))
    .limit(max + 1);
  const truncated = listed.length > max;
  const ids = listed
    .slice(0, max)
    .filter((row) => row.ownerId === actor.userId && canReadDocument(actor.ctx, row))
    .map((row) => row.id);

  const zip = new ZipWriter();
  const nameFor = createFileNamer('.md');
  let next = 0;

  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        // Until something is written: a pull that enqueues nothing would leave the reader waiting.
        for (;;) {
          if (next >= ids.length) {
            if (truncated) {
              controller.enqueue(
                zip.add(
                  INCOMPLETE_NOTE,
                  `This export holds the first ${max} notes you made in this workspace. You have more than that; the rest are not in this file.\n`,
                  now,
                ),
              );
            }
            controller.enqueue(zip.finish());
            controller.close();
            return;
          }
          const batch = ids.slice(next, next + BATCH);
          next += batch.length;
          // The same conditions again on the rows as they are now: a note trashed, handed over or
          // moved since the list was made is left out.
          const rows = await db
            .select()
            .from(document)
            .where(and(mine, inArray(document.id, batch)));
          const byId = new Map(rows.map((row) => [row.id, row]));
          let wrote = false;
          for (const id of batch) {
            const row = byId.get(id);
            if (!row || row.ownerId !== actor.userId || !canReadDocument(actor.ctx, row)) continue;
            controller.enqueue(zip.add(nameFor(row.title), noteMarkdown(row), row.updatedAt));
            wrote = true;
          }
          if (wrote) return;
        }
      },
    },
    // Nothing is read before the client asks for it.
    { highWaterMark: 0 },
  );

  return {
    filename: `oat-notes-${asciiSlug(ws?.name ?? '')}-${now.toISOString().slice(0, 10)}.zip`,
    count: ids.length,
    truncated,
    stream,
  };
}

/** The download response for an export. */
export function exportResponse(result: NotesExport): Response {
  return new Response(result.stream, {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${result.filename}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-oat-export-count': String(result.count),
      ...(result.truncated ? { 'x-oat-export-truncated': '1' } : {}),
    },
  });
}
