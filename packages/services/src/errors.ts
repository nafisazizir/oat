import { isForbiddenError } from '@oat/core';

import type { ApiErrorBody, ApiErrorCode, DocumentDetail } from './dto/api-types.ts';

/**
 * A failure the API reports to the client. Data-access functions (`src/server/documents.ts`,
 * `src/server/folders.ts`) throw these; the route wrapper (`./route.ts`) turns them into JSON responses.
 * `@oat/core`'s `ForbiddenError` maps to 403.
 */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    /** Extra body fields (the server copy on a 409). */
    readonly extra: Omit<ApiErrorBody, 'error'> = {},
  ) {
    super(message);
  }
}

export const unauthorized = () => new ApiError(401, 'unauthorized', 'Sign in to continue.');

/**
 * 404 for anything the actor may not read — including documents and folders that exist but are private
 * to someone else, so the API never confirms they exist.
 */
export const notFound = (what = 'Document') => new ApiError(404, 'not_found', `${what} not found.`);

export const forbidden = (message = 'You don’t have permission to do that.') =>
  new ApiError(403, 'forbidden', message);

export const badRequest = (message: string) => new ApiError(400, 'bad_request', message);

export const invalidContent = (message: string) =>
  new ApiError(400, 'invalid_content', `Invalid document content: ${message}`);

/** D-19: the update's `baseVersion` is not the stored version. Carries the server copy. */
export const staleVersion = (document: DocumentDetail) =>
  new ApiError(409, 'stale_version', 'This document changed elsewhere.', { document });

export const notInTrash = () =>
  new ApiError(409, 'not_in_trash', 'Move the document to the trash before deleting it.');

/** D-18: the move would make the item private; the client must confirm with `makePrivate: true`. */
export const confirmPrivate = () =>
  new ApiError(
    422,
    'confirm_private',
    'Moving this into a private folder makes it private. Confirm with makePrivate: true.',
  );

/** D-18: documents inside a private folder can't be shared (5.3). */
export const inPrivateFolder = () =>
  new ApiError(
    409,
    'private_folder',
    'This page is in a private folder. Move it out of the folder to share it.',
  );

export function toApiError(error: unknown): ApiError | undefined {
  if (error instanceof ApiError) return error;
  if (isForbiddenError(error)) return forbidden();
  return undefined;
}

export function errorResponse(error: ApiError): Response {
  const body: ApiErrorBody = {
    error: { code: error.code, message: error.message },
    ...error.extra,
  };
  const headers = new Headers({ 'cache-control': 'no-store' });
  if (error.extra.retryAfter !== undefined)
    headers.set('retry-after', String(error.extra.retryAfter));
  return Response.json(body, { status: error.status, headers });
}
