'use client';

import { useEffect, useState } from 'react';

import type { SearchResponse, SearchType } from './helpers';
import { useFeatureUi } from './provider';
import { searchSources } from './sources';

export type SearchState =
  | { status: 'idle' }
  | { status: 'loading'; query: string; data?: SearchResponse; offline?: boolean }
  | { status: 'done'; query: string; data: SearchResponse; offline?: boolean }
  | { status: 'error'; query: string; message: string };

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
  const { searchSources: sources } = useFeatureUi();
  const { type, workspaceId, limit, delay = 150, attempt = 0 } = options;
  const q = query.trim();
  const key = JSON.stringify([q, type, workspaceId, limit, attempt]);
  const [result, setResult] = useState<
    | { key: string; data: SearchResponse; offline?: boolean }
    | { key: string; error: string }
    | undefined
  >();

  useEffect(() => {
    if (!q) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchSources(sources, q, { type, workspaceId, limit, signal: controller.signal }).then(
        ({ data, offline }) => {
          if (!controller.signal.aborted) setResult({ key, data, offline });
        },
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
  }, [key, q, type, workspaceId, limit, delay, sources]);

  if (!q) return { status: 'idle' };
  if (result?.key === key) {
    return 'data' in result
      ? { status: 'done', query: q, data: result.data, offline: result.offline }
      : { status: 'error', query: q, message: result.error };
  }
  return result && 'data' in result
    ? { status: 'loading', query: q, data: result.data }
    : { status: 'loading', query: q };
}
