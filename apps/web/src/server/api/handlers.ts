import { DocumentKindSchema, FolderVisibilitySchema } from '@oat/core';
import { z } from 'zod';

import {
  createDocument,
  deleteDocumentForever,
  getDocument,
  listDocuments,
  moveDocument,
  restoreDocument,
  trashDocument,
  updateDocument,
} from '../documents';
import { createFolder, deleteFolder, listFolders, moveFolder, renameFolder } from '../folders';
import { badRequest } from './errors';
import { type ApiDeps, apiRoute, readJson } from './route';

/*
 * The documents/folders HTTP API (route handlers; the desktop app syncs through the same routes in 3.5).
 * Every handler is: session → zod-validated input → a data-access function that checks `@oat/core`
 * permissions. Shapes: `src/lib/api-types.ts`. Errors: `{ error: { code, message } }` with
 *   401 no session · 403 not allowed (or cross-site cookie write) · 404 unknown or not readable
 *   · 400 bad input / invalid content · 409 stale `baseVersion` (+ `document`: server copy) or
 *   "not in trash" · 422 `confirm_private` (move would make the item private; resend with makePrivate).
 *
 *   GET    /api/documents?workspaceId=…[&trash=1]   live (or trashed) documents the actor can read
 *   POST   /api/documents                            create → 201 DocumentDetail
 *   GET    /api/documents/:id                        DocumentDetail (incl. trashed, if readable)
 *   PATCH  /api/documents/:id                        { baseVersion, title?, contentJson? }
 *   DELETE /api/documents/:id                        move to trash; `?permanent=1` deletes a trashed doc
 *   POST   /api/documents/:id/move                   { folderId, makePrivate? }
 *   POST   /api/documents/:id/restore                out of the trash
 *   GET    /api/folders?workspaceId=…                folders the actor can see
 *   POST   /api/folders                              create → 201 FolderSummary
 *   PATCH  /api/folders/:id                          { name }
 *   DELETE /api/folders/:id                          delete folder + subfolders, trash their documents
 *   POST   /api/folders/:id/move                     { parentId, makePrivate? }
 */

const Id = z.string().min(1).max(100);
const Title = z.string().max(1000);
/** TipTap JSON; the shape is checked by `validateDoc` in the data layer. */
const Content = z.looseObject({ type: z.literal('doc') });

const CreateDocument = z.strictObject({
  workspaceId: Id,
  folderId: Id.nullish(),
  kind: DocumentKindSchema.optional(),
  title: Title.optional(),
  visibility: z.enum(['private', 'workspace']).optional(),
  contentJson: Content.optional(),
});

const UpdateDocument = z.strictObject({
  baseVersion: z.number().int().min(0),
  title: Title.optional(),
  contentJson: Content.optional(),
});

const MoveDocument = z.strictObject({
  folderId: Id.nullable(),
  makePrivate: z.boolean().optional(),
});

const CreateFolder = z.strictObject({
  workspaceId: Id,
  parentId: Id.nullish(),
  name: z.string().max(1000),
  visibility: FolderVisibilitySchema.optional(),
});

const RenameFolder = z.strictObject({ name: z.string().max(1000) });

const MoveFolder = z.strictObject({ parentId: Id.nullable(), makePrivate: z.boolean().optional() });

type IdParams = { id: string };

function workspaceParam(url: URL): string {
  const parsed = Id.safeParse(url.searchParams.get('workspaceId'));
  if (!parsed.success) throw badRequest('workspaceId is required.');
  return parsed.data;
}

const flag = (url: URL, name: string) => ['1', 'true'].includes(url.searchParams.get(name) ?? '');

export function createApi(deps: ApiDeps) {
  return {
    /** `/api/documents` */
    documents: {
      GET: apiRoute(deps, async ({ db, actor, url }) =>
        listDocuments(db, actor, workspaceParam(url), { trash: flag(url, 'trash') }),
      ),
      POST: apiRoute(
        deps,
        async ({ db, actor, request }) =>
          createDocument(db, actor, await readJson(request, CreateDocument)),
        { status: 201 },
      ),
    },
    /** `/api/documents/[id]` */
    document: {
      GET: apiRoute<IdParams>(deps, async ({ db, actor, params }) =>
        getDocument(db, actor, params.id),
      ),
      PATCH: apiRoute<IdParams>(deps, async ({ db, actor, params, request }) =>
        updateDocument(db, actor, params.id, await readJson(request, UpdateDocument)),
      ),
      DELETE: apiRoute<IdParams>(deps, async ({ db, actor, params, url }) => {
        if (flag(url, 'permanent')) return deleteDocumentForever(db, actor, params.id);
        return trashDocument(db, actor, params.id);
      }),
    },
    /** `/api/documents/[id]/move` */
    documentMove: {
      POST: apiRoute<IdParams>(deps, async ({ db, actor, params, request }) =>
        moveDocument(db, actor, params.id, await readJson(request, MoveDocument)),
      ),
    },
    /** `/api/documents/[id]/restore` */
    documentRestore: {
      POST: apiRoute<IdParams>(deps, async ({ db, actor, params }) =>
        restoreDocument(db, actor, params.id),
      ),
    },
    /** `/api/folders` */
    folders: {
      GET: apiRoute(deps, async ({ db, actor, url }) =>
        listFolders(db, actor, workspaceParam(url)),
      ),
      POST: apiRoute(
        deps,
        async ({ db, actor, request }) =>
          createFolder(db, actor, await readJson(request, CreateFolder)),
        { status: 201 },
      ),
    },
    /** `/api/folders/[id]` */
    folder: {
      PATCH: apiRoute<IdParams>(deps, async ({ db, actor, params, request }) =>
        renameFolder(db, actor, params.id, await readJson(request, RenameFolder)),
      ),
      DELETE: apiRoute<IdParams>(deps, async ({ db, actor, params }) =>
        deleteFolder(db, actor, params.id),
      ),
    },
    /** `/api/folders/[id]/move` */
    folderMove: {
      POST: apiRoute<IdParams>(deps, async ({ db, actor, params, request }) =>
        moveFolder(db, actor, params.id, await readJson(request, MoveFolder)),
      ),
    },
  };
}

export type Api = ReturnType<typeof createApi>;
