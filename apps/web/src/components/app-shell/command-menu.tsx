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
import { useSidebar } from '@oat/ui/components/sidebar';
import { defaultFilter } from 'cmdk';
import {
  AudioLinesIcon,
  FileTextIcon,
  FolderIcon,
  HomeIcon,
  LayoutTemplateIcon,
  ListTodoIcon,
  LoaderCircleIcon,
  MonitorIcon,
  MoonIcon,
  NotebookPenIcon,
  PanelLeftIcon,
  SearchIcon,
  SettingsIcon,
  SparklesIcon,
  SquarePenIcon,
  SunIcon,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { sections } from '@/lib/navigation';
import { formatTimestamp, searchPageHref, transcriptHref } from '@/lib/search';
import { titleOf } from '@/lib/tree';

import { Highlight } from '../search/highlight';
import { useSearch } from '../search/use-search';
import { useTheme } from '../theme-provider';
import { useShellData } from './shell-data';
import { useNewNote } from './use-new-note';

type CommandMenuContextValue = { open: boolean; setOpen: (open: boolean) => void };

const CommandMenuContext = createContext<CommandMenuContextValue | null>(null);

export function useCommandMenu() {
  const context = useContext(CommandMenuContext);
  if (!context) throw new Error('useCommandMenu must be used within a CommandMenuProvider.');
  return context;
}

/** Holds the palette's open state and binds ⌘K / Ctrl+K anywhere in the app (including inputs). */
export function CommandMenuProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey) && !event.altKey) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const value = useMemo(() => ({ open, setOpen }), [open]);
  return <CommandMenuContext.Provider value={value}>{children}</CommandMenuContext.Provider>;
}

/** A local (client-side) palette entry: sections, the tree's pages and folders, commands. */
type LocalItem = {
  value: string;
  /** What the query is matched against. */
  text: string;
  icon: React.ReactNode;
  onSelect: () => void;
  shortcut?: string;
  checked?: boolean;
};
type LocalGroup = { heading: string; items: LocalItem[] };

/**
 * Local matches scoring above this (cmdk's fuzzy score, 0..1) are listed *before* the server results, so
 * "settings" + Enter still opens Settings; weaker fuzzy matches go below them.
 */
const STRONG_MATCH = 0.5;
const PALETTE_LIMIT = 5;

/** Filters and orders local groups for `q` (cmdk's own filtering is off: server results come ranked). */
function rankLocal(groups: LocalGroup[], q: string) {
  if (!q) return { strong: groups, weak: [] as LocalGroup[] };
  const strong: LocalGroup[] = [];
  const weak: LocalGroup[] = [];
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

function LocalGroups({ groups }: { groups: LocalGroup[] }) {
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
          {item.shortcut && <CommandShortcut>{item.shortcut}</CommandShortcut>}
        </CommandItem>
      ))}
    </CommandGroup>
  ));
}

/**
 * The ⌘K palette: full-text search (notes + transcript lines, `/api/search`, active workspace), jump to
 * sections and pages, create a note, toggle the sidebar, switch theme. With an empty query it lists the
 * sections, the workspace's pages and the commands. Typing filters those instantly; server results join
 * once they arrive (pages already among them aren't listed twice) and the cursor moves to the top item,
 * so Enter opens the best hit.
 */
