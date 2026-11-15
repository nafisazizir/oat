/**
 * Wire shapes of the documents/folders API (`/api/documents…`, `/api/folders…`). Shared by the route
 * handlers (`src/server/api`), the server loaders and the browser client (`src/lib/api-client.ts`).
 * Plain types only: dates are ISO strings, content is TipTap JSON (D-4).
 */
import type { DocumentKind, DocumentVisibility, FolderVisibility } from '@oat/core';
import type { JSONContent } from '@oat/editor';

/** What the actor may do with an item (computed by `@oat/core` permissions on the server). */
export type Access = {
  edit: boolean;
  /** Move to trash, restore, delete permanently. */
  delete: boolean;
};

export type DocumentSummary = {
  id: string;
  workspaceId: string;
  folderId: string | null;
  ownerId: string;
  kind: DocumentKind;
  title: string;
  visibility: DocumentVisibility;
  /** Sync base version (D-19): send it back as `baseVersion` when updating. */
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Non-null = in the trash. */
  deletedAt: string | null;
  access: Access;
};

export type DocumentDetail = DocumentSummary & { contentJson: JSONContent };

export type FolderSummary = {
  id: string;
  workspaceId: string;
  parentId: string | null;
  ownerId: string;
  name: string;
  visibility: FolderVisibility;
  createdAt: string;
  updatedAt: string;
  access: Access;
};

/** Error body of every non-2xx response. A 409 `stale_version` also carries the server copy. */
export type ApiErrorBody = {
  error: { code: ApiErrorCode; message: string };
  document?: DocumentDetail;
};

export type ApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'bad_request'
  | 'invalid_content'
  | 'stale_version'
  | 'not_in_trash'
  | 'confirm_private'
  /** Templates: built-ins are read-only (duplicate them instead). */
  | 'builtin_read_only'
  | 'cross_site';

// Request bodies -------------------------------------------------------------------------------------

export type CreateDocumentInput = {
  workspaceId: string;
  folderId?: string | null;
  kind?: DocumentKind;
  title?: string;
  /** `private` (default) or `workspace`; always `private` inside a private folder. */
  visibility?: 'private' | 'workspace';
  contentJson?: JSONContent;
};

export type UpdateDocumentInput = {
  baseVersion: number;
  title?: string;
  contentJson?: JSONContent;
};

/**
 * `folderId: null` = workspace root. Moving a non-private item into a private folder makes it private
 * (D-18) and needs `makePrivate: true`; without it the API answers 422 `confirm_private`.
 */
export type MoveDocumentInput = { folderId: string | null; makePrivate?: boolean };

export type CreateFolderInput = {
  workspaceId: string;
  parentId?: string | null;
  name: string;
  visibility?: FolderVisibility;
};

export type RenameFolderInput = { name: string };

export type MoveFolderInput = { parentId: string | null; makePrivate?: boolean };
