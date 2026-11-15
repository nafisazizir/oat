import 'server-only';

import { randomBytes } from 'node:crypto';

import {
  assertCan,
  canReadDocument,
  canShareDocument,
  createPermissionContext,
  type DocumentKind,
  type DocumentVisibility,
  MIN_SHARE_TOKEN_LENGTH,
  shouldRotateShareToken,
} from '@oat/core';
import {
  type Db,
  document,
  type DocumentRow,
  folder,
  meeting,
  membership,
  transcriptSegment,
  user,
  workspace,
} from '@oat/db';
import { renderDocumentHtml } from '@oat/editor/html';
import { and, asc, count, eq } from 'drizzle-orm';

import type { DocumentSharing, UpdateSharingInput } from '@/lib/api-types';
import { displayName } from '@/lib/tree';

import type { Actor } from './actor';
import { badRequest, inPrivateFolder, notFound } from './api/errors';
import { lockTree, type Queryable } from './folders';

/*
 * Document sharing (SPEC §4 Sharing, §6, D-18; task 5.3).
 * - Settings: `getSharing` / `updateSharing` for the share dialog, through `@oat/core` (`shareDocument`).
 *   Unreadable documents are 404 like everywhere else; readable but not shareable → 403.
 * - Tokens: 32 base64url chars from 24 random bytes (192 bits; core requires ≥ 22 chars / 128 bits).
 *   Entering `link` always issues a new token, leaving it clears the token, `rotateLink` replaces it.
 * - D-18: a document inside a private folder is private; it can't be shared until moved out (409).
 * - Public view: `loadSharedDocument` resolves a token with an *anonymous* permission context (the
 *   viewer's own session, if any, never matters), and returns only what the public page renders:
 *   title, sanitised HTML, meeting times, the author's display name and — only when the sharer turned it
 *   on — the transcript. No ids, emails, workspace or folder data.
 */

/** URL path of a share link. */
export const sharePath = (token: string) => `/share/${token}`;

/** Shape of a token we could have issued; anything else is rejected before touching the database. */
const TOKEN_SHAPE = new RegExp(`^[A-Za-z0-9_-]{${MIN_SHARE_TOKEN_LENGTH},128}$`);

/** A fresh share token: 24 bytes from the CSPRNG → 32 base64url characters. */
export function newShareToken(): string {
  return randomBytes(24).toString('base64url');
}

async function loadRow(db: Queryable, id: string, lock = false): Promise<DocumentRow | undefined> {
  const query = db.select().from(document).where(eq(document.id, id));
  const [row] = lock ? await query.for('update') : await query;
  return row;
}

async function inPrivateFolderCheck(db: Queryable, row: DocumentRow): Promise<boolean> {
  if (!row.folderId) return false;
  const [parent] = await db
    .select({ visibility: folder.visibility })
    .from(folder)
    .where(eq(folder.id, row.folderId));
  return parent?.visibility === 'private';
}

async function toSharing(db: Queryable, actor: Actor, row: DocumentRow): Promise<DocumentSharing> {
  const [[owner], [ws], [members], privateFolder] = await Promise.all([
    db
      .select({ id: user.id, name: user.name, email: user.email })
      .from(user)
      .where(eq(user.id, row.ownerId)),
    db
      .select({ id: workspace.id, name: workspace.name, kind: workspace.kind })
      .from(workspace)
      .where(eq(workspace.id, row.workspaceId)),
    db.select({ n: count() }).from(membership).where(eq(membership.workspaceId, row.workspaceId)),
    inPrivateFolderCheck(db, row),
  ]);
  return {
    documentId: row.id,
    kind: row.kind,
    visibility: row.visibility,
    sharePath: row.visibility === 'link' && row.shareToken ? sharePath(row.shareToken) : null,
    shareTranscript: row.shareTranscript,
    canShare: canShareDocument(actor.ctx, row),
    inPrivateFolder: privateFolder,
    owner: { id: row.ownerId, name: owner ? displayName(owner) : 'Unknown' },
    workspace: {
      id: row.workspaceId,
      name: ws?.name ?? '',
      kind: ws?.kind ?? 'personal',
      memberCount: Number(members?.n ?? 0),
    },
  };
}

/** Sharing settings of a document the actor can read (else 404). */
export async function getSharing(db: Db, actor: Actor, id: string): Promise<DocumentSharing> {
  const row = await loadRow(db, id);
  if (!row || !canReadDocument(actor.ctx, row)) throw notFound();
  return toSharing(db, actor, row);
}

/**
 * Changes visibility / the transcript toggle / the link token. Serialised with tree writes (a concurrent
 * move into a private folder can't slip between the folder check and the update) and with other writes
 * to the document (row lock). Sharing changes do **not** bump `version`: that is the content version
 * used for optimistic concurrency / sync conflicts (D-19), and flipping visibility must never turn a
 * concurrent unsynced edit into a 409 or a conflicted copy. The change still reaches other devices: the
 * `change_log` trigger (D-22) records every row update.
 */
