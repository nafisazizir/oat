'use client';

import { Button } from '@oat/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@oat/ui/components/dropdown-menu';
import {
  AlertCircleIcon,
  ChevronDownIcon,
  Loader2Icon,
  RefreshCwIcon,
  SparklesIcon,
} from 'lucide-react';
import { useState } from 'react';

import type { TemplateDto, TemplateList } from '@/lib/templates';

import type { Enhancement } from './use-enhancement';

type StartInput = Parameters<Enhancement['start']>[0];

/**
 * "Enhance" for meeting notes: one click uses the meeting's template (or General); the chevron picks another.
 * Shows progress while a run is going. Once the note has been enhanced it reads "Regenerate" (4.5), and the
 * caller routes starts through `onStart` (to confirm first when that would replace edits) and adds its own
 * menu items (`children`: history, original notes, undo).
 */
export function EnhanceButton({
  enhancement,
  workspaceId,
  regenerate = false,
  onStart,
  children,
}: {
  enhancement: Enhancement;
  workspaceId: string;
  /** The note was enhanced before: label the action "Regenerate". */
  regenerate?: boolean;
  /** Starts a run (default: `enhancement.start`). `undefined` input = the default template. */
  onStart?: (input?: StartInput) => void;
  /** Extra menu items, after the templates. */
  children?: React.ReactNode;
}) {
  const { state } = enhancement;
  const start = onStart ?? ((input?: StartInput) => void enhancement.start(input));
  const busy = state.phase === 'starting' || state.phase === 'streaming';
  const [templates, setTemplates] = useState<TemplateList | null>(null);
  const [loadError, setLoadError] = useState(false);

  const loadTemplates = (open: boolean) => {
    if (!open || templates) return;
    setLoadError(false);
    fetch(`/api/templates?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: 'no-store' })
      .then((res) => (res.ok ? (res.json() as Promise<TemplateList>) : Promise.reject()))
      .then(setTemplates, () => setLoadError(true));
  };

  const item = (t: TemplateDto) => (
    <DropdownMenuItem
      key={t.id}
      data-testid="enhance-template"
      onSelect={() => start({ templateId: t.id })}
    >
      {t.name}
    </DropdownMenuItem>
  );

  return (
    <div className="inline-flex items-center" data-slot="button-group">
      <Button
        size="sm"
        data-testid="enhance-button"
        disabled={busy}
        onClick={() => start()}
        className="rounded-r-none"
      >
        {busy ? (
          <Loader2Icon data-icon="inline-start" className="animate-spin" />
        ) : regenerate ? (
          <RefreshCwIcon data-icon="inline-start" />
        ) : (
          <SparklesIcon data-icon="inline-start" />
        )}
        {busy ? 'Enhancing…' : regenerate ? 'Regenerate' : 'Enhance'}
      </Button>
      <DropdownMenu onOpenChange={loadTemplates}>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon-sm"
            disabled={busy}
            aria-label={regenerate ? 'Regenerate with a template' : 'Enhance with a template'}
            data-testid="enhance-template-menu"
            className="rounded-l-none border-l border-l-primary-foreground/20"
          >
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          <DropdownMenuLabel>
            {regenerate ? 'Regenerate with template' : 'Enhance with template'}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {loadError ? (
            <DropdownMenuItem disabled>Couldn’t load templates</DropdownMenuItem>
          ) : !templates ? (
            <DropdownMenuItem disabled>
              <Loader2Icon className="animate-spin" />
              Loading…
            </DropdownMenuItem>
          ) : (
            <>
              {templates.builtins.map(item)}
              {templates.custom.length > 0 && <DropdownMenuSeparator />}
              {templates.custom.map(item)}
            </>
          )}
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Error line under the header when a run failed or the stream was lost, with the matching retry. */
export function EnhanceError({ enhancement }: { enhancement: Enhancement }) {
  const { state, retry, reattach, dismiss } = enhancement;
  if (state.phase !== 'failed') return null;
  return (
    <div
      role="alert"
      data-testid="enhance-error"
      className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm"
    >
      <AlertCircleIcon className="size-4 text-destructive" />
      <span className="flex-1">{state.message}</span>
      <Button size="sm" variant="outline" onClick={state.lost ? reattach : retry}>
        {state.lost ? 'Reconnect' : 'Try again'}
      </Button>
      <Button size="sm" variant="ghost" onClick={dismiss}>
        Dismiss
      </Button>
    </div>
  );
}
