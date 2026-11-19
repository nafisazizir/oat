'use client';

import { cn } from '@oat/ui';
import { Button } from '@oat/ui/components/button';
import { IconX } from '@tabler/icons-react';
import { useEffect, useRef } from 'react';

import { clock, type TranscriptLine } from '@/lib/transcript';

/**
 * The transcript of a meeting note, opened at a moment (6.4): what a citation chip or a transcript search hit
 * links to (`/d/<id>?t=<s>&seg=<id>`). The focused line is scrolled into view and highlighted. Read-only; the
 * full meeting view with a collapsible live transcript is task 3.4.
 */
export function TranscriptReader({
  lines,
  focusId,
  onClose,
}: {
  lines: TranscriptLine[];
  focusId: string | undefined;
  onClose: () => void;
}) {
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (!focusId) return;
    const list = listRef.current;
    const line = list?.querySelector<HTMLElement>(`[data-segment-id="${CSS.escape(focusId)}"]`);
    if (!list || !line) return;
    // Centre the line inside the list, then bring the reader itself into view.
    list.scrollTop = line.offsetTop - list.clientHeight / 2 + line.clientHeight / 2;
    list.closest('section')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focusId]);

  return (
    <section
      aria-labelledby="transcript-reader-heading"
      data-testid="transcript-reader"
      className="flex flex-col gap-2 rounded-xl border border-gray-alpha-400 p-3"
    >
      <header className="flex items-center gap-2 ps-2">
        <h2 id="transcript-reader-heading" className="flex-1 text-heading-14">
          Transcript
        </h2>
        <Button variant="ghost" size="icon-sm" aria-label="Close transcript" onClick={onClose}>
          <IconX />
        </Button>
      </header>
      {lines.length === 0 ? (
        <p className="px-2 text-copy-14 text-gray-900">
          No transcript was recorded for this meeting.
        </p>
      ) : (
        <ol ref={listRef} className="relative flex max-h-96 flex-col gap-1 overflow-y-auto">
          {lines.map((line) => {
            const focused = line.id === focusId;
            return (
              <li
                key={line.id}
                data-segment-id={line.id}
                data-focused={focused || undefined}
                aria-current={focused ? 'true' : undefined}
                className={cn(
                  'grid grid-cols-[3.25rem_1fr] gap-2 rounded-lg px-2 py-1.5 text-copy-14 transition-colors duration-150',
                  focused && 'bg-selection ring-1 ring-brand-500',
                )}
              >
                <span className="pt-px text-label-12-mono text-gray-900 tabular-nums">
                  {clock(line.startMs)}
                </span>
                <p>
                  <span
                    className={cn(
                      'me-1.5 rounded-sm px-1 py-px text-label-12',
                      line.source === 'mic'
                        ? 'bg-me text-me-foreground'
                        : 'bg-them text-them-foreground',
                    )}
                  >
                    {line.speaker}
                  </span>
                  {line.text}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
