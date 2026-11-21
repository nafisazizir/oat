'use client';

import { Button } from '@oat/ui/components/button';
import { IconWaveSine } from '@tabler/icons-react';
import type { Ref } from 'react';

export function TranscriptToggle({
  open,
  count,
  onClick,
  ref,
}: {
  open: boolean;
  count: number;
  onClick: () => void;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <Button
      ref={ref}
      variant="secondary"
      size="sm"
      onClick={onClick}
      aria-expanded={open}
      aria-controls="transcript-panel"
      data-testid="transcript-toggle"
    >
      <IconWaveSine aria-hidden />
      Transcript{count > 0 && <span className="text-gray-900 tabular-nums">{count}</span>}
    </Button>
  );
}
