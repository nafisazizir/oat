'use client';

import { useEffect, useState } from 'react';

import type { SearchResponse, SearchType } from '@/lib/search';

export type SearchState =
  | { status: 'idle' }
  | { status: 'loading'; query: string; data?: SearchResponse }
  | { status: 'done'; query: string; data: SearchResponse }
  | { status: 'error'; query: string; message: string };

/** Fetches one page of `/api/search` (throws on non-2xx). */
export async function fetchSearch(
  params: { q: string; type: SearchType; workspaceId?: string; limit?: number; cursor?: string },
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const query = new URLSearchParams({ q: params.q, type: params.type });
  if (params.workspaceId) query.set('workspaceId', params.workspaceId);
  if (params.limit) query.set('limit', String(params.limit));
  if (params.cursor) query.set('cursor', params.cursor);
  const res = await fetch(`/api/search?${query.toString()}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  });
  if (!res.ok) throw new Error(`Search failed (${res.status}).`);
  return (await res.json()) as SearchResponse;
}

/**
 * Debounced search-as-you-type: fetches `delay` ms after `query` settles and aborts the previous request.
 * While the next results load, `loading` carries the previous ones (`data`) so the list doesn't flash.
 */
export function useSearch(
  query: string,
  options: {
    type: SearchType;
    workspaceId?: string;
    limit?: number;
    delay?: number;
    /** Bump to fetch again (retry after an error). */
    attempt?: number;
  },
): SearchState {
  const { type, workspaceId, limit, delay = 150, attempt = 0 } = options;
  const q = query.trim();
  const key = JSON.stringify([q, type, workspaceId, limit, attempt]);
  const [result, setResult] = useState<
    { key: string; data: SearchResponse } | { key: string; error: string } | undefined
  >();

  useEffect(() => {
    if (!q) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetchSearch({ q, type, workspaceId, limit }, controller.signal).then(
        (data) => setResult({ key, data }),
        (error: unknown) => {
          if (controller.signal.aborted) return;
          setResult({ key, error: error instanceof Error ? error.message : 'Search failed.' });
        },
      );
    }, delay);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, q, type, workspaceId, limit, delay]);

  if (!q) return { status: 'idle' };
  if (result?.key === key) {
    return 'data' in result
      ? { status: 'done', query: q, data: result.data }
      : { status: 'error', query: q, message: result.error };
  }
  return result && 'data' in result
    ? { status: 'loading', query: q, data: result.data }
    : { status: 'loading', query: q };
}
