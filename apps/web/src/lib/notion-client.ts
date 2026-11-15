/**
 * Browser client for the Notion routes (8.1, `src/server/api/notion.ts`). Same-origin fetches with the session
 * cookie; non-2xx answers throw `ApiRequestError` with the server's code and message.
 */
import { ApiRequestError } from './api-client';
import type {
  ApiErrorBody,
  NotionConnectionInfo,
  NotionDocumentStatus,
  NotionPushResult,
  NotionTargetOption,
} from './api-types';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
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
      error?.error.code ?? 'bad_request',
      error?.error.message ?? `Request failed (${res.status}).`,
      error,
    );
  }
  return json as T;
}

const ws = (workspaceId: string) => `workspaceId=${encodeURIComponent(workspaceId)}`;

export const notionApi = {
  status: (documentId: string) =>
    request<NotionDocumentStatus>('GET', `/api/documents/${encodeURIComponent(documentId)}/notion`),
  send: (documentId: string) =>
    request<NotionPushResult>('POST', `/api/documents/${encodeURIComponent(documentId)}/notion`, {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
  search: (workspaceId: string, query: string) =>
    request<NotionTargetOption[]>(
      'GET',
      `/api/integrations/notion/targets?${ws(workspaceId)}&q=${encodeURIComponent(query)}`,
    ),
  setTarget: (workspaceId: string, target: { type: 'page' | 'database'; id: string }) =>
    request<NotionConnectionInfo>('PUT', '/api/integrations/notion/target', {
      workspaceId,
      ...target,
    }),
  disconnect: (workspaceId: string) =>
    request<void>('DELETE', `/api/integrations/notion?${ws(workspaceId)}`),
};

/** Copy for `?notion_error=` after a failed "Connect Notion". */
export function notionConnectErrorMessage(code: string | undefined): string | null {
  switch (code) {
    case undefined:
    case '':
      return null;
    case 'denied':
      return 'Notion wasn’t connected because access wasn’t granted.';
    case 'state':
      return 'That Notion sign-in expired or didn’t start here. Please connect again.';
    case 'not_configured':
      return 'Notion isn’t set up on this server.';
    default:
      return 'We couldn’t connect Notion. Please try again.';
  }
}
