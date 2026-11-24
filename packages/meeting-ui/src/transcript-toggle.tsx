'use client';

import { Button } from '@oat/ui/components/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@oat/ui/components/tooltip';
import { IconWaveform } from '@tabler/icons-react';
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
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            ref={ref}
            variant="ghost"
            size="icon-sm"
            className="relative"
            onClick={onClick}
            aria-expanded={open}
            aria-controls="transcript-panel"
            aria-label={count ? `Transcript, ${count} lines` : 'Transcript'}
            data-testid="transcript-toggle"
          />
        }
      >
        <IconWaveform aria-hidden />
        {live && (
          <span aria-hidden className="absolute end-1 top-1 size-1.5 rounded-full bg-red-700" />
        )}
      </TooltipTrigger>
      <TooltipContent>{open ? 'Hide transcript' : 'Show transcript'}</TooltipContent>
    </Tooltip>
  );
}
