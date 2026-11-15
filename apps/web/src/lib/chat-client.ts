/**
 * Browser client for the assistant's JSON routes (`/api/chat/threads…`, 6.2/6.3). The chat stream itself goes
 * through the AI SDK transport (`useChat`); this covers threads and proposal decisions, and turns the stream's
 * failures into something the UI can say (429 → "try again in N s").
 */
import { ApiRequestError } from './api-client';
import type { ApiErrorBody } from './api-types';
import type {
  ChatThreadDetail,
  ChatThreadSummary,
  ProposalDecisionInput,
  ProposalDecisionResult,
} from './chat-types';

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

export const chatApi = {
  threads: (workspaceId: string, documentId?: string) =>
    request<{ threads: ChatThreadSummary[] }>(
      'GET',
      `/api/chat/threads?workspaceId=${enc(workspaceId)}${documentId ? `&documentId=${enc(documentId)}` : ''}`,
    ),
  thread: (id: string) => request<ChatThreadDetail>('GET', `/api/chat/threads/${enc(id)}`),
  decide: (threadId: string, proposalId: string, decision: ProposalDecisionInput['decision']) =>
    request<ProposalDecisionResult>(
      'POST',
      `/api/chat/threads/${enc(threadId)}/proposals/${enc(proposalId)}`,
      { decision } satisfies ProposalDecisionInput,
    ),
};

/** What went wrong with a chat request, in words for the panel. */
export type ChatFailure = {
  kind: 'rate_limited' | 'offline' | 'not_found' | 'error';
  message: string;
  /** Seconds until another question is accepted (429). */
  retryAfter?: number;
};

/**
 * Reads an error from `useChat` (the transport throws an `APICallError` carrying the status and the JSON
 * body for non-2xx answers; a stream error arrives as a plain `Error` with the server's message).
 */
export function describeChatError(error: unknown): ChatFailure {
  const e = error as { statusCode?: unknown; responseBody?: unknown; message?: unknown };
  const status = typeof e?.statusCode === 'number' ? e.statusCode : undefined;
  let body: ApiErrorBody | undefined;
  if (typeof e?.responseBody === 'string') {
    try {
      body = JSON.parse(e.responseBody) as ApiErrorBody;
    } catch {
      body = undefined;
    }
  }
  if (status === 429 || body?.error?.code === 'rate_limited') {
    const retryAfter =
      typeof body?.retryAfter === 'number' && body.retryAfter > 0
        ? Math.ceil(body.retryAfter)
        : undefined;
    return {
      kind: 'rate_limited',
      message: retryAfter
        ? `You’ve asked a lot of questions in a short time. Try again in ${formatWait(retryAfter)}.`
        : 'You’ve asked a lot of questions in a short time. Try again in a moment.',
      ...(retryAfter ? { retryAfter } : {}),
    };
  }
  if (status === 404) {
    return { kind: 'not_found', message: 'This conversation or note is no longer available.' };
  }
  if (status === undefined && error instanceof TypeError) {
    return { kind: 'offline', message: 'You’re offline or the server can’t be reached.' };
  }
  const message =
    body?.error?.message ??
    (status === undefined && typeof e?.message === 'string' && e.message.length < 300
      ? e.message
      : undefined);
  return {
    kind: 'error',
    message: message || 'The assistant ran into a problem. Please try again.',
  };
}

/** `42 s`, `2 min`, `3 h`. */
export function formatWait(seconds: number): string {
  if (seconds < 90) return `${seconds} s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}
