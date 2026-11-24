'use client';

import { Button } from '@oat/ui/components/button';
import { IconChevronDown, IconChevronUp, IconWaveSine } from '@tabler/icons-react';
import type { Ref } from 'react';

export function TranscriptToggle({
  open,
  count,
  onClick,
  ref,
  live,
}: {
  open: boolean;
  count: number;
  onClick: () => void;
  ref?: Ref<HTMLButtonElement>;
  live?: boolean;
}) {
  return (
    <Button
      ref={ref}
      variant="ghost"
      size="sm"
      onClick={onClick}
      aria-expanded={open}
      aria-controls="transcript-panel"
      aria-label={count ? `Transcript, ${count} lines` : 'Transcript'}
      title="Transcript"
      data-testid="transcript-toggle"
    >
      {live ? (
        <span aria-hidden className="size-2 rounded-full bg-red-700" />
      ) : (
        <IconWaveSine aria-hidden />
      )}
      <span className="hidden sm:inline">Transcript</span>
      {open ? <IconChevronDown aria-hidden /> : <IconChevronUp aria-hidden />}
    </Button>
  );
}
