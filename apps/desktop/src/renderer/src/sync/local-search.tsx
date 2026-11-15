import type { SearchHitSnapshot } from '@oat/core/bridge';
import { Input } from '@oat/ui/components/input';
import { FileTextIcon, NotebookPenIcon, SearchIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { call } from '../bridge.ts';
import { clock, snippetParts } from './search-text.ts';

/**
 * Sidebar search over this Mac's copy of notes and transcripts (3.5; SQLite FTS5 in `@oat/local-store`):
 * works offline, and re-runs after every sync (`refreshKey`), so a note edited elsewhere shows up as soon
 * as it arrives. `onOpen` opens a hit (wired by the notes view); without it the hits are read-only.
 */
export function LocalSearch({
  refreshKey,
  onOpen,
}: {
  refreshKey: number | null;
  onOpen?: (hit: SearchHitSnapshot) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ query: string; hits: SearchHitSnapshot[] } | null>(null);
  const q = query.trim();
  const searchable = [...q].length >= 3;

  useEffect(() => {
    if (!searchable) return;
    let live = true;
    const timer = setTimeout(() => {
      void call('search:query', { query: q })
        .then((r) => live && setResults({ query: q, hits: r.hits }))
        .catch(() => live && setResults({ query: q, hits: [] }));
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, searchable, refreshKey]);
  // Results of an older query stay up while the new one runs; nothing under 3 characters.
  const hits = searchable && results ? results.hits : null;

  return (
    <div className="flex min-h-0 flex-col gap-2" data-testid="local-search">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={query}
          placeholder="Search notes and transcripts"
          aria-label="Search notes and transcripts on this Mac"
          className="h-8 pl-8 text-sm"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('');
          }}
        />
      </div>
      {hits !== null && (
        <ul
          className="flex max-h-72 flex-col gap-0.5 overflow-auto"
          data-testid="local-search-results"
          aria-label="Search results"
        >
          {hits.length === 0 ? (
            <li className="px-2 py-1.5 text-xs text-muted-foreground">
              Nothing on this Mac matches.
            </li>
          ) : (
            hits.map((hit) => (
              <li key={`${hit.documentId}:${hit.segmentId ?? 'note'}`}>
                <SearchResult hit={hit} {...(onOpen ? { onOpen } : {})} />
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

function SearchResult({
  hit,
  onOpen,
}: {
  hit: SearchHitSnapshot;
  onOpen?: (hit: SearchHitSnapshot) => void;
}) {
  const Icon = hit.kind === 'meeting' ? NotebookPenIcon : FileTextIcon;
  const content = (
    <>
      <span className="flex items-center gap-1.5 text-sm">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">{hit.title || 'Untitled'}</span>
        {hit.in === 'transcript' && hit.startMs !== null && (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            Transcript · {clock(hit.startMs)}
          </span>
        )}
      </span>
      <span className="line-clamp-2 text-xs text-muted-foreground" data-testid="search-snippet">
        {snippetParts(hit.snippet).map((part, i) =>
          part.hit ? (
            <mark key={i} className="rounded-sm bg-accent px-0.5 text-accent-foreground">
              {part.text}
            </mark>
          ) : (
            <span key={i}>{part.text}</span>
          ),
        )}
      </span>
    </>
  );
  const className = 'flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left';
  return onOpen ? (
    <button
      type="button"
      className={`${className} hover:bg-accent focus-visible:bg-accent focus-visible:outline-none`}
      onClick={() => onOpen(hit)}
    >
      {content}
    </button>
  ) : (
    <div className={className} data-selectable>
      {content}
    </div>
  );
}
