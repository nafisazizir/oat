/**
 * Browser client for the documents/folders API (`src/server/api/handlers.ts`). Same-origin fetches with
 * the session cookie; non-2xx answers throw {@link ApiRequestError} carrying the server's error code
 * (and, for a 409 `stale_version`, the server copy).
 */
import type {
  ApiErrorBody,
  ApiErrorCode,
  CreateDocumentInput,
  CreateFolderInput,
  DocumentDetail,
  DocumentSharing,
  FolderSummary,
  MoveDocumentInput,
  MoveFolderInput,
  UpdateDocumentInput,
  UpdateSharingInput,
} from './api-types';

export class ApiRequestError extends Error {
  override readonly name = 'ApiRequestError';
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | 'network',
    message: string,
    readonly body?: ApiErrorBody,
  ) {
    super(message);
  }
}

export function isApiError(
  error: unknown,
  code?: ApiRequestError['code'],
): error is ApiRequestError {
  return error instanceof ApiRequestError && (code === undefined || error.code === code);
}

export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  init: RequestInit = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
      ...init,
    });
  } catch {
    throw new ApiRequestError(0, 'network', 'You’re offline or the server can’t be reached.');
  }
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => undefined)) as unknown;
  if (!res.ok) {
    const error = json as ApiErrorBody | undefined;
    throw new ApiRequestError(
      res.status,
      error?.error?.code ?? 'bad_request',
      error?.error?.message ?? `Request failed (${res.status}).`,
      error,
    );
  }
  return json as T;
}

const enc = encodeURIComponent;

export const documentsApi = {
  create: (input: CreateDocumentInput) => request<DocumentDetail>('POST', '/api/documents', input),
  update: (id: string, input: UpdateDocumentInput, init?: RequestInit) =>
    request<DocumentDetail>('PATCH', `/api/documents/${enc(id)}`, input, init),
  move: (id: string, input: MoveDocumentInput) =>
    request<DocumentDetail>('POST', `/api/documents/${enc(id)}/move`, input),
  trash: (id: string) => request<DocumentDetail>('DELETE', `/api/documents/${enc(id)}`),
  restore: (id: string) => request<DocumentDetail>('POST', `/api/documents/${enc(id)}/restore`),
  deleteForever: (id: string) => request<void>('DELETE', `/api/documents/${enc(id)}?permanent=1`),
};

export const sharingApi = {
  get: (id: string) => request<DocumentSharing>('GET', `/api/documents/${enc(id)}/share`),
  update: (id: string, input: UpdateSharingInput) =>
    request<DocumentSharing>('PATCH', `/api/documents/${enc(id)}/share`, input),
};

export const foldersApi = {
  create: (input: CreateFolderInput) => request<FolderSummary>('POST', '/api/folders', input),
  rename: (id: string, name: string) =>
    request<FolderSummary>('PATCH', `/api/folders/${enc(id)}`, { name }),
  move: (id: string, input: MoveFolderInput) =>
    request<FolderSummary>('POST', `/api/folders/${enc(id)}/move`, input),
  delete: (id: string) =>
    request<{ trashedDocumentIds: string[] }>('DELETE', `/api/folders/${enc(id)}`),
};

/** Same-tab notice that a document's version/title changed (sidebar rename, move…), for open editors. */
export const DOCUMENT_CHANGED_EVENT = 'oat:document-changed';
export type DocumentChangedDetail = Pick<DocumentDetail, 'id' | 'version' | 'title'>;

export function announceDocumentChange(doc: DocumentChangedDetail) {
  window.dispatchEvent(
    new CustomEvent<DocumentChangedDetail>(DOCUMENT_CHANGED_EVENT, {
      detail: { id: doc.id, version: doc.version, title: doc.title },
    }),
  );
}
