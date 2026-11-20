import type { SearchHitSnapshot } from '@oat/core/bridge';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@oat/ui/components/input-group';
import { IconFileText, IconNotes, IconSearch } from '@tabler/icons-react';
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
      <InputGroup size="sm">
        <InputGroupAddon>
          <IconSearch aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          value={query}
          placeholder="Search notes and transcripts"
          aria-label="Search notes and transcripts on this Mac"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('');
          }}
        />
      </InputGroup>
      {hits !== null && (
        <ul
          className="flex max-h-72 flex-col gap-0.5 overflow-auto"
          data-testid="local-search-results"
          aria-label="Search results"
        >
          {hits.length === 0 ? (
            <li className="px-2.5 py-1.5 text-copy-13 text-gray-900">
              Nothing on this Mac matches.
            </li>
          ) : (
            hits.map((hit) => (
              <li key={`${hit.documentId}:${hit.segmentId ?? 'note'}`}>
                <SearchResult hit={hit} {...(onOpen && hit.kind === 'meeting' ? { onOpen } : {})} />
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
  const Icon = hit.kind === 'meeting' ? IconNotes : IconFileText;
  const content = (
    <>
      <span className="flex items-center gap-2">
        <Icon aria-hidden className="size-4 shrink-0 text-gray-900" />
        <span className="truncate text-label-14 text-gray-1000">{hit.title || 'Untitled'}</span>
        {hit.in === 'transcript' && hit.startMs !== null && (
          <span className="ms-auto shrink-0 text-label-12 text-gray-900">
            Transcript · {clock(hit.startMs)}
          </span>
        )}
      </span>
      <span className="line-clamp-2 ps-6 text-copy-13 text-gray-900" data-testid="search-snippet">
        {snippetParts(hit.snippet).map((part, i) =>
          part.hit ? (
            <mark key={i} className="rounded-sm bg-brand-200 px-0.5 text-gray-1000">
              {part.text}
            </mark>
          ) : (
            <span key={i}>{part.text}</span>
          ),
        )}
      </span>
    </>
  );
  const className = 'flex w-full flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-start';
  return onOpen ? (
    <button
      type="button"
      className={`${className} transition-colors outline-none hover:bg-gray-alpha-100 focus-visible:ring-3 focus-visible:ring-gray-600/50 active:bg-gray-alpha-200`}
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
