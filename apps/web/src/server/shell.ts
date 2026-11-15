import 'server-only';

import { cache } from 'react';

import {
  childrenOf,
  findDocument,
  type DocumentNode,
  type ShellData,
  type Workspace,
} from '@/lib/tree';

/*
 * Server-side data for the app shell and pages. Today an in-memory mock; the only place mock data
 * lives. Client components never import this: `(app)/layout.tsx` calls `getShellData()` and passes the
 * result down through `AppShell` → `ShellDataProvider`.
 *
 * Swapping in the DB (3.3) changes the bodies below and nothing else: same names, same shapes, already
 * async. Each getter will take the session's user/workspace (1.6) and filter by permission (1.7).
 */

const workspaces: readonly Workspace[] = [
  { id: 'personal', name: 'Personal', kind: 'personal', members: 1 },
  { id: 'acme', name: 'Acme Design', kind: 'team', members: 6 },
];

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

/** Workspace, workspace list and document tree for the signed-in frame. Deduped per request (layout + pages). */
export const getShellData = cache(async (): Promise<ShellData> => {
  return { workspace: workspaces[0]!, workspaces, documents };
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
