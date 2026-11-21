'use client';

import { Button } from '@oat/ui/components/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@oat/ui/components/empty';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@oat/ui/components/input-group';
import { Skeleton } from '@oat/ui/components/skeleton';
import { Spinner } from '@oat/ui/components/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@oat/ui/components/tabs';
import {
  IconFileText,
  IconNotes,
  IconSearch,
  IconSearchOff,
  IconWaveSine,
  type Icon,
} from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';

import { formatDay } from './format';
import {
  formatTimestamp,
  type NoteHit,
  type SearchResponse,
  type SearchSection,
  type TranscriptHit,
} from './helpers';

import { Highlight } from './highlight';
import { useSearch } from './use-search';
import { TargetLink, useFeatureUi } from './provider';
import { searchSources } from './sources';

type Tab = 'notes' | 'transcripts';
const PAGE = 20;

const rowClass =
  'flex gap-3 px-4 py-3 outline-none transition-colors duration-100 hover:bg-gray-alpha-100 focus-visible:bg-gray-alpha-100 focus-visible:ring-3 focus-visible:ring-gray-600/50 focus-visible:ring-inset';
const listClass =
  'flex flex-col divide-y divide-gray-alpha-400 overflow-hidden rounded-xl border border-gray-alpha-400';

function NoteRow({ hit }: { hit: NoteHit }) {
  const RowIcon = hit.kind === 'meeting' ? IconNotes : IconFileText;
  return (
    <li>
      <TargetLink
        target={{ kind: 'document', id: hit.id }}
        className={rowClass}
        data-testid="search-page-note"
      >
        <RowIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-gray-900" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-baseline gap-3">
            <Highlight
              className="min-w-0 flex-1 truncate text-label-14 text-gray-1000"
              html={hit.title ? hit.titleHtml : 'Untitled'}
            />
            <span className="shrink-0 text-copy-13 text-gray-900 tabular-nums">
              {hit.visibility === 'private' ? 'Private · ' : ''}
              {formatDay(hit.updatedAt)}
            </span>
          </div>
          {hit.snippetHtml && (
            <Highlight className="line-clamp-2 text-copy-14 text-gray-900" html={hit.snippetHtml} />
          )}
        </div>
      </TargetLink>
    </li>
  );
}

function TranscriptRow({ hit }: { hit: TranscriptHit }) {
  const speaker = hit.speakerLabel ?? (hit.source === 'mic' ? 'Me' : 'Them');
  return (
    <li>
      <TargetLink
        target={{ kind: 'document', id: hit.documentId, timeMs: hit.startMs }}
        className={rowClass}
        data-testid="search-page-transcript"
      >
        <IconWaveSine aria-hidden className="mt-0.5 size-4 shrink-0 text-gray-900" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-baseline gap-3">
            <span className="min-w-0 flex-1 truncate text-label-14 text-gray-1000">
              {hit.documentTitle || 'Untitled'}
            </span>
            <span className="shrink-0 text-copy-13 text-gray-900 tabular-nums">
              {formatDay(hit.updatedAt)}
            </span>
          </div>
          <p className="flex gap-2 text-copy-14 text-gray-1000">
            <span className="shrink-0 text-copy-14-mono text-gray-900 tabular-nums">
              {formatTimestamp(hit.startMs)}
            </span>
            <span className="shrink-0 text-gray-900">{speaker}</span>
            <Highlight className="line-clamp-2 min-w-0" html={hit.snippetHtml} />
          </p>
        </div>
      </TargetLink>
    </li>
  );
}