export async function updateSharing(
  db: Db,
  actor: Actor,
  id: string,
  input: UpdateSharingInput,
): Promise<DocumentSharing> {
  if (
    input.visibility === undefined &&
    input.shareTranscript === undefined &&
    input.rotateLink !== true
  ) {
    throw badRequest('Nothing to update.');
  }
  const first = await loadRow(db, id);
  if (!first || !canReadDocument(actor.ctx, first)) throw notFound();

  return db.transaction(async (tx) => {
    await lockTree(tx, first.workspaceId);
    const row = await loadRow(tx, id, true);
    if (!row || !canReadDocument(actor.ctx, row)) throw notFound();
    assertCan('shareDocument', actor.ctx, row);

    const from = row.visibility;
    const to: DocumentVisibility = input.visibility ?? from;
    if (input.rotateLink && to !== 'link') {
      throw badRequest('Only a document shared by link has a link to reset.');
    }
    if (to !== 'private' && (await inPrivateFolderCheck(tx, row))) throw inPrivateFolder();

    let shareToken = row.shareToken;
    if (to !== 'link') shareToken = null;
    else if (shouldRotateShareToken(from, to) || input.rotateLink || !shareToken) {
      shareToken = newShareToken();
    }
    const shareTranscript = input.shareTranscript ?? row.shareTranscript;

    if (to === from && shareToken === row.shareToken && shareTranscript === row.shareTranscript) {
      return toSharing(tx, actor, row);
    }
    const [updated] = await tx
      .update(document)
      .set({
        visibility: to,
        shareToken,
        shareTranscript,
      })
      .where(eq(document.id, id))
      .returning();
    return toSharing(tx, actor, updated!);
  });
}

// ---------------------------------------------------------------------------------------------------------
// Public viewer
// ---------------------------------------------------------------------------------------------------------

export type SharedTranscriptLine = {
  /** `mic` = the person who recorded (the author), `system` = everyone else on the call. */
  source: 'mic' | 'system';
  speaker: string;
  startMs: number;
  text: string;
};

/** Everything the public page may show. Deliberately no ids, emails, workspace or folder data. */
export type SharedDocument = {
  title: string;
  kind: DocumentKind;
  /** Sanitised HTML of the note body (`@oat/editor/html`). */
  html: string;
  updatedAt: Date;
  /** The author's display name, if they set one (never their email). */
  authorName: string | null;
  meeting: { startedAt: Date | null; endedAt: Date | null } | null;
  /** Only when the sharer opted in; `null` otherwise. */
  transcript: SharedTranscriptLine[] | null;
};

/** Longest transcript the public page renders (a few hours of speech). */
const MAX_TRANSCRIPT_LINES = 5000;

/**
 * The document behind a share token, or `undefined` when the token is malformed, unknown, no longer
 * active (visibility changed, link reset) or the document is in the trash. All of these look the same.
 */
export async function loadSharedDocument(
  db: Db,
  token: string,
): Promise<SharedDocument | undefined> {
  if (!TOKEN_SHAPE.test(token)) return undefined;
  const [row] = await db.select().from(document).where(eq(document.shareToken, token));
  if (!row) return undefined;
  // Anonymous on purpose: the link grants read access to this document and nothing else.
  const ctx = createPermissionContext({ userId: null, shareToken: token });
  if (!canReadDocument(ctx, row)) return undefined;

  const [[author], [meet]] = await Promise.all([
    db.select({ name: user.name }).from(user).where(eq(user.id, row.ownerId)),
    db
      .select({ id: meeting.id, startedAt: meeting.startedAt, endedAt: meeting.endedAt })
      .from(meeting)
      .where(eq(meeting.documentId, row.id)),
  ]);
  const authorName = author?.name?.trim() || null;

  let transcript: SharedTranscriptLine[] | null = null;
  if (row.shareTranscript && meet) {
    const segments = await db
      .select({
        source: transcriptSegment.source,
        speakerLabel: transcriptSegment.speakerLabel,
        startMs: transcriptSegment.startMs,
        text: transcriptSegment.text,
      })
      .from(transcriptSegment)
      .where(and(eq(transcriptSegment.meetingId, meet.id), eq(transcriptSegment.isFinal, true)))
      .orderBy(asc(transcriptSegment.startMs), asc(transcriptSegment.id))
      .limit(MAX_TRANSCRIPT_LINES);
    transcript = segments.map((s) => ({
      source: s.source,
      speaker: s.speakerLabel?.trim() || (s.source === 'mic' ? (authorName ?? 'Host') : 'Others'),
      startMs: s.startMs,
      text: s.text,
    }));
  }

  return {
    title: row.title,
    kind: row.kind,
    html: renderDocumentHtml(row.contentJson),
    updatedAt: row.updatedAt,
    authorName,
    meeting: meet ? { startedAt: meet.startedAt, endedAt: meet.endedAt } : null,
    transcript,
  };
}
