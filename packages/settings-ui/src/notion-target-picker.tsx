'use client';

import type { OatClient } from '@oat/client';
import { errorMessage, useSettings } from './services';
import { Badge } from '@oat/ui/components/badge';
import { Button } from '@oat/ui/components/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@oat/ui/components/command';
import { Popover, PopoverContent, PopoverTrigger } from '@oat/ui/components/popover';
import { Spinner } from '@oat/ui/components/spinner';
import { IconDatabase, IconFileText } from '@tabler/icons-react';
import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';

/**
 * "Connect Notion": a plain form POST, so the server answers with the redirect to Notion's consent page and
 * sets the signed state cookie in the same response (works without JS too).
 */
type NotionConnectionInfo = NonNullable<Awaited<ReturnType<OatClient['notion']['status']>>>;
type NotionTargetOption = Awaited<ReturnType<OatClient['notion']['targets']>>[number];

function TargetIcon({ option }: { option: Pick<NotionTargetOption, 'type' | 'icon'> }) {
  if (option.icon) {
    return (
      <span aria-hidden className="w-4 text-center text-label-14">
        {option.icon}
      </span>
    );
  }
  const Icon = option.type === 'database' ? IconDatabase : IconFileText;
  return <Icon aria-hidden className="size-4 text-gray-900" />;
}

/**
 * Where new notes go: the current target plus a searchable picker over the pages and databases the
 * connection can see (Notion search through `/api/integrations/notion/targets`, debounced).
 */
export function NotionTargetPicker({
  workspaceId,
  target,
}: {
  workspaceId: string;
  target: NotionConnectionInfo['target'];
}) {
  const { client, refresh } = useSettings();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<NotionTargetOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = setTimeout(
      () => {
        client.notion
          .targets(workspaceId, query)
          .then((found) => {
            if (cancelled) return;
            setResults(found);
            setError(null);
          })
          .catch((err: unknown) => {
            if (cancelled) return;
            setResults([]);
            setError(err instanceof Error ? err.message : 'Couldn’t search Notion.');
          });
      },
      query ? 250 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, open, query, workspaceId]);

  function choose(option: NotionTargetOption) {
    startSaving(async () => {
      try {
        await client.notion.target({ workspaceId, type: option.type, id: option.id });
        setOpen(false);
        toast.success(`Notes will go to “${option.title}”`);
        await refresh();
      } catch (err) {
        toast.error('Couldn’t use that page', {
          description: errorMessage(err, 'Please try again.'),
        });
      }
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-gray-alpha-400 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-label-12 text-gray-900">Send notes to</span>
        {target ? (
          <span className="flex min-w-0 items-center gap-2" data-testid="notion-target">
            <TargetIcon option={{ type: target.type, icon: null }} />
            <span className="truncate text-label-14 text-gray-1000">
              {target.title || 'Untitled'}
            </span>
            <Badge variant="outline">{target.type === 'database' ? 'Database' : 'Page'}</Badge>
          </span>
        ) : (
          <span className="text-copy-14 text-gray-1000" data-testid="notion-target">
            No page or database chosen yet.
          </span>
        )}
        <span className="text-copy-13 text-gray-900">
          {target?.type === 'database'
            ? 'Each note becomes a row: title, date, attendees and a link back fill matching columns.'
            : 'Each note becomes a sub-page.'}
        </span>
      </div>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery('');
        }}
      >
        <PopoverTrigger
          render={<Button variant={target ? 'outline' : 'default'} className="shrink-0" />}
        >
          {target ? 'Change' : 'Choose page or database'}
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 p-0">
          <Command shouldFilter={false} aria-label="Notion pages and databases">
            <CommandInput
              placeholder="Search Notion…"
              value={query}
              onValueChange={setQuery}
              aria-label="Search Notion pages and databases"
            />
            <CommandList>
              {results === null ? (
                <div className="flex items-center gap-2 px-3 py-4 text-copy-14 text-gray-900">
                  <Spinner aria-hidden role={undefined} /> Searching…
                </div>
              ) : error ? (
                <p role="alert" className="px-3 py-4 text-copy-14 text-red-900">
                  {error}
                </p>
              ) : (
                <>
                  <CommandEmpty>
                    Nothing found. Share the page with Oat in Notion first.
                  </CommandEmpty>
                  <CommandGroup>
                    {results.map((option) => (
                      <CommandItem
                        key={option.id}
                        value={option.id}
                        disabled={saving}
                        onSelect={() => choose(option)}
                        data-testid="notion-target-option"
                      >
                        <TargetIcon option={option} />
                        <span className="flex-1 truncate">{option.title}</span>
                        <span className="text-label-12 text-gray-900">
                          {option.type === 'database' ? 'Database' : 'Page'}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
