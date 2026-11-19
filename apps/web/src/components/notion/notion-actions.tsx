'use client';

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
import { DatabaseIcon, FileTextIcon, Loader2Icon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { isApiError } from '@/lib/api-client';
import type { NotionConnectionInfo, NotionTargetOption } from '@/lib/api-types';
import { notionApi } from '@/lib/notion-client';

/**
 * "Connect Notion": a plain form POST, so the server answers with the redirect to Notion's consent page and
 * sets the signed state cookie in the same response (works without JS too).
 */
export function ConnectNotionButton({
  workspaceId,
  label = 'Connect Notion',
  variant = 'default',
}: {
  workspaceId: string;
  label?: string;
  variant?: 'default' | 'outline';
}) {
  const [pending, setPending] = useState(false);
  return (
    <form
      method="post"
      action="/api/integrations/notion/connect"
      className="shrink-0"
      onSubmit={() => setPending(true)}
    >
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <Button type="submit" variant={variant} disabled={pending}>
        {pending && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
        {label}
      </Button>
    </form>
  );
}

export function DisconnectNotionButton({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          try {
            await notionApi.disconnect(workspaceId);
            toast('Notion disconnected');
            router.replace('/settings/integrations');
            router.refresh();
          } catch (error) {
            toast.error('Couldn’t disconnect Notion', {
              description: error instanceof Error ? error.message : 'Please try again.',
            });
          }
        })
      }
    >
      {pending && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
      Disconnect
    </Button>
  );
}

function TargetIcon({ option }: { option: Pick<NotionTargetOption, 'type' | 'icon'> }) {
  if (option.icon) {
    return (
      <span aria-hidden className="w-4 text-center text-base leading-none">
        {option.icon}
      </span>
    );
  }
  const Icon = option.type === 'database' ? DatabaseIcon : FileTextIcon;
  return <Icon className="size-4 text-muted-foreground" />;
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
  const router = useRouter();
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
        notionApi
          .search(workspaceId, query)
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
  }, [open, query, workspaceId]);

  function choose(option: NotionTargetOption) {
    startSaving(async () => {
      try {
        await notionApi.setTarget(workspaceId, { type: option.type, id: option.id });
        setOpen(false);
        toast.success(`Notes will go to “${option.title}”`);
        router.refresh();
      } catch (err) {
        toast.error('Couldn’t use that page', {
          description: isApiError(err) ? err.message : 'Please try again.',
        });
      }
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-xs text-muted-foreground">Send notes to</span>
        {target ? (
          <span className="flex min-w-0 items-center gap-2" data-testid="notion-target">
            <TargetIcon option={{ type: target.type, icon: null }} />
            <span className="truncate font-medium">{target.title || 'Untitled'}</span>
            <Badge variant="outline">{target.type === 'database' ? 'Database' : 'Page'}</Badge>
          </span>
        ) : (
          <span className="text-sm" data-testid="notion-target">
            No page or database chosen yet.
          </span>
        )}
        <span className="text-xs text-muted-foreground">
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
                <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
                  <Loader2Icon className="size-4 animate-spin" /> Searching…
                </div>
              ) : error ? (
                <p role="alert" className="px-3 py-4 text-sm text-destructive">
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
                        <span className="text-xs text-muted-foreground">
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
