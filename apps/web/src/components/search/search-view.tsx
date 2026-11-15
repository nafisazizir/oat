'use client';

import { Button } from '@oat/ui/components/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@oat/ui/components/input-group';
import { Skeleton } from '@oat/ui/components/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@oat/ui/components/tabs';
import {
  AudioLinesIcon,
  FileTextIcon,
  LoaderCircleIcon,
  NotebookPenIcon,
  SearchIcon,
  SearchXIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { EmptyState } from '@/components/page';
import { formatDay } from '@/lib/format';
import {
  formatTimestamp,
  type NoteHit,
  searchPageHref,
  type SearchResponse,
  type SearchSection,
  type TranscriptHit,
  transcriptHref,
} from '@/lib/search';

import { Highlight } from './highlight';
import { fetchSearch, useSearch } from './use-search';

type Tab = 'notes' | 'transcripts';
const PAGE = 20;

const rowClass =
  'flex gap-3 px-4 py-3 transition-colors duration-fast hover:bg-accent focus-visible:bg-accent focus-visible:outline-none';

function NoteRow({ hit }: { hit: NoteHit }) {
  const Icon = hit.kind === 'meeting' ? NotebookPenIcon : FileTextIcon;
  return (
    <li>
      <Link href={`/d/${hit.id}`} className={rowClass} data-testid="search-page-note">
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-baseline gap-3">
            <Highlight
              className="min-w-0 flex-1 truncate font-medium"
              html={hit.title ? hit.titleHtml : 'Untitled'}
            />
            <span className="shrink-0 text-xs text-muted-foreground">
              {hit.visibility === 'private' ? 'Private' : 'Shared'} · {formatDay(hit.updatedAt)}
            </span>
          </div>
          {hit.snippetHtml && (
            <Highlight
              className="line-clamp-2 text-sm text-muted-foreground"
              html={hit.snippetHtml}
            />
          )}
        </div>
      </Link>
    </li>
  );
}

function TranscriptRow({ hit }: { hit: TranscriptHit }) {
  const speaker = hit.speakerLabel ?? (hit.source === 'mic' ? 'Me' : 'Them');
  return (
    <li>
      <Link href={transcriptHref(hit)} className={rowClass} data-testid="search-page-transcript">
        <AudioLinesIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-baseline gap-3">
            <span className="min-w-0 flex-1 truncate font-medium">
              {hit.documentTitle || 'Untitled'}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatDay(hit.updatedAt)}
            </span>
          </div>
          <p className="flex gap-2 text-sm">
            <span className="shrink-0 font-mono text-xs leading-5 text-muted-foreground tabular-nums">
              {formatTimestamp(hit.startMs)}
            </span>
            <span className="shrink-0 text-muted-foreground">{speaker}</span>
            <Highlight className="line-clamp-2 min-w-0" html={hit.snippetHtml} />
          </p>
        </div>
      </Link>
    </li>
  );
}

function ResultsSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="Searching">
      {[0, 1, 2, 3].map((row) => (
        <Skeleton key={row} className="h-16 w-full rounded-lg" />
      ))}
    </div>
  );
}

type Extra = {
  for?: SearchResponse;
  notes?: SearchSection<NoteHit>;
  transcripts?: SearchSection<TranscriptHit>;
};

/** `first` followed by `next`; the cursor is the last page's. */
function concat<T>(first?: SearchSection<T>, next?: SearchSection<T>): SearchSection<T> {
  return {
    items: [...(first?.items ?? []), ...(next?.items ?? [])],
    nextCursor: next ? next.nextCursor : (first?.nextCursor ?? null),
  };
}

const countLabel = (section?: SearchSection<unknown>) =>
  section ? `${section.items.length}${section.nextCursor ? '+' : ''}` : '';

/**
 * `/search`: a query box, Notes / Transcripts tabs over `/api/search` (active workspace), "Load more"
 * pages. The query and tab live in the URL (`?q=&tab=`), updated in place without a navigation.
 */
