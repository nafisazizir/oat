/**
 * Shell data shapes + pure tree helpers. Shared by the server loader (`src/server/shell.ts`) and the
 * client shell (sidebar, ⌘K, breadcrumbs), which receive the data as props/context, never by import.
 * Shapes loosely follow SPEC §6 (workspaces; documents with a parent, a kind and a visibility).
 */

export type Workspace = {
  id: string;
  name: string;
  kind: 'personal' | 'team';
  members: number;
};

export type DocumentKind = 'page' | 'meeting' | 'folder';

export type DocumentNode = {
  id: string;
  title: string;
  kind: DocumentKind;
  /** `private` docs live in the Private tree, `workspace` docs under Shared. */
  visibility: 'private' | 'workspace';
  parentId: string | null;
  updatedAt: string;
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
  /** The current workspace's document tree as a flat list (parents referenced by `parentId`). */
  documents: readonly DocumentNode[];
};

/** A display name: the user's name, else the part of their email before `@`. */
export function displayName(user: { name?: string | null; email: string }): string {
  return user.name?.trim() || user.email.split('@')[0] || user.email;
}

export function findDocument(
  documents: readonly DocumentNode[],
  id: string,
): DocumentNode | undefined {
  return documents.find((doc) => doc.id === id);
}

export function childrenOf(
  documents: readonly DocumentNode[],
  parentId: string | null,
  visibility: DocumentNode['visibility'],
): DocumentNode[] {
  return documents.filter((doc) => doc.parentId === parentId && doc.visibility === visibility);
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
