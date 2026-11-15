/**
 * Shell data shapes + pure tree helpers. Shared by the server loader (`src/server/shell.ts`) and the
 * client shell (sidebar, ⌘K, breadcrumbs, move dialog), which receive the data as props/context, never
 * by import. Shapes follow SPEC §6: folders and documents (pages, meeting notes) with a parent folder
 * and a visibility.
 */
import type { Role } from '@oat/core';

import type { Access, DocumentSummary, FolderSummary } from './api-types';

export type Workspace = {
  id: string;
  name: string;
  kind: 'personal' | 'team';
  members: number;
  /** The signed-in user's role here (viewers can't create). */
  role: Role;
  /** Emoji icon (5.1), if set. */
  icon?: string | null;
};

export type DocumentKind = 'page' | 'meeting' | 'folder';

/** Where an item shows in the sidebar: `private` = only me, `shared` = the workspace can see it. */
export type Area = 'private' | 'shared';

export type DocumentNode = {
  id: string;
  title: string;
  kind: DocumentKind;
  visibility: 'private' | 'workspace' | 'link';
  /** Containing folder (`null` = workspace root). */
  parentId: string | null;
  ownerId: string;
  updatedAt: string;
  /** Documents only: the sync base version (D-19), for renames from the sidebar. */
  version?: number;
  /** Documents in the trash only. */
  deletedAt?: string | null;
  access: Access;
};

/** The signed-in user, as the shell shows them (sidebar account menu). */
export type ShellUser = {
  id: string;
  name: string;
  email: string;
  image: string | null;
};

/** Everything the app frame needs for the current user, loaded once per request in `(app)/layout`. */
export type ShellData = {
  user: ShellUser;
  /** The active workspace (always one of `workspaces`). */
  workspace: Workspace;
  workspaces: readonly Workspace[];
  /** The active workspace's folders and live documents the user can read, flat (`parentId` links). */
  documents: readonly DocumentNode[];
  /** Trashed documents of the active workspace the user can read (newest first). */
  trash: readonly DocumentNode[];
};

/** A display name: the user's name, else the part of their email before `@`. */
export function displayName(user: { name?: string | null; email: string }): string {
  return user.name?.trim() || user.email.split('@')[0] || user.email;
}

/** A document's title for display (empty titles are allowed while typing). */
export function titleOf(node: Pick<DocumentNode, 'title' | 'kind'>): string {
  return node.title.trim() || (node.kind === 'folder' ? 'Untitled folder' : 'Untitled');
}

export function areaOf(node: Pick<DocumentNode, 'visibility'>): Area {
  return node.visibility === 'private' ? 'private' : 'shared';
}

export function findDocument(
  documents: readonly DocumentNode[],
  id: string,
): DocumentNode | undefined {
  return documents.find((doc) => doc.id === id);
}

const folderFirst = (a: DocumentNode, b: DocumentNode) =>
  Number(b.kind === 'folder') - Number(a.kind === 'folder');

/** Items directly inside folder `parentId`, folders first (otherwise in list order). */
export function childrenOf(documents: readonly DocumentNode[], parentId: string): DocumentNode[] {
  return documents.filter((doc) => doc.parentId === parentId).toSorted(folderFirst);
}

/**
 * Top-level items of a sidebar section: items at the workspace root in that area, plus items whose
 * folder isn't visible to the user (e.g. their own private page in a folder that was made private by
 * someone else), so nothing readable is unreachable.
 */
export function rootsOf(documents: readonly DocumentNode[], area: Area): DocumentNode[] {
  const ids = new Set(documents.map((doc) => doc.id));
  return documents
    .filter((doc) => (doc.parentId === null || !ids.has(doc.parentId)) && areaOf(doc) === area)
    .toSorted(folderFirst);
}

/** Ancestors from the root down to (excluding) `id`, for breadcrumbs. Cycle-safe. */
export function ancestorsOf(documents: readonly DocumentNode[], id: string): DocumentNode[] {
  const chain: DocumentNode[] = [];
  const seen = new Set<string>();
  let parentId = findDocument(documents, id)?.parentId ?? null;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = findDocument(documents, parentId);
    if (!parent) break;
    chain.unshift(parent);
    parentId = parent.parentId;
  }
  return chain;
}

/** `id` and every folder/document below it. */
export function subtreeIds(documents: readonly DocumentNode[], id: string): Set<string> {
  const ids = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const doc of documents) {
      if (doc.parentId && ids.has(doc.parentId) && !ids.has(doc.id)) {
        ids.add(doc.id);
        grew = true;
      }
    }
  }
  return ids;
}

/** "Projects / Q3" for a folder: its ancestors' titles and its own. */
export function pathOf(documents: readonly DocumentNode[], id: string): string {
  const node = findDocument(documents, id);
  if (!node) return '';
  return [...ancestorsOf(documents, id), node].map(titleOf).join(' / ');
}

/** The area an item shows under: that of its top-most visible ancestor. */
export function sectionOf(documents: readonly DocumentNode[], id: string): Area | undefined {
  const node = findDocument(documents, id);
  if (!node) return undefined;
  const [root] = ancestorsOf(documents, id);
  return areaOf(root ?? node);
}

/** API document → tree node. */
export function documentNode(doc: DocumentSummary): DocumentNode {
  return {
    id: doc.id,
    title: doc.title,
    kind: doc.kind,
    visibility: doc.visibility,
    parentId: doc.folderId,
    ownerId: doc.ownerId,
    updatedAt: doc.updatedAt,
    version: doc.version,
    deletedAt: doc.deletedAt,
    access: doc.access,
  };
}

/** API folder → tree node. */
export function folderNode(folder: FolderSummary): DocumentNode {
  return {
    id: folder.id,
    title: folder.name,
    kind: 'folder',
    visibility: folder.visibility,
    parentId: folder.parentId,
    ownerId: folder.ownerId,
    updatedAt: folder.updatedAt,
    access: folder.access,
  };
}
