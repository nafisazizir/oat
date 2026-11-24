'use client';

import { Button } from '@oat/ui/components/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@oat/ui/components/tooltip';
import { IconCopy, IconMinus } from '@tabler/icons-react';
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
  children: ReactNode;
}) {
  const [copyStatus, setCopyStatus] = useState('');
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
      aria-label="Transcript"
      data-testid="transcript-panel"
      data-note-dock-panel="transcript"
      className="flex h-[min(25rem,55dvh)] min-h-0 flex-col overflow-hidden rounded-3xl border border-gray-alpha-400 bg-background-100 shadow-lg"
    >
      <header className="flex shrink-0 items-center justify-end gap-1 border-b border-gray-alpha-400 p-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Copy transcript"
                disabled={!items.length}
                onClick={() => void copy()}
              />
            }
          >
            <IconCopy />
          </TooltipTrigger>
          <TooltipContent>Copy transcript</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Hide transcript"
                data-testid="panel-close"
                onClick={onClose}
              />
            }
          >
            <IconMinus />
          </TooltipTrigger>
          <TooltipContent>Hide transcript</TooltipContent>
        </Tooltip>
      </header>
      <p role="status" className="sr-only">
        {copyStatus}
      </p>
      {children}
      {footer && (
        <footer className="flex shrink-0 items-end justify-between gap-2 border-t border-gray-alpha-400 p-2 text-label-12 text-gray-900">
          {footer}
        </footer>
      )}
    </section>
  );
}
