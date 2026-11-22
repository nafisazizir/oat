'use client';
import { SearchView as SharedSearchView, searchPageHref } from '@oat/feature-ui/search';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';

export function SearchView() {
  const params = useSearchParams();
  const [query, setQuery] = useState(params.get('q') ?? '');
  const [type, setType] = useState<'notes' | 'transcripts'>(
    params.get('tab') === 'transcripts' ? 'transcripts' : 'notes',
  );
  function update(q: string, tab: 'notes' | 'transcripts') {
    window.history.replaceState(null, '', q.trim() ? searchPageHref(q.trim(), tab) : '/search');
  }
  return (
    <SharedSearchView
      query={query}
      type={type}
      onQueryChange={(q) => {
        setQuery(q);
        update(q, type);
      }}
      onTypeChange={(tab) => {
        setType(tab);
        update(query, tab);
      }}
    />
  );
}
