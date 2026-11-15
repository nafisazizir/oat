'use client';

import { ApiRequestError } from '@/lib/api-client';
import type { ApiErrorBody } from '@/lib/api-types';
import type {
  EnhancementDetail,
  EnhancementDto,
  EnhancementVersionList,
  RestoreEnhancementInput,
  RestoreEnhancementResult,
  StartEnhanceInput,
  StartEnhanceResult,
} from '@/lib/enhance';

/** Browser client for the enhance API (`src/lib/enhance.ts`); errors throw `ApiRequestError`. */
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
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

export const enhanceClient = {
  start: (documentId: string, input: StartEnhanceInput) =>
    call<StartEnhanceResult>('POST', `/api/documents/${enc(documentId)}/enhance`, input),
  latest: (documentId: string) =>
    call<{ latest: EnhancementDto | null }>('GET', `/api/documents/${enc(documentId)}/enhance`),
  /** Completed runs of a note, newest first, and whether its body was edited since (4.5). */
  versions: (documentId: string) =>
    call<EnhancementVersionList>('GET', `/api/documents/${enc(documentId)}/enhancements`),
  version: (enhancementId: string) =>
    call<EnhancementDetail>('GET', `/api/enhancements/${enc(enhancementId)}`),
  restore: (enhancementId: string, input: RestoreEnhancementInput) =>
    call<RestoreEnhancementResult>(
      'POST',
      `/api/enhancements/${enc(enhancementId)}/restore`,
      input,
    ),
  /** The run's SSE stream (same-origin cookie auth). */
  stream: (enhancementId: string) =>
    new EventSource(`/api/enhancements/${enc(enhancementId)}/stream`),
};
