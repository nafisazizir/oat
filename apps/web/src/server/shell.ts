import 'server-only';

import {
  ensureFirstWorkspace,
  hasAnyJoinChoice,
  lastActiveWorkspaceId,
  listUserWorkspaces,
  pickActiveWorkspace,
  type UserWorkspace,
} from '@oat/auth';
import { type CalendarEvent, createPermissionContext } from '@oat/core';
import { meeting } from '@oat/db';
import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { cache } from 'react';

import type { DocumentDetail, DocumentSummary, FolderSummary } from '@/lib/api-types';
import {
  childrenOf,
  displayName,
  documentNode,
  type DocumentNode,
  folderNode,
  type ShellData,
  type ShellUser,
  type Workspace,
} from '@/lib/tree';

import { workspaceIcon } from '@/lib/workspace';

import type { Actor } from './actor';
import { ApiError } from './api/errors';
import { findCalendarEventByKey } from './calendar';
import { getDb } from './db';
import { getDocument, listDocuments, listRecentDocuments } from './documents';
import { listFolders, readableFolder, toFolderSummary } from './folders';
import { loadMeetingInfo } from './meeting';
import { requireSession } from './session';
import { loadTranscript } from './transcript';

/*
 * Server-side data for the app shell and pages. Client components never import this:
 * `(app)/layout.tsx` calls `getShellData()` and passes the result down through `AppShell` →
 * `ShellDataProvider`. Everything is read through the same permission-checked data layer as the API
 * (`./documents`, `./folders`), scoped to the session's active workspace.
 */

const toWorkspace = (w: UserWorkspace): Workspace => ({
  id: w.id,
  name: w.name,
  members: w.memberCount,
  icon: workspaceIcon(w.logo),
  role: w.role,
});

/** Pure part of the loader: session user + memberships + tree → shell data. */
export function buildShellData(input: {
  user: { id: string; name?: string | null; email: string; image?: string | null };
  workspaces: readonly UserWorkspace[];
  activeWorkspaceId: string | null | undefined;
  /** The workspace the user last switched to (used when the session's one is gone or unset). */
  lastActiveWorkspaceId?: string | null;
  folders?: readonly FolderSummary[];
  documents?: readonly DocumentSummary[];
  trash?: readonly DocumentSummary[];
  canJoin?: boolean;
}): ShellData {
  const active = pickActiveWorkspace(
    input.workspaces,
    input.activeWorkspaceId,
    input.lastActiveWorkspaceId,
  );
  if (!active) throw new Error('signed-in user has no workspace');
  const user: ShellUser = {
    id: input.user.id,
    name: displayName(input.user),
    email: input.user.email,
    image: input.user.image ?? null,
  };
  return {
    user,
    workspace: toWorkspace(active),
    workspaces: input.workspaces.map(toWorkspace),
    documents: [
      ...(input.folders ?? []).map(folderNode),
      ...(input.documents ?? []).map(documentNode),
    ],
    trash: (input.trash ?? []).map(documentNode),
    canJoin: input.canJoin ?? false,
  };
}

/**
 * The signed-in user, their workspaces (the active one resolved from the session) and their
 * permission context. Redirects to `/sign-in` without a session. Deduped per request.
 *
 * A user without a workspace (D-36) — new, removed from their only one, or its owner deleted it — gets one
 * of their own here; unless they have a choice to make first (an invitation to answer, or a workspace their
 * email domain lets them join or ask to join), in which case they are sent to the join screen (`/join`),
 * where "Create my own workspace" is the alternative.
 */
const getContext = cache(async () => {
  const { user, session } = await requireSession();
  const db = getDb();
  let workspaces = await listUserWorkspaces(db, user.id);
  if (workspaces.length === 0) {
    const first = await ensureFirstWorkspace(db, user.id);
    if (first.workspaceId === undefined) redirect('/join');
    workspaces = await listUserWorkspaces(db, user.id);
  }
  // The workspace list already carries the user's roles: no second membership query.
  const actor: Actor = {
    userId: user.id,
    ctx: createPermissionContext({
      userId: user.id,
      memberships: workspaces.map((w) => ({ workspaceId: w.id, userId: user.id, role: w.role })),
    }),
  };
  // The session's workspace is gone (left, removed, deleted) or was never set: the one last switched to,
  // else the oldest membership — the same rule a new session starts with.
  const sessionActive = workspaces.some((w) => w.id === session.activeOrganizationId);
  const active = pickActiveWorkspace(
    workspaces,
    session.activeOrganizationId,
    sessionActive ? null : await lastActiveWorkspaceId(db, user.id),
  );
  if (!active) throw new Error('signed-in user has no workspace');
  return { db, user, session, workspaces, actor, active };
});

