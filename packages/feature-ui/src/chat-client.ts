import { OatApiError } from '@oat/client';

export function isApiError(error: unknown, code?: string): error is OatApiError {
  return error instanceof OatApiError && (code === undefined || error.code === code);
}

type ApiErrorBody = { error?: { code?: string; message?: string }; retryAfter?: number };

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
  const status =
    error instanceof OatApiError
      ? error.status
      : typeof e?.statusCode === 'number'
        ? e.statusCode
        : undefined;
  let body: ApiErrorBody | undefined =
    error instanceof OatApiError
      ? {
          ...(error.details && typeof error.details === 'object' ? error.details : {}),
          error: { code: error.code, message: error.message },
        }
      : undefined;
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
  if (status === 0 || (status === undefined && error instanceof TypeError)) {
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
