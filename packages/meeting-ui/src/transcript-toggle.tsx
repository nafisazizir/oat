'use client';

import { Button } from '@oat/ui/components/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@oat/ui/components/tooltip';
import { IconWaveform } from '@tabler/icons-react';
import type { MouseEventHandler, Ref } from 'react';

export function TranscriptToggle({
  open,
  count,
  onClick,
  ref,
  recording,
}: {
  open: boolean;
  count: number;
  onClick: MouseEventHandler<HTMLButtonElement>;
  ref?: Ref<HTMLButtonElement>;
  recording?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            ref={ref}
            variant="outline"
            size="icon-lg"
            shape="rounded"
            className="aria-expanded:not-hover:not-active:bg-background-100 aria-expanded:not-hover:text-inherit"
            onClick={onClick}
            aria-expanded={open}
            aria-controls="transcript-panel"
            aria-label={count ? `Transcript, ${count} lines` : 'Transcript'}
            data-testid="transcript-toggle"
          />
        }
      >
        <IconWaveform aria-hidden className={recording ? 'transcript-waveform-live' : undefined} />
      </TooltipTrigger>
      <TooltipContent>{open ? 'Hide transcript' : 'Show transcript'}</TooltipContent>
    </Tooltip>
  );
}
