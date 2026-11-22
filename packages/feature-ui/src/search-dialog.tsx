'use client';

import {
  Command,
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@oat/ui/components/command';
import { defaultFilter } from 'cmdk';
import { Spinner } from '@oat/ui/components/spinner';
import { matchesAppShortcut } from '@oat/ui/hooks/use-app-shortcut';
import { IconCheck, IconFileText, IconNotes, IconSearch, IconWaveSine } from '@tabler/icons-react';
import { useCallback, useState, type ComponentProps } from 'react';

import { formatTimestamp } from './helpers';
import { Highlight } from './highlight';
import { useSearch } from './use-search';
import { type AppTarget, useFeatureUi } from './provider';

function SearchResultItem({
  target,
  onSelect,
  children,
  ...props
}: ComponentProps<typeof CommandItem> & { target: AppTarget }) {
  const { hrefFor, Link = 'a' } = useFeatureUi();
  const href = hrefFor?.(target);
  if (!href)
    return (
      <CommandItem {...props} onSelect={onSelect}>
        {children}
      </CommandItem>
    );
  return (
    <CommandItem {...props} onSelect={onSelect} asChild>
      <Link
        href={href}
        onClickCapture={(event) => {
          event.stopPropagation();
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          onSelect?.(props.value ?? '');
        }}
      >
        {children}
      </Link>
    </CommandItem>
  );
}

/** A local (client-side) palette entry: sections, the tree's pages and folders, commands. */
type LocalItem = {
  value: string;
  documentId?: string;
  /** What the query is matched against. */
  text: string;
  icon: React.ReactNode;
  onSelect: () => void;
  shortcut?: string;
  checked?: boolean;
};
export type SearchCommandGroup = { heading: string; items: LocalItem[] };

/**
 * Local matches scoring above this (cmdk's fuzzy score, 0..1) are listed *before* the server results, so
 * "settings" + Enter still opens Settings; weaker fuzzy matches go below them.
 */
const STRONG_MATCH = 0.5;
const PALETTE_LIMIT = 5;

/** Filters and orders local groups for `q` (cmdk's own filtering is off: server results come ranked). */
function rankLocal(groups: SearchCommandGroup[], q: string) {
  if (!q) return { strong: groups, weak: [] as SearchCommandGroup[] };
  const strong: SearchCommandGroup[] = [];
  const weak: SearchCommandGroup[] = [];
  for (const group of groups) {
    const scored = group.items
      .map((item) => ({ item, score: defaultFilter(item.text, q) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);
    if (scored.length === 0) continue;
    const ranked = { heading: group.heading, items: scored.map((entry) => entry.item) };
    (scored[0]!.score > STRONG_MATCH ? strong : weak).push(ranked);
  }
  return { strong, weak };
}

function LocalGroups({ groups }: { groups: SearchCommandGroup[] }) {
  return groups.map((group) => (
    <CommandGroup key={group.heading} heading={group.heading}>
      {group.items.map((item) => (
        <CommandItem
          key={item.value}
          value={item.value}
          onSelect={item.onSelect}
          {...(item.checked !== undefined ? { 'data-checked': item.checked } : {})}
        >
          {item.icon}
          {item.text}
          {item.checked && <IconCheck aria-label="Selected" className="ms-auto size-4" />}
          {item.shortcut && <CommandShortcut>{item.shortcut}</CommandShortcut>}
        </CommandItem>
      ))}
    </CommandGroup>
  ));
}

export function SearchDialog({
  open,
  onOpenChange: setOpen,
  commandGroups = [],
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  commandGroups?: SearchCommandGroup[];
}) {
  const { workspaceId, navigate } = useFeatureUi();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');
  const q = query.trim();
  const search = useSearch(open ? query : '', {
    type: 'all',
    workspaceId,
    limit: PALETTE_LIMIT,
  });
  const data = search.status === 'done' || search.status === 'loading' ? search.data : undefined;
  const notes = q ? (data?.notes?.items ?? []) : [];
  const transcripts = q ? (data?.transcripts?.items ?? []) : [];

  const onOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) setQuery('');
    },
    [setOpen],
  );

  const run = useCallback(
    (action: () => void) => () => {
      onOpenChange(false);
      action();
    },
    [onOpenChange],
  );

  const resultIds = new Set(notes.map((hit) => hit.id));
  const local = commandGroups.map((group) => ({
    ...group,
    items: group.items
      .filter((item) => !item.documentId || !resultIds.has(item.documentId))
      .map((item) => ({ ...item, onSelect: run(item.onSelect) })),
  }));
  const { strong, weak } = rankLocal(local, q);

  // The item Enter would open: the first one in render order.
  const firstValue = q
    ? (strong[0]?.items[0]?.value ??
      (notes[0] && `result:note:${notes[0].id}`) ??
      (transcripts[0] && `result:segment:${transcripts[0].id}`) ??
      'result:all')
    : (strong[0]?.items[0]?.value ?? '');
  // Put the cursor on the top item whenever the query or the (fresh) results change. Adjusted while
  // rendering, not in an effect, so the first paint already shows it.
  const fresh = search.status === 'done' ? search.data : undefined;
  const [selectionFor, setSelectionFor] = useState<{ q: string; data: unknown }>({
    q: '',
    data: undefined,
  });
  if (selectionFor.q !== q || selectionFor.data !== fresh) {
    setSelectionFor({ q, data: fresh });
    setSelected(firstValue);
  }

  const searching = search.status === 'loading' && !data;
  const noMatches = search.status === 'done' && notes.length === 0 && transcripts.length === 0;

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Search notes and transcripts, jump to a page or run a command"
      className="sm:max-w-xl"
    >
      <Command
        shouldFilter={false}
        value={selected}
        onValueChange={setSelected}
        onKeyDown={(event) => {
          if (!matchesAppShortcut(event.nativeEvent, 'palette')) return;
          event.preventDefault();
          onOpenChange(false);
        }}
      >
        <CommandInput
          placeholder="Search notes, transcripts and commands…"
          value={query}
          onValueChange={setQuery}
        />
        <CommandList className="max-h-[min(28rem,60vh)]">
          {!q ? (
            <>
              <LocalGroups groups={local.slice(0, 2)} />
              <CommandSeparator />
              <LocalGroups groups={local.slice(2)} />
            </>
          ) : (
            <>
              {'offline' in search && search.offline && (
                <p role="status" className="px-3 py-2 text-copy-13 text-gray-900">
                  Offline — showing notes on this device
                </p>
              )}
              <LocalGroups groups={strong} />
              {notes.length > 0 && (
                <CommandGroup heading="Notes">
                  {notes.map((hit) => (
                    <SearchResultItem
                      target={{ kind: 'document', id: hit.id }}
                      key={hit.id}
                      value={`result:note:${hit.id}`}
                      onSelect={run(() => navigate({ kind: 'document', id: hit.id }))}
                      className="items-start"
                      data-testid="search-result-note"
                    >
                      {hit.kind === 'meeting' ? (
                        <IconNotes className="mt-0.5" />
                      ) : (
                        <IconFileText className="mt-0.5" />
                      )}
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <Highlight
                          className="truncate text-label-14 text-gray-1000"
                          html={hit.title ? hit.titleHtml : 'Untitled'}
                        />
                        {hit.snippetHtml && (
                          <Highlight
                            className="line-clamp-1 text-copy-13 text-gray-900"
                            html={hit.snippetHtml}
                          />
                        )}
                      </div>
                    </SearchResultItem>
                  ))}
                </CommandGroup>
              )}
              {transcripts.length > 0 && (
                <CommandGroup heading="Transcripts">
                  {transcripts.map((hit) => (
                    <SearchResultItem
                      target={{
                        kind: 'document',
                        id: hit.documentId,
                        timeMs: hit.startMs,
                      }}
                      key={hit.id}
                      value={`result:segment:${hit.id}`}
                      onSelect={run(() =>
                        navigate({
                          kind: 'document',
                          id: hit.documentId,
                          timeMs: hit.startMs,
                        }),
                      )}
                      className="items-start"
                      data-testid="search-result-transcript"
                    >
                      <IconWaveSine className="mt-0.5" />
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <Highlight className="line-clamp-2 text-copy-14" html={hit.snippetHtml} />
                        <span className="truncate text-label-12 text-gray-900">
                          {hit.documentTitle || 'Untitled'}
                        </span>
                      </div>
                      <span className="mt-0.5 shrink-0 text-label-12-mono text-gray-900 tabular-nums">
                        {formatTimestamp(hit.startMs)}
                      </span>
                    </SearchResultItem>
                  ))}
                </CommandGroup>
              )}
              <CommandGroup heading={notes.length || transcripts.length ? undefined : 'Search'}>
                {searching && (
                  <div
                    role="status"
                    className="flex items-center gap-2 px-2 py-1.5 text-label-14 text-gray-900"
                  >
                    <Spinner />
                    Searching…
                  </div>
                )}
                {noMatches && (
                  <p className="px-2 py-1.5 text-copy-14 text-gray-900">
                    No notes or transcripts match “{q}”.
                  </p>
                )}
                {search.status === 'error' && (
                  <p role="alert" className="px-2 py-1.5 text-copy-14 text-red-900">
                    Search isn’t available right now.
                  </p>
                )}
                <SearchResultItem
                  target={{ kind: 'search', q }}
                  value="result:all"
                  onSelect={run(() => navigate({ kind: 'search', q }))}
                >
                  <IconSearch />
                  <span className="truncate">Search all results for “{q}”</span>
                </SearchResultItem>
              </CommandGroup>
              <LocalGroups groups={weak} />
            </>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
