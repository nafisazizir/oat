'use client';

import { Button } from '@oat/ui/components/button';
import { Input } from '@oat/ui/components/input';
import { IconCopy, IconMinus, IconSearch, IconWaveSine } from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';

import { formatClock, speakerOf, type TranscriptItem } from './format';

export function TranscriptSheet({
  items,
  onClose,
  footer,
  children,
}: {
  items: readonly TranscriptItem[];
  onClose: () => void;
  footer?: ReactNode;
  children: (filtered: readonly TranscriptItem[]) => ReactNode;
}) {
  const [query, setQuery] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const term = query.trim().toLowerCase();
  const filtered = term ? items.filter(({ text }) => text.toLowerCase().includes(term)) : items;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        items
          .map((item) => `${formatClock(item.startMs)} · ${speakerOf(item)}: ${item.text}`)
          .join('\n'),
      );
      setCopyStatus('Transcript copied');
    } catch {
      setCopyStatus('Couldn’t copy transcript');
    }
  };
  return (
    <section
      id="transcript-panel"
      aria-labelledby="transcript-heading"
      data-testid="transcript-panel"
      data-note-dock-panel="transcript"
      className="flex h-[min(25rem,55dvh)] min-h-0 flex-col overflow-hidden rounded-3xl border border-gray-alpha-400 bg-background-100 shadow-lg"
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-alpha-400 p-2">
        <IconWaveSine aria-hidden className="ms-1 size-4 text-gray-900" />
        <h2 id="transcript-heading" className="text-heading-14">
          Transcript
        </h2>
        {items.length > 0 && (
          <span className="text-label-12 text-gray-900 tabular-nums">{items.length}</span>
        )}
        <div className="ms-auto flex min-w-0 items-center gap-1">
          <IconSearch aria-hidden className="size-4 shrink-0 text-gray-900" />
          <Input
            type="search"
            aria-label="Search transcript"
            size="sm"
            placeholder="Search"
            className="w-24 sm:w-36"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Copy transcript"
            title="Copy transcript"
            disabled={!items.length}
            onClick={() => void copy()}
          >
            <IconCopy />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Hide transcript"
            data-testid="panel-close"
            title="Hide transcript"
            onClick={onClose}
          >
            <IconMinus />
          </Button>
        </div>
      </header>
      <p role="status" className="sr-only">
        {copyStatus}
      </p>
      {term && !filtered.length ? (
        <p className="m-auto p-4 text-copy-14 text-gray-900" role="status">
          No matching transcript lines.
        </p>
      ) : (
        children(filtered)
      )}
      {footer && (
        <footer className="flex shrink-0 items-end justify-between gap-2 border-t border-gray-alpha-400 p-2 text-label-12 text-gray-900">
          {footer}
        </footer>
      )}
    </section>
  );
}