export function CommandMenu() {
  const { open, setOpen } = useCommandMenu();
  const router = useRouter();
  const { toggleSidebar } = useSidebar();
  const { theme, setTheme } = useTheme();
  const newNote = useNewNote();
  const { documents, workspace } = useShellData();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');
  const q = query.trim();
  const search = useSearch(open ? query : '', {
    type: 'all',
    workspaceId: workspace.id,
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
  const local: LocalGroup[] = [
    {
      heading: 'Go to',
      items: [
        { ...sections.home, icon: <HomeIcon /> },
        { ...sections.tasks, icon: <ListTodoIcon /> },
        { ...sections.assistant, icon: <SparklesIcon /> },
        { ...sections.templates, icon: <LayoutTemplateIcon /> },
        { ...sections.settings, icon: <SettingsIcon /> },
      ].map(({ label, href, icon }) => ({
        value: label,
        text: label,
        icon,
        onSelect: run(() => router.push(href)),
      })),
    },
    {
      heading: 'Pages',
      items: documents
        .filter((doc) => !resultIds.has(doc.id))
        .map((doc) => ({
          value: `page:${doc.id}`,
          text: titleOf(doc),
          icon: doc.kind === 'folder' ? <FolderIcon /> : <FileTextIcon />,
          onSelect: run(() => router.push(`/d/${doc.id}`)),
        })),
    },
    {
      heading: 'Actions',
      items: [
        { value: 'New note', text: 'New note', icon: <SquarePenIcon />, onSelect: run(newNote) },
        {
          value: 'Toggle sidebar',
          text: 'Toggle sidebar',
          icon: <PanelLeftIcon />,
          onSelect: run(toggleSidebar),
          shortcut: '⌘B',
        },
      ],
    },
    {
      heading: 'Theme',
      items: (
        [
          ['light', 'Light', SunIcon],
          ['dark', 'Dark', MoonIcon],
          ['system', 'System', MonitorIcon],
        ] as const
      ).map(([value, label, Icon]) => ({
        value: `${label} theme`,
        text: `${label} theme`,
        icon: <Icon />,
        checked: theme === value,
        onSelect: run(() => setTheme(value)),
      })),
    },
  ];
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
      <Command shouldFilter={false} value={selected} onValueChange={setSelected}>
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
              <LocalGroups groups={strong} />
              {notes.length > 0 && (
                <CommandGroup heading="Notes">
                  {notes.map((hit) => (
                    <CommandItem
                      key={hit.id}
                      value={`result:note:${hit.id}`}
                      onSelect={run(() => router.push(`/d/${hit.id}`))}
                      className="items-start"
                      data-testid="search-result-note"
                    >
                      {hit.kind === 'meeting' ? (
                        <NotebookPenIcon className="mt-0.5" />
                      ) : (
                        <FileTextIcon className="mt-0.5" />
                      )}
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <Highlight
                          className="truncate font-medium"
                          html={hit.title ? hit.titleHtml : 'Untitled'}
                        />
                        {hit.snippetHtml && (
                          <Highlight
                            className="line-clamp-1 text-xs text-muted-foreground"
                            html={hit.snippetHtml}
                          />
                        )}
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {transcripts.length > 0 && (
                <CommandGroup heading="Transcripts">
                  {transcripts.map((hit) => (
                    <CommandItem
                      key={hit.id}
                      value={`result:segment:${hit.id}`}
                      onSelect={run(() => router.push(transcriptHref(hit)))}
                      className="items-start"
                      data-testid="search-result-transcript"
                    >
                      <AudioLinesIcon className="mt-0.5" />
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <Highlight className="line-clamp-2" html={hit.snippetHtml} />
                        <span className="truncate text-xs text-muted-foreground">
                          {hit.documentTitle || 'Untitled'}
                        </span>
                      </div>
                      <span className="mt-0.5 shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                        {formatTimestamp(hit.startMs)}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              <CommandGroup heading={notes.length || transcripts.length ? undefined : 'Search'}>
                {searching && (
                  <div
                    role="status"
                    className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground"
                  >
                    <LoaderCircleIcon className="size-4 animate-spin motion-reduce:animate-none" />
                    Searching…
                  </div>
                )}
                {noMatches && (
                  <p className="px-2 py-1.5 text-sm text-muted-foreground">
                    No notes or transcripts match “{q}”.
                  </p>
                )}
                {search.status === 'error' && (
                  <p role="alert" className="px-2 py-1.5 text-sm text-destructive">
                    Search isn’t available right now.
                  </p>
                )}
                <CommandItem
                  value="result:all"
                  onSelect={run(() => router.push(searchPageHref(q)))}
                >
                  <SearchIcon />
                  <span className="truncate">Search all results for “{q}”</span>
                </CommandItem>
              </CommandGroup>
              <LocalGroups groups={weak} />
            </>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
