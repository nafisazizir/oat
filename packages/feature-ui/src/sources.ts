import { OatApiError, type OatClient } from '@oat/client';
import type { SearchResponse, SearchSection, SearchType } from './helpers';

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

export type SearchResult = {
  data: SearchResponse;
  offline: boolean;
  serverDocuments: ReadonlySet<string>;
};

export function mergeSearchPages(first: SearchResult, next?: SearchResult): SearchResult {
  if (!next) return first;
  const serverDocuments = new Set([...first.serverDocuments, ...next.serverDocuments]);
  function merge<T extends { id: string }>(
    before: SearchSection<T> | undefined,
    after: SearchSection<T> | undefined,
    documentId: (hit: T) => string,
  ): SearchSection<T> | undefined {
    if (!before && !after) return undefined;
    const items = new Map<string, T>();
    for (const [result, section] of [
      [first, before],
      [next!, after],
    ] as const) {
      for (const hit of section?.items ?? []) {
        const id = documentId(hit);
        if (serverDocuments.has(id) && !result.serverDocuments.has(id)) continue;
        items.set(hit.id, hit);
      }
    }
    return {
      items: [...items.values()],
      nextCursor: after ? after.nextCursor : (before?.nextCursor ?? null),
    };
  }
  const notes = merge(first.data.notes, next.data.notes, (hit) => hit.id);
  const transcripts = merge(first.data.transcripts, next.data.transcripts, (hit) => hit.documentId);
  return {
    data: {
      query: first.data.query,
      ...(notes && { notes }),
      ...(transcripts && { transcripts }),
    },
    offline: first.offline && next.offline,
    serverDocuments,
  };
}

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
  const serverDocuments = new Set<string>();
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
    for (const id of claimed) {
      documents.add(id);
      if (answer.index === server) serverDocuments.add(id);
    }
  }
  return { data, offline: serverResult?.status === 'rejected' || false, serverDocuments };
}
