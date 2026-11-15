import { Button } from '@oat/ui/components/button';
import { XIcon } from 'lucide-react';

import { call } from '../bridge.ts';
import { useMainState, useMainStateSeq } from '../main-state.ts';
import { Wordmark } from '../wordmark.tsx';

/**
 * In-meeting widget placeholder (recording controls arrive in 2.5). Frameless and always on top; it reads
 * the same main-owned state as the main window, so both always agree.
 */
export default function WidgetWindow() {
  const state = useMainState();
  const seq = useMainStateSeq();
  const recording = state?.recording.status ?? 'idle';
  const who = state?.auth.status === 'signed-in' ? state.auth.user.email : 'Not signed in';

  return (
    <div
      className="app-drag flex h-full flex-col justify-between rounded-xl border bg-card p-3 text-card-foreground"
      data-testid="widget"
      data-seq={seq ?? ''}
    >
      <div className="flex items-center justify-between">
        <Wordmark className="text-base" />
        <Button
          variant="ghost"
          size="icon-sm"
          className="app-no-drag"
          aria-label="Close widget"
          onClick={() => void call('window:close-widget')}
        >
          <XIcon />
        </Button>
      </div>
      <div className="flex items-center gap-2 text-sm">
        <span
          aria-hidden
          className={
            recording === 'recording'
              ? 'size-2 rounded-full bg-destructive'
              : 'size-2 rounded-full bg-muted-foreground/40'
          }
        />
        <span data-testid="widget-recording">
          {recording === 'recording' ? 'Recording' : 'Not recording'}
        </span>
      </div>
      <p className="truncate text-xs text-muted-foreground" data-testid="widget-account">
        {who}
      </p>
    </div>
  );
}
