// @vitest-environment jsdom
import { createOatClient, OatApiError } from '@oat/client';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FeatureUiProvider, type FeatureUiAdapter, type LinkComponent } from './provider';
import { SearchDialog } from './search-dialog';
import { SearchView } from './search-view';
import type { SearchSource } from './sources';
import { useSearch } from './use-search';

const hit = {
  id: 'doc',
  workspaceId: 'w',
  kind: 'page' as const,
  title: 'Found',
  titleHtml: '<mark>Found</mark>',
  snippetHtml: 'Text',
  visibility: 'private' as const,
  updatedAt: '2026-11-21T00:00:00Z',
};
function adapter(sources: SearchSource[]): FeatureUiAdapter {
  const transport = vi.fn(async () => ({ status: 200, json: async () => ({}) }));
  return {
    client: createOatClient(transport),
    transport,
    searchSources: sources,
    navigate: vi.fn(),
    workspaceId: 'w',
    user: { id: 'u', name: 'User', email: 'u@example.com' },
    notify: { success: vi.fn(), error: vi.fn() },
  };
}
const found: SearchSource = {
  id: 'local',
  search: async (q) => ({ query: q, notes: { items: [hit], nextCursor: null } }),
};
function wrap(value: FeatureUiAdapter) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <FeatureUiProvider value={value}>{children}</FeatureUiProvider>;
  };
}

describe('search lifecycle', () => {
  it('does not search blank input and aborts in-flight searches on keystroke and unmount', async () => {
    const signals: AbortSignal[] = [];
    const search = vi.fn((_q: string, { signal }: { signal: AbortSignal }) => {
      signals.push(signal);
      return new Promise<never>(() => {});
    });
    const { rerender, unmount } = renderHook(({ q }) => useSearch(q, { type: 'all', delay: 0 }), {
      initialProps: { q: '' },
      wrapper: wrap(adapter([{ id: 'local', search }])),
    });
    expect(search).not.toHaveBeenCalled();
    rerender({ q: 'one' });
    await waitFor(() => expect(signals).toHaveLength(1));
    rerender({ q: 'two' });
    expect(signals[0]?.aborted).toBe(true);
    await waitFor(() => expect(signals).toHaveLength(2));
    unmount();
    expect(signals[1]?.aborted).toBe(true);
  });

  it('ignores late results from a superseded source', async () => {
    let finish!: (data: { query: string }) => void;
    const source: SearchSource = {
      id: 'local',
      search: (q) =>
        q === 'old'
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : Promise.resolve({ query: q }),
    };
    const { result, rerender } = renderHook(({ q }) => useSearch(q, { type: 'all', delay: 0 }), {
      initialProps: { q: 'old' },
      wrapper: wrap(adapter([source])),
    });
    await waitFor(() => expect(finish).toBeDefined());
    rerender({ q: 'new' });
    await waitFor(() => expect(result.current.status).toBe('done'));
    await act(async () => finish({ query: 'old' }));
    expect(result.current).toMatchObject({ status: 'done', data: { query: 'new' } });
  });
});

describe('SearchDialog', () => {
  it('supports keyboard navigation and selection of host commands', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const close = vi.fn();
    render(
      <SearchDialog
        open
        onOpenChange={close}
        commandGroups={[
          {
            heading: 'Actions',
            items: [
              { value: 'one', text: 'One', icon: null, onSelect: first },
              { value: 'two', text: 'Two', icon: null, onSelect: second },
            ],
          },
        ]}
      />,
      { wrapper: wrap(adapter([found])) },
    );
    const input = screen.getByRole('combobox');
    await userEvent.click(input);
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(false);
  });

  it('searches and navigates to a result, and aborts on close', async () => {
    const value = adapter([found]);
    const { rerender } = render(<SearchDialog open onOpenChange={vi.fn()} />, {
      wrapper: wrap(value),
    });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Found' } });
    await screen.findByTestId('search-result-note');
    await userEvent.keyboard('{Enter}');
    expect(value.navigate).toHaveBeenCalledWith({ kind: 'document', id: 'doc' });
    rerender(<SearchDialog open={false} onOpenChange={vi.fn()} />);
  });

  it('shows an empty response without removing search-all', async () => {
    const value = adapter([
      {
        id: 'server',
        search: async () => ({ query: 'missing', notes: { items: [], nextCursor: null } }),
      },
    ]);
    render(<SearchDialog open onOpenChange={vi.fn()} />, { wrapper: wrap(value) });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'missing' } });
    expect(await screen.findByText('No notes or transcripts match “missing”.')).toBeTruthy();
    expect(screen.getByText('Search all results for “missing”')).toBeTruthy();
  });

  it('shows search errors and keeps search-all available', async () => {
    render(<SearchDialog open onOpenChange={vi.fn()} />, {
      wrapper: wrap(
        adapter([
          {
            id: 'server',
            search: async () => {
              throw new Error('unavailable');
            },
          },
        ]),
      ),
    });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'missing' } });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('Search all results for “missing”')).toBeTruthy();
  });

  it.each(['click', 'keyboard'])(
    'exposes a single native option/link and navigates once on %s',
    async (mode) => {
      const Link: LinkComponent = (props) => <a {...props} data-host-link />;
      const value = { ...adapter([found]), hrefFor: () => '/d/doc', Link };
      render(<SearchDialog open onOpenChange={vi.fn()} />, {
        wrapper: wrap(value),
      });
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Found' } });
      const result = await screen.findByTestId('search-result-note');
      expect(result.getAttribute('href')).toBe('/d/doc');
      expect(result.hasAttribute('data-host-link')).toBe(true);
      expect(result.getAttribute('role')).toBe('option');
      expect(result.querySelector('a')).toBeNull();
      if (mode === 'click') await userEvent.click(result);
      else await userEvent.keyboard('{Enter}');
      expect(value.navigate).toHaveBeenCalledExactlyOnceWith({ kind: 'document', id: 'doc' });
    },
  );
});

