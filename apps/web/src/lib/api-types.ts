/**
 * Wire shapes of the documents/folders API (`/api/documents…`, `/api/folders…`). Shared by the route
 * handlers (`src/server/api`), the server loaders and the browser client (`src/lib/api-client.ts`).
 * Plain types only: dates are ISO strings, content is TipTap JSON (D-4).
 */
import type { DocumentKind, DocumentVisibility, FolderVisibility, WorkspaceKind } from '@oat/core';
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

/**
 * Sharing settings of a document (`GET`/`PATCH /api/documents/:id/share`, 5.3). Readable by anyone who can
 * read the document; changing them needs `shareDocument` (`access.share`).
 */
export type DocumentSharing = {
  documentId: string;
  kind: DocumentKind;
  visibility: DocumentVisibility;
  /** `/share/<token>` while visibility is `link`, else `null`. Prefix with the app origin to copy. */
  sharePath: string | null;
  /** Link viewers also see the meeting transcript (default off). */
  shareTranscript: boolean;
  /** The actor may change visibility, the transcript toggle and the link. */
  canShare: boolean;
  /** D-18: a document inside a private folder stays private (move it out to share it). */
  inPrivateFolder: boolean;
  owner: { id: string; name: string };
  workspace: { id: string; name: string; kind: WorkspaceKind; memberCount: number };
};

/**
 * Change sharing. Entering `link` always issues a fresh token (D-18); leaving it clears the token;
 * `rotateLink` issues a new token for a document that stays `link` (the old URL stops working).
 */
export type UpdateSharingInput = {
  visibility?: DocumentVisibility;
  shareTranscript?: boolean;
  rotateLink?: boolean;
};

/** Error body of every non-2xx response. A 409 `stale_version` also carries the server copy. */
export type ApiErrorBody = {
  error: { code: ApiErrorCode; message: string };
  document?: DocumentDetail;
  /** Seconds to wait, on a 429. */
  retryAfter?: number;
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
  | 'private_folder'
  /** Templates: built-ins are read-only (duplicate them instead). */
  | 'builtin_read_only'
  | 'cross_site'
  | 'rate_limited'
  // Notion (8.1)
  | 'not_configured'
  | 'notion_not_connected'
  | 'notion_no_target'
  | 'notion_reconnect'
  | 'notion_busy'
  | 'notion_error'
  | 'stt_unavailable';

/** `POST /api/stt/token` (2.5, D-17): a short-lived live-transcription credential for the desktop. */
export type SttTokenResponse = {
  /** Bearer token for the provider's live websocket (`Authorization: Bearer …`). */
  accessToken: string;
  /** Seconds until `accessToken` stops being accepted for new connections. */
  expiresIn: number;
  /** Deepgram-compatible live websocket URL the token is valid for. */
  listenUrl: string;
};

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

// Notion (8.1): `/api/integrations/notion…`, `/api/documents/:id/notion` -----------------------------

/** A Notion page or database the connection can see (target picker). */
export type NotionTargetOption = {
  type: 'page' | 'database';
  id: string;
  title: string;
  /** Emoji icon, if the page has one. */
  icon: string | null;
  url: string | null;
};

/** The signed-in user's Notion connection for one Oat workspace. Tokens never leave the server. */
export type NotionConnectionInfo = {
  workspaceId: string;
  notionWorkspaceName: string | null;
  notionWorkspaceIcon: string | null;
  connectedAt: string;
  /** Notion revoked access (or the stored token is unusable): connect again. */
  needsReconnect: boolean;
  /** Where new notes go. */
  target: { type: 'page' | 'database'; id: string; title: string; url: string | null } | null;
};

/** `GET /api/documents/:id/notion`. */
export type NotionDocumentStatus = {
  /** Notion is set up on this server. */
  configured: boolean;
  /** The user's connection for the note's workspace, if any. */
  connection: NotionConnectionInfo | null;
  /** The Notion page this note was last sent to by this user. */
  export: {
    url: string | null;
    pushedAt: string;
    pushedVersion: number;
    changedSince: boolean;
  } | null;
};

/** `POST /api/documents/:id/notion`. */
export type NotionPushResult = {
  url: string;
  /** A new Notion page (first send, or the old page was gone). */
  created: boolean;
  pushedAt: string;
  pushedVersion: number;
};