/** User, workspaces and the active workspace's tree + trash for the signed-in frame. */
export const getShellData = cache(async (): Promise<ShellData> => {
  const { db, user, workspaces, actor, active } = await getContext();
  const [folders, documents, trash, canJoin] = await Promise.all([
    listFolders(db, actor, active.id),
    listDocuments(db, actor, active.id),
    listDocuments(db, actor, active.id, { trash: true }),
    // Yes or no only, with the context already loaded (never a workspace the user is in).
    hasAnyJoinChoice(db, user.id, actor.ctx),
  ]);
  return buildShellData({
    user,
    workspaces,
    activeWorkspaceId: active.id,
    folders,
    documents,
    trash,
    canJoin,
  });
});

export type DocumentPageData =
  | { type: 'document'; document: DocumentDetail }
  | { type: 'folder'; folder: FolderSummary; children: DocumentNode[] };

const isNotFound = (error: unknown) => error instanceof ApiError && error.status === 404;

/**
 * What `/d/[id]` shows: a document (incl. a trashed one the user may still read) or a folder, or
 * `undefined` when it doesn't exist *or* the user can't read it (the page 404s either way).
 */
export const loadDocumentPage = cache(async (id: string): Promise<DocumentPageData | undefined> => {
  const { db, actor, active } = await getContext();
  try {
    return { type: 'document', document: await getDocument(db, actor, id) };
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  try {
    const folder = await readableFolder(db, actor, id);
    // The active workspace's tree is already loaded; a folder from another workspace loads its own.
    const documents =
      folder.workspaceId === active.id
        ? (await getShellData()).documents
        : await Promise.all([
            listFolders(db, actor, folder.workspaceId),
            listDocuments(db, actor, folder.workspaceId),
          ]).then(([folders, docs]) => [...folders.map(folderNode), ...docs.map(documentNode)]);
    return {
      type: 'folder',
      folder: toFolderSummary(actor, folder),
      children: childrenOf(documents, folder.id),
    };
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  return undefined;
});

/** Meeting notes for Home's "Recent notes", newest edit first. */
export async function listRecentMeetings(limit: number): Promise<DocumentNode[]> {
  const { db, actor, active } = await getContext();
  const docs = await listRecentDocuments(db, actor, active.id, { kind: 'meeting', limit });
  return docs.map(documentNode);
}

/** Most recently edited pages for Home's "Jump back in". */
export async function listRecentPages(limit: number): Promise<DocumentNode[]> {
  const { db, actor, active } = await getContext();
  const docs = await listRecentDocuments(db, actor, active.id, { kind: 'page', limit });
  return docs.map(documentNode);
}

/**
 * A meeting note's times, attendees and transcript for its page (3.4); `null` for a page, a folder or
 * anything the user can't read (the page itself decides what to show then). Safe to start in parallel
 * with `loadDocumentPage`.
 */
export async function loadDocumentMeeting(id: string) {
  const { db, actor } = await getContext();
  try {
    return await loadMeetingInfo(db, actor, id, { transcript: true });
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * The calendar event a meeting note the user can read was started from (7.3: `meeting.calendar_event_id`), from
 * the user's own connected calendar, while it still has the event; else `null` (9.3: the web shows the same
 * "Scheduled … · Join" line as the desktop).
 */
export async function loadMeetingCalendarEvent(id: string): Promise<CalendarEvent | null> {
  const { db, actor } = await getContext();
  try {
    await getDocument(db, actor, id); // read access, else 404
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  const [row] = await db
    .select({ key: meeting.calendarEventId })
    .from(meeting)
    .where(eq(meeting.documentId, id));
  return row?.key ? findCalendarEventByKey(actor.userId, row.key) : null;
}

/** The meeting transcript of a document the user can read (the `/d/[id]?t=…&seg=…` reader, 6.4). */
export async function loadDocumentTranscript(id: string) {
  const { db, actor } = await getContext();
  return loadTranscript(db, actor, id);
}
