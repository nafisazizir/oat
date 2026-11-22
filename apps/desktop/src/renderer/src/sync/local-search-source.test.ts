import { OatApiError, createOatClient, type OatTransport } from '@oat/client';
import type { SearchHitSnapshot } from '@oat/core/bridge';
import { searchSources, serverSearchSource } from '@oat/feature-ui/search';
import { describe, expect, it, vi } from 'vitest';
import { localSearchSource } from './local-search-source.ts';

const hit: SearchHitSnapshot = {
  documentId: 'd1',
  title: 'A <note>',
  kind: 'meeting',
  in: 'note',
  snippet: 'Safe \u0001<hit>\u0002 & more',
  segmentId: null,
  startMs: null,
  updatedAt: '2026-11-21T00:00:00Z',
};
const options = () => ({ signal: new AbortController().signal, workspaceId: 'w' });

describe('localSearchSource', () => {
  it('maps note and transcript snapshots and escapes marker text safely', async () => {
    const query = vi.fn(async () => ({
      hits: [hit, { ...hit, in: 'transcript' as const, segmentId: 's1', startMs: 65000 }],
    }));
    const result = await localSearchSource(query).search('note', options());
    expect(result.notes?.items[0]).toMatchObject({
      id: 'd1',
      workspaceId: 'w',
      titleHtml: 'A &lt;note&gt;',
      snippetHtml: 'Safe <mark>&lt;hit&gt;</mark> &amp; more',
      visibility: 'workspace',
    });
    expect(result.transcripts?.items[0]).toMatchObject({
      id: 's1',
      documentId: 'd1',
      startMs: 65000,
      speakerLabel: 'Transcript',
    });
    expect(query).toHaveBeenCalledWith('note');
  });

  it('supports empty answers, filters, and skips auxiliary pagination', async () => {
    const query = vi.fn(async () => ({ hits: [hit] }));
    expect(
      (await localSearchSource(query).search('note', { ...options(), type: 'transcripts' })).notes,
    ).toBeUndefined();
    expect(
      (await localSearchSource(async () => ({ hits: [] })).search('note', options())).notes?.items,
    ).toEqual([]);
    query.mockClear();
    expect(
      (await localSearchSource(query).search('note', { ...options(), cursor: 'o20' })).notes?.items,
    ).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('keeps local hits when the server is offline and gives server documents priority online', async () => {
    const transport = vi
      .fn<OatTransport>()
      .mockRejectedValueOnce(new OatApiError(0, 'unavailable', 'Offline'))
      .mockResolvedValue({
        status: 200,
        json: async () => ({
          query: 'note',
          notes: { items: [{ id: 'd1', title: 'Server title' }], nextCursor: null },
        }),
      });
    const sources = [
      localSearchSource(async () => ({ hits: [hit] })),
      serverSearchSource(createOatClient(transport)),
    ];
    const offline = await searchSources(sources, 'note', options());
    expect(offline.offline).toBe(true);
    expect(offline.data.notes?.items).toHaveLength(1);
    const online = await searchSources(sources, 'note', options());
    expect(online.offline).toBe(false);
    expect(online.data.notes?.items).toEqual([{ id: 'd1', title: 'Server title' }]);
  });

  it('propagates local errors and ignores an answer completed after cancellation', async () => {
    await expect(
      localSearchSource(async () => {
        throw new Error('Database unavailable');
      }).search('note', options()),
    ).rejects.toThrow('Database unavailable');
    let finish!: (value: { hits: SearchHitSnapshot[] }) => void;
    const controller = new AbortController();
    const result = localSearchSource(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    ).search('note', { signal: controller.signal });
    controller.abort();
    finish({ hits: [hit] });
    await expect(result).rejects.toHaveProperty('name', 'AbortError');
  });
});