/** Same box as a result row with a one-line snippet, so results land without a jump. */
function ResultsSkeleton() {
  return (
    <div className={listClass} role="status" aria-busy="true" aria-label="Searching">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="flex gap-3 px-4 py-3">
          <Skeleton className="mt-0.5 size-4 shrink-0 rounded-sm" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex h-5 items-center justify-between gap-3">
              <Skeleton className="h-3.5 w-2/5" />
              <Skeleton className="h-3 w-16" />
            </div>
            <div className="flex h-5 items-center">
              <Skeleton className="h-3.5 w-4/5" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function SearchEmpty({
  icon: EmptyIcon,
  title,
  children,
  action,
}: {
  icon: Icon;
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <Empty className="border border-gray-alpha-400" data-testid="search-empty">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <EmptyIcon />
        </EmptyMedia>
        <EmptyTitle role="heading" aria-level={2}>
          {title}
        </EmptyTitle>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}

const code = 'rounded-sm bg-gray-100 px-1 text-copy-13-mono text-gray-1000';

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
export function SearchView({
  query,
  onQueryChange,
  type: tab,
  onTypeChange,
}: {
  query: string;
  onQueryChange(query: string): void;
  type: Tab;
  onTypeChange(type: Tab): void;
}) {
  const { workspaceId, searchSources: sources, notify } = useFeatureUi();
  const [attempt, setAttempt] = useState(0);
  const search = useSearch(query, { type: 'all', workspaceId, limit: PAGE, attempt });
  // "Load more" pages per tab, kept only while the first page they continue is on screen.
  const [more, setMore] = useState<Extra>({});
  const [loadingMore, setLoadingMore] = useState(false);
  const paging = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      paging.current?.abort();
    },
    [query, workspaceId, sources],
  );

  const data = search.status === 'done' || search.status === 'loading' ? search.data : undefined;
  const extra: Extra = more.for === data ? more : { for: data };
  const notes = concat(data?.notes, extra.notes);
  const transcripts = concat(data?.transcripts, extra.transcripts);

  async function loadMore(which: Tab) {
    const cursor = (which === 'notes' ? notes : transcripts).nextCursor;
    if (!cursor || !data) return;
    paging.current?.abort();
    const controller = new AbortController();
    paging.current = controller;
    setLoadingMore(true);
    try {
      const { data: page } = await searchSources(sources, data.query, {
        type: which,
        workspaceId,
        limit: PAGE,
        cursor,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setMore(
        which === 'notes'
          ? { ...extra, for: data, notes: concat(extra.notes, page.notes) }
          : { ...extra, for: data, transcripts: concat(extra.transcripts, page.transcripts) },
      );
    } catch {
      if (!controller.signal.aborted) notify.error('Couldn’t load more results.');
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
        <InputGroup size="lg">
          <InputGroupInput
            autoFocus
            type="search"
            aria-label="Search notes and transcripts"
            placeholder="Search notes and transcripts…"
            value={query}
            maxLength={200}
            onChange={(event) => {
              onQueryChange(event.target.value);
            }}
          />
          <InputGroupAddon>
            {pending ? <Spinner aria-label="Searching" /> : <IconSearch aria-hidden />}
          </InputGroupAddon>
        </InputGroup>
      </form>

      {'offline' in search && search.offline && (
        <p role="status" className="text-copy-13 text-gray-900">
          Offline — showing notes on this device
        </p>
      )}
      {!q ? (
        <SearchEmpty icon={IconSearch} title="Search your workspace">
          Find notes by title or content, and the moment something was said in a meeting. Use quotes
          for an exact phrase, <code className={code}>-word</code> to exclude and{' '}
          <code className={code}>or</code> for either.
        </SearchEmpty>
      ) : search.status === 'error' ? (
        <SearchEmpty
          icon={IconSearchOff}
          title="Search isn’t available right now"
          action={
            <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          }
        >
          Check your connection and try again.
        </SearchEmpty>
      ) : (
        <Tabs
          value={tab}
          onValueChange={(value) => {
            onTypeChange(value as Tab);
          }}
          className="gap-4"
        >
          <TabsList>
            <TabsTrigger value="notes">
              Notes
              {data && (
                <span className="text-label-13 text-gray-900 tabular-nums">
                  {countLabel(notes)}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="transcripts">
              Transcripts
              {data && (
                <span className="text-label-13 text-gray-900 tabular-nums">
                  {countLabel(transcripts)}
                </span>
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
                    <SearchEmpty
                      icon={IconSearchOff}
                      title={
                        which === 'notes'
                          ? `No notes match “${q}”`
                          : `No transcript lines match “${q}”`
                      }
                    >
                      Try fewer or different words, or check the other tab.
                    </SearchEmpty>
                  )
                ) : (
                  <>
                    <ul
                      aria-busy={pending}
                      className={`${listClass} transition-opacity duration-150 aria-busy:opacity-60`}
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
                        {loadingMore && <Spinner data-icon="inline-start" />}
                        Load more
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
