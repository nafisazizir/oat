import { createOatClient, OatApiError } from '@oat/client';
import { describe, expect, it, vi } from 'vitest';
import type { NoteHit, SearchResponse, TranscriptHit } from './helpers';
import {
  mergeSearchPages,
  searchSources,
  serverSearchSource,
  type SearchResult,
  type SearchSource,
} from './sources';

export const note = (id: string, title = id): NoteHit => ({
  id,
  title,
  titleHtml: title,
  snippetHtml: '',
  workspaceId: 'w',
  kind: 'page',
  visibility: 'private',
  updatedAt: '2026-11-21T00:00:00Z',
});
const response = (...notes: NoteHit[]): SearchResponse => ({
  query: 'q',
  notes: { items: notes, nextCursor: null },
});
const local = (...notes: NoteHit[]): SearchSource => ({
  id: 'local',
  search: async () => response(...notes),
});
const options = () => ({ signal: new AbortController().signal });

const page = (data: SearchResponse, serverDocuments: string[] = []): SearchResult => ({
  data,
  offline: false,
  serverDocuments: new Set(serverDocuments),
});
const segment = (id: string, documentId: string): TranscriptHit => ({
  id,
  documentId,
  documentTitle: documentId,
  source: 'mic',
  speakerLabel: null,
  startMs: 0,
  endMs: 1,
  updatedAt: '',
  snippetHtml: id,
});

describe('search pagination', () => {
  it('replaces local documents with later server hits without letting later local hits replace server hits', () => {
    const first = page(response(note('a', 'server A'), note('b', 'local B')), ['a']);
    const next = page(response(note('b', 'server B'), note('a', 'local A')), ['b']);
    const merged = mergeSearchPages(first, next);
    expect(merged.data.notes?.items.map((hit) => hit.title)).toEqual(['server A', 'server B']);
    expect(merged.serverDocuments).toEqual(new Set(['a', 'b']));
  });

  it('claims documents across sections while deduping transcript hits by segment, not document', () => {
    const first = page(
      {
        ...response(note('local'), note('other')),
        transcripts: {
          items: [segment('s1', 'server'), segment('local-seg', 'local')],
          nextCursor: 'o20',
        },
      },
      ['server'],
    );
    const next = page(
      {
        query: 'q',
        transcripts: {
          items: [segment('s1', 'server'), segment('s2', 'server'), segment('s3', 'local')],
          nextCursor: null,
        },
      },
      ['server', 'local'],
    );
    const merged = mergeSearchPages(first, next);
    expect(merged.data.notes?.items.map((hit) => hit.id)).toEqual(['other']);
    expect(merged.data.transcripts?.items.map((hit) => hit.id)).toEqual(['s1', 's2', 's3']);
    expect(merged.data.transcripts?.nextCursor).toBeNull();
    const localAgain = page({
      query: 'q',
      transcripts: {
        items: [segment('local-again', 'server')],
        nextCursor: null,
      },
    });
    expect(mergeSearchPages(merged, localAgain).data.transcripts?.items).toEqual(
      merged.data.transcripts?.items,
    );
  });

  it('keeps existing hits for empty pages, advances only the provided section cursor and accepts no next page', () => {
    const first = page(
      {
        query: 'q',
        notes: { items: [note('a')], nextCursor: 'o20' },
        transcripts: { items: [], nextCursor: 'o40' },
      },
      ['a'],
    );
    expect(mergeSearchPages(first)).toBe(first);
    const merged = mergeSearchPages(first, page(response()));
    expect(merged.data.notes).toEqual({ items: [note('a')], nextCursor: null });
    expect(merged.data.transcripts?.nextCursor).toBe('o40');
  });
});

describe('search sources', () => {
  it('uses the typed client and forwards query options and cancellation', async () => {
    const transport = vi.fn(async () => ({ status: 200, json: async () => response(note('a')) }));
    const source = serverSearchSource(createOatClient(transport));
    const signal = options().signal;
    expect(
      await source.search('q', { signal, workspaceId: 'w', type: 'notes', limit: 5, cursor: 'o5' }),
    ).toEqual(response(note('a')));
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/search',
        query: { q: 'q', workspaceId: 'w', type: 'notes', limit: 5, cursor: 'o5' },
        signal,
      }),
    );
  });

  it('merges and dedupes by document with server priority regardless of source order', async () => {
    const server: SearchSource = {
      id: 'server',
      search: async () => ({
        ...response(note('a', 'server')),
        transcripts: {
          items: [
            {
              id: 'seg',
              documentId: 'b',
              documentTitle: 'B',
              source: 'mic',
              speakerLabel: null,
              startMs: 0,
              endMs: 1,
              updatedAt: '',
              snippetHtml: 'B',
            },
          ],
          nextCursor: null,
        },
      }),
    };
    const result = await searchSources(
      [local(note('a', 'local'), note('b'), note('c')), server],
      'q',
      options(),
    );
    expect(result.data.notes?.items.map((hit) => hit.title)).toEqual(['server', 'c']);
    expect(result.data.transcripts?.items).toHaveLength(1);
    expect(result.offline).toBe(false);
  });

  it('keeps local results and reports offline only on transport failure', async () => {
    const server = serverSearchSource(
      createOatClient(async () => {
        throw new TypeError('offline');
      }),
    );
    const result = await searchSources([server, local(note('a'))], 'q', options());
    expect(result.offline).toBe(true);
    expect(result.data.notes?.items).toEqual([note('a')]);
  });

  it.each([401, 403, 500])('does not hide HTTP %s errors behind local data', async (status) => {
    const server = serverSearchSource(
      createOatClient(async () => ({ status, json: async () => ({}) })),
    );
    await expect(searchSources([server, local(note('a'))], 'q', options())).rejects.toMatchObject({
      status,
    });
  });

  it('handles empty answers and surfaces all-source failures or missing sources', async () => {
    expect((await searchSources([local()], 'q', options())).data.notes?.items).toEqual([]);
    await expect(searchSources([], 'q', options())).rejects.toThrow('No search sources');
    await expect(
      searchSources(
        [
          {
            id: 'local',
            search: async () => {
              throw new Error('disk');
            },
          },
        ],
        'q',
        options(),
      ),
    ).rejects.toThrow('disk');
  });

  it('rejects cancelled results even if the source ignores cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      searchSources([local(note('a'))], 'q', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not report a local-only configuration as offline', async () => {
    expect((await searchSources([local()], 'q', options())).offline).toBe(false);
    expect(new OatApiError(0, 'unavailable', 'offline').status).toBe(0);
  });
});