export function SearchView({ workspaceId }: { workspaceId: string }) {
  const params = useSearchParams();
  const [query, setQuery] = useState(params.get('q') ?? '');
  const [tab, setTab] = useState<Tab>(
    params.get('tab') === 'transcripts' ? 'transcripts' : 'notes',
  );
  const [attempt, setAttempt] = useState(0);
  const search = useSearch(query, { type: 'all', workspaceId, limit: PAGE, attempt });
  // "Load more" pages per tab, kept only while the first page they continue is on screen.
  const [more, setMore] = useState<Extra>({});
  const [loadingMore, setLoadingMore] = useState(false);

  const data = search.status === 'done' || search.status === 'loading' ? search.data : undefined;
  const extra: Extra = more.for === data ? more : { for: data };
  const notes = concat(data?.notes, extra.notes);
  const transcripts = concat(data?.transcripts, extra.transcripts);

  function syncUrl(nextQuery: string, nextTab: Tab) {
    const href = nextQuery.trim() ? searchPageHref(nextQuery.trim(), nextTab) : '/search';
    window.history.replaceState(null, '', href);
  }

  async function loadMore(which: Tab) {
    const cursor = (which === 'notes' ? notes : transcripts).nextCursor;
    if (!cursor || !data) return;
    setLoadingMore(true);
    try {
      const page = await fetchSearch({
        q: data.query,
        type: which,
        workspaceId,
        limit: PAGE,
        cursor,
      });
      setMore(
        which === 'notes'
          ? { ...extra, for: data, notes: concat(extra.notes, page.notes) }
          : { ...extra, for: data, transcripts: concat(extra.transcripts, page.transcripts) },
      );
    } catch {
      toast.error('Couldn’t load more results.');
    } finally {
      setLoadingMore(false);
    }
  }

  const q = query.trim();
  const pending = search.status === 'loading';

  return (
    <div className="flex flex-col gap-6">
      <form
        role="search"
        onSubmit={(event) => event.preventDefault()}
        className="flex flex-col gap-2"
      >
        <InputGroup className="h-11 rounded-xl bg-card shadow-xs">
          <InputGroupInput
            autoFocus
            type="search"
            aria-label="Search notes and transcripts"
            placeholder="Search notes and transcripts…"
            value={query}
            maxLength={200}
            onChange={(event) => {
              setQuery(event.target.value);
              syncUrl(event.target.value, tab);
            }}
            className="text-base"
          />
          <InputGroupAddon>
            {pending ? (
              <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
            ) : (
              <SearchIcon />
            )}
          </InputGroupAddon>
        </InputGroup>
        <p className="text-xs text-muted-foreground">
          Use quotes for an exact phrase, <span className="font-mono">-word</span> to exclude, and{' '}
          <span className="font-mono">or</span> for either.
        </p>
      </form>

      {!q ? (
        <EmptyState
          icon={SearchIcon}
          title="Search your workspace"
          description="Find notes by title or content, and the moment something was said in a meeting."
        />
      ) : search.status === 'error' ? (
        <EmptyState
          icon={SearchXIcon}
          title="Search isn’t available right now"
          description="Check your connection and try again."
        >
          <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        </EmptyState>
      ) : (
        <Tabs
          value={tab}
          onValueChange={(value) => {
            setTab(value as Tab);
            syncUrl(query, value as Tab);
          }}
          className="gap-4"
        >
          <TabsList>
            <TabsTrigger value="notes">
              Notes
              {data && <span className="text-xs text-muted-foreground">{countLabel(notes)}</span>}
            </TabsTrigger>
            <TabsTrigger value="transcripts">
              Transcripts
              {data && (
                <span className="text-xs text-muted-foreground">{countLabel(transcripts)}</span>
              )}
            </TabsTrigger>
          </TabsList>
          {(['notes', 'transcripts'] as const).map((which) => {
            const section = which === 'notes' ? notes : transcripts;
            return (
              <TabsContent key={which} value={which} className="flex flex-col gap-4">
                {!data ? (
                  <ResultsSkeleton />
                ) : section.items.length === 0 ? (
                  pending ? (
                    <ResultsSkeleton />
                  ) : (
                    <EmptyState
                      icon={SearchXIcon}
                      title={
                        which === 'notes'
                          ? `No notes match “${q}”`
                          : `No transcript lines match “${q}”`
                      }
                      description="Try fewer or different words, or check the other tab."
                    />
                  )
                ) : (
                  <>
                    <ul
                      aria-busy={pending}
                      className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card shadow-xs transition-opacity duration-fast aria-busy:opacity-60"
                    >
                      {which === 'notes'
                        ? notes.items.map((hit) => <NoteRow key={hit.id} hit={hit} />)
                        : transcripts.items.map((hit) => <TranscriptRow key={hit.id} hit={hit} />)}
                    </ul>
                    {section.nextCursor && (
                      <Button
                        variant="outline"
                        className="self-center"
                        disabled={loadingMore || pending}
                        onClick={() => void loadMore(which)}
                      >
                        {loadingMore ? 'Loading…' : 'Load more'}
                      </Button>
                    )}
                  </>
                )}
              </TabsContent>
            );
          })}
        </Tabs>
      )}
    </div>
  );
}
