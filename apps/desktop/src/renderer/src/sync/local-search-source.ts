import type { SearchHitSnapshot } from '@oat/core/bridge';
import type { SearchResponse, SearchSource } from '@oat/feature-ui/search';
import { call } from '../bridge.ts';
import { snippetParts } from './search-text.ts';

const escape = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const highlight = (snippet: string) =>
  snippetParts(snippet)
    .map((part) => (part.hit ? `<mark>${escape(part.text)}</mark>` : escape(part.text)))
    .join('');

export function localSearchSource(
  query: (q: string) => Promise<{ hits: SearchHitSnapshot[] }> = (q) =>
    call('search:query', { query: q }),
): SearchSource {
  return {
    id: 'local',
    async search(q, { signal, type = 'all', workspaceId = '', cursor }) {
      signal.throwIfAborted();
      const data: SearchResponse = {
        query: q,
        ...(type !== 'transcripts' ? { notes: { items: [], nextCursor: null } } : {}),
        ...(type !== 'notes' ? { transcripts: { items: [], nextCursor: null } } : {}),
      };
      if (cursor) return data;
      const { hits } = await query(q);
      signal.throwIfAborted();
      for (const hit of hits) {
        if (hit.in === 'note')
          data.notes?.items.push({
            id: hit.documentId,
            workspaceId,
            kind: hit.kind,
            title: hit.title,
            visibility: 'workspace',
            updatedAt: hit.updatedAt,
            titleHtml: escape(hit.title),
            snippetHtml: highlight(hit.snippet),
          });
        else if (hit.segmentId && hit.startMs !== null)
          data.transcripts?.items.push({
            id: hit.segmentId,
            documentId: hit.documentId,
            documentTitle: hit.title,
            source: 'system',
            speakerLabel: 'Transcript',
            startMs: hit.startMs,
            endMs: hit.startMs,
            updatedAt: hit.updatedAt,
            snippetHtml: highlight(hit.snippet),
          });
      }
      return data;
    },
  };
}
