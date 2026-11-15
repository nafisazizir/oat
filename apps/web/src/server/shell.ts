import 'server-only';

import {
  ensurePersonalWorkspace,
  listUserWorkspaces,
  pickActiveWorkspace,
  type UserWorkspace,
} from '@oat/auth';
import { cache } from 'react';

import {
  childrenOf,
  displayName,
  findDocument,
  type DocumentNode,
  type ShellData,
  type ShellUser,
  type Workspace,
} from '@/lib/tree';

import { getDb } from './db';
import { requireSession } from './session';

/*
 * Server-side data for the app shell and pages. Client components never import this:
 * `(app)/layout.tsx` calls `getShellData()` and passes the result down through `AppShell` →
 * `ShellDataProvider`.
 *
 * - User and workspaces are real (1.6): the session's user and their memberships from the database.
 * - Documents are still an in-memory mock (the only place mock data lives). 3.3 replaces the document
 *   getters below with DB queries scoped to the active workspace (same names and shapes; 1.7
 *   permission filtering goes in there too).
 */

const documents: readonly DocumentNode[] = [
  {
    id: 'getting-started',
    title: 'Getting started',
    kind: 'page',
    visibility: 'private',
    parentId: null,
    updatedAt: '2026-11-12T09:30:00.000Z',
  },
  {
    id: 'ideas',
    title: 'Ideas',
    kind: 'folder',
    visibility: 'private',
    parentId: null,
    updatedAt: '2026-11-10T16:00:00.000Z',
  },
  {
    id: 'reading-list',
    title: 'Reading list',
    kind: 'page',
    visibility: 'private',
    parentId: 'ideas',
    updatedAt: '2026-11-09T11:15:00.000Z',
  },
  {
    id: 'side-projects',
    title: 'Side projects',
    kind: 'page',
    visibility: 'private',
    parentId: 'ideas',
    updatedAt: '2026-11-08T20:45:00.000Z',
  },
  {
    id: 'team-handbook',
    title: 'Team handbook',
    kind: 'page',
    visibility: 'workspace',
    parentId: null,
    updatedAt: '2026-11-11T14:05:00.000Z',
  },
];

const toWorkspace = (w: UserWorkspace): Workspace => ({
  id: w.id,
  name: w.name,
  kind: w.kind,
  members: w.memberCount,
});

/** Pure part of the loader: session user + memberships → shell data. */
export function buildShellData(input: {
  user: { id: string; name?: string | null; email: string; image?: string | null };
  workspaces: readonly UserWorkspace[];
  activeWorkspaceId: string | null | undefined;
  documents: readonly DocumentNode[];
}): ShellData {
  const active = pickActiveWorkspace(input.workspaces, input.activeWorkspaceId);
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
    documents: input.documents,
  };
}

/**
 * User, workspaces (the active one resolved from the session) and document tree for the signed-in
 * frame. Redirects to `/sign-in` without a session. Deduped per request (layout + pages).
 */
export const getShellData = cache(async (): Promise<ShellData> => {
  const { user, session } = await requireSession();
  const db = getDb();
  let workspaces = await listUserWorkspaces(db, user.id);
  if (workspaces.length === 0) {
    // Normally created on sign-up; heal a user whose workspace creation failed.
    await ensurePersonalWorkspace(db, user.id);
    workspaces = await listUserWorkspaces(db, user.id);
  }
  return buildShellData({
    user,
    workspaces,
    activeWorkspaceId: session.activeOrganizationId,
    documents,
  });
});

export async function getDocument(id: string): Promise<DocumentNode | undefined> {
  return findDocument(documents, id);
}

export async function listChildren(doc: DocumentNode): Promise<DocumentNode[]> {
  return childrenOf(documents, doc.id, doc.visibility);
}

/** Meeting notes for Home's "Recent notes". Empty until capture (M2) and notes (M3) exist. */
export async function listRecentMeetings(): Promise<DocumentNode[]> {
  return documents.filter((doc) => doc.kind === 'meeting');
}

/** Most recently edited non-meeting documents for Home's "Jump back in". */
export async function listRecentPages(limit: number): Promise<DocumentNode[]> {
  return documents
    .filter((doc) => doc.kind !== 'meeting')
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

/** The mock document tree (tests and 3.3's migration reference). */
export const mockDocuments = documents;
