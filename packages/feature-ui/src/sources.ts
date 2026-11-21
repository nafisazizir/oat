import { OatApiError, type OatClient } from '@oat/client';
import type { SearchResponse, SearchType } from './helpers';

export type SearchOptions = {
  signal: AbortSignal;
  type?: SearchType;
  workspaceId?: string;
  limit?: number;
  cursor?: string;
};

export type SearchSource = {
  id: string;
  search(q: string, options: SearchOptions): Promise<SearchResponse>;
};

export function serverSearchSource(client: OatClient): SearchSource {
  return {
    id: 'server',
    search: (q, { signal, ...options }) => client.search({ q, ...options }, { signal }),
  };
}

export async function searchSources(sources: SearchSource[], q: string, options: SearchOptions) {
  const results = await Promise.allSettled(sources.map((source) => source.search(q, options)));
  options.signal.throwIfAborted();
  const server = sources.findIndex((source) => source.id === 'server');
  const serverResult = results[server];
  // Authorization and server errors must not silently turn into local search.
  if (
    serverResult?.status === 'rejected' &&
    !(serverResult.reason instanceof OatApiError && serverResult.reason.status === 0)
  ) {
    throw serverResult.reason;
  }
  const answered = results.flatMap((result, index) =>
    result.status === 'fulfilled' ? [{ index, data: result.value }] : [],
  );
  if (!answered.length)
    throw results.find((r) => r.status === 'rejected')?.reason ?? new Error('No search sources.');
  answered.sort((a, b) => Number(b.index === server) - Number(a.index === server));
  const data: SearchResponse = { query: q };
  const documents = new Set<string>();
  for (const answer of answered) {
    const claimed = new Set<string>();
    if (answer.data.notes) {
      data.notes ??= { items: [], nextCursor: null };
      data.notes.items.push(
        ...answer.data.notes.items.filter((hit) => {
          claimed.add(hit.id);
          return !documents.has(hit.id);
        }),
      );
      if (answer.index === server) data.notes.nextCursor = answer.data.notes.nextCursor;
    }
    if (answer.data.transcripts) {
      data.transcripts ??= { items: [], nextCursor: null };
      data.transcripts.items.push(
        ...answer.data.transcripts.items.filter((hit) => {
          claimed.add(hit.documentId);
          return !documents.has(hit.documentId);
        }),
      );
      if (answer.index === server) data.transcripts.nextCursor = answer.data.transcripts.nextCursor;
    }
    for (const id of claimed) documents.add(id);
  }
  return { data, offline: serverResult?.status === 'rejected' || false };
}
