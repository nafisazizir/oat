import { Button } from '@oat/ui/components/button';
import { cn } from '@oat/ui/lib/utils';
import { Loader2Icon, SquareIcon, XIcon } from 'lucide-react';

import { call } from '../bridge.ts';
import { useMainState, useMainStateSeq } from '../main-state.ts';
import { useRecording } from '../recording-state.ts';
import {
  Elapsed,
  LevelMeter,
  RecordingDot,
  SttStatusPill,
  useRecordingAction,
} from '../recording/recording-controls.tsx';
import { isActive, transcriptionHealth } from '../recording-view.ts';
import { Wordmark } from '../wordmark.tsx';

const STATUS_LABEL = {
  idle: 'Not recording',
  starting: 'Starting…',
  recording: 'Recording',
  paused: 'Paused',
  stopping: 'Saving…',
  error: 'Recording stopped',
} as const;

/**
 * In-meeting widget: frameless and always on top, a compact view of the same main-owned state as the
 * main window (status, elapsed time, levels, transcription health) with a Stop button.
 */
export default function WidgetWindow() {
  const state = useMainState();
  const seq = useMainStateSeq();
  const snapshot = useRecording();
  const stop = useRecordingAction();
  const status = snapshot?.status ?? state?.recording.status ?? 'idle';
  const who = state?.auth.status === 'signed-in' ? state.auth.user.email : 'Not signed in';
  const active = isActive(status);
  const issues = snapshot?.issues.length ?? 0;

  return (
    <div
      className="app-drag flex h-full flex-col justify-between rounded-xl border bg-card p-3 text-card-foreground"
      data-testid="widget"
      data-seq={seq ?? ''}
    >
      <div className="flex items-center justify-between">
        <Wordmark className="text-base" />
        <div className="app-no-drag flex items-center gap-1">
          <SttStatusPill snapshot={snapshot} />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close widget"
            onClick={() => void call('window:close-widget')}
          >
            <XIcon />
          </Button>
        </div>
      </div>
      <div className="flex items-center gap-2 text-sm">
        <RecordingDot status={status} />
        <span data-testid="widget-recording">{STATUS_LABEL[status]}</span>
        {(active || status === 'stopping') && (
          <Elapsed snapshot={snapshot} className="text-muted-foreground" />
        )}
        {active && (
          <div className="ml-1 flex items-center gap-1">
            <LevelMeter compact label="Me" source="mic" db={snapshot?.levels.mic?.rmsDb} />
            <LevelMeter compact label="Them" source="system" db={snapshot?.levels.system?.rmsDb} />
          </div>
        )}
        {(active || status === 'stopping') && (
          <Button
            size="xs"
            variant="destructive"
            className="app-no-drag ml-auto"
            disabled={stop.pending || status === 'stopping'}
            onClick={() => void stop.run(() => call('recording:stop'))}
            data-testid="widget-stop"
          >
            {status === 'stopping' ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <SquareIcon data-icon="inline-start" className="fill-current" />
            )}
            Stop
          </Button>
        )}
      </div>
      {stop.error || (issues > 0 && (active || status === 'error')) ? (
        <p role="alert" className="truncate text-xs text-destructive" data-testid="widget-issue">
          {stop.error ??
            (snapshot && ['offline', 'reconnecting'].includes(transcriptionHealth(snapshot.stt))
              ? 'Transcription offline — still recording'
              : snapshot?.issues.at(-1)?.message)}
        </p>
      ) : (
        <p className={cn('truncate text-xs text-muted-foreground')} data-testid="widget-account">
          {who}
        </p>
      )}
    </div>
  );
}