describe('SearchView', () => {
  it('renders controlled query/filter changes and real hrefs on the web', async () => {
    const value = { ...adapter([found]), hrefFor: () => '/d/doc' };
    const onTypeChange = vi.fn();
    const onQueryChange = vi.fn();
    render(
      <SearchView
        query="Found"
        type="notes"
        onQueryChange={onQueryChange}
        onTypeChange={onTypeChange}
      />,
      { wrapper: wrap(value) },
    );
    expect((await screen.findByTestId('search-page-note')).getAttribute('href')).toBe('/d/doc');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'changed' } });
    expect(onQueryChange).toHaveBeenCalledWith('changed');
    await userEvent.click(screen.getByRole('tab', { name: /Transcripts/ }));
    expect(onTypeChange).toHaveBeenCalledWith('transcripts');
  });

  it('shows a quiet offline state and navigates natively without an href', async () => {
    const value = adapter([
      {
        id: 'server',
        search: async () => {
          throw new OatApiError(0, 'unavailable', 'offline');
        },
      },
      found,
    ]);
    render(
      <SearchView query="Found" type="notes" onQueryChange={vi.fn()} onTypeChange={vi.fn()} />,
      { wrapper: wrap(value) },
    );
    expect(await screen.findByText('Offline — showing notes on this device')).toBeTruthy();
    const link = screen.getByTestId('search-page-note');
    expect(link.hasAttribute('href')).toBe(false);
    link.focus();
    await userEvent.keyboard('{Enter}');
    expect(value.navigate).toHaveBeenCalledWith({ kind: 'document', id: 'doc' });
  });

  it('renders an empty prompt without searching', () => {
    const search = vi.fn();
    render(<SearchView query="" type="notes" onQueryChange={vi.fn()} onTypeChange={vi.fn()} />, {
      wrapper: wrap(adapter([{ id: 'local', search }])),
    });
    expect(screen.getByText('Search your workspace')).toBeTruthy();
    expect(search).not.toHaveBeenCalled();
  });

  it('offers retry for search errors', async () => {
    const search = vi
      .fn()
      .mockRejectedValueOnce(new Error('broken'))
      .mockResolvedValue({ query: 'Found', notes: { items: [hit], nextCursor: null } });
    render(
      <SearchView query="Found" type="notes" onQueryChange={vi.fn()} onTypeChange={vi.fn()} />,
      { wrapper: wrap(adapter([{ id: 'server', search }])) },
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('search-page-note')).toBeTruthy();
  });

  it('loads the next page with the typed source cursor', async () => {
    const search = vi.fn(async (_q, options) => ({
      query: 'Found',
      notes: {
        items: [{ ...hit, id: options.cursor ? 'next' : 'doc' }],
        nextCursor: options.cursor ? null : 'o20',
      },
    }));
    function View() {
      const [q, setQ] = useState('Found');
      return <SearchView query={q} onQueryChange={setQ} type="notes" onTypeChange={vi.fn()} />;
    }
    render(<View />, { wrapper: wrap(adapter([{ id: 'server', search }])) });
    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getAllByTestId('search-page-note')).toHaveLength(2));
    expect(search).toHaveBeenLastCalledWith(
      'Found',
      expect.objectContaining({ cursor: 'o20', type: 'notes' }),
    );
  });
});
