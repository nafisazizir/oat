import { Button } from '@oat/ui/components/button';
import { Spinner } from '@oat/ui/components/spinner';
import { IconPlayerStopFilled, IconX } from '@tabler/icons-react';

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
    <main
      className="app-drag flex h-full flex-col justify-between rounded-xl border border-gray-alpha-400 bg-background-100 p-3 text-gray-1000"
      data-testid="widget"
      data-seq={seq ?? ''}
    >
      <h1 className="sr-only">Meeting widget</h1>
      <div className="flex items-center justify-between">
        <Wordmark className="text-heading-16" />
        <div className="app-no-drag flex items-center gap-1">
          <SttStatusPill snapshot={snapshot} />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close widget"
            onClick={() => void call('window:close-widget')}
          >
            <IconX />
          </Button>
        </div>
      </div>
      <div className="flex items-center gap-2 text-label-14">
        <RecordingDot status={status} />
        <span data-testid="widget-recording">{STATUS_LABEL[status]}</span>
        {(active || status === 'stopping') && (
          <Elapsed snapshot={snapshot} className="text-gray-900" />
        )}
        {active && (
          <div className="ms-1 flex items-center gap-1">
            <LevelMeter compact label="Me" source="mic" db={snapshot?.levels.mic?.rmsDb} />
            <LevelMeter compact label="Them" source="system" db={snapshot?.levels.system?.rmsDb} />
          </div>
        )}
        {(active || status === 'stopping') && (
          <Button
            size="xs"
            variant="destructive"
            className="app-no-drag ms-auto"
            disabled={stop.pending || status === 'stopping'}
            onClick={() => void stop.run(() => call('recording:stop'))}
            data-testid="widget-stop"
          >
            {status === 'stopping' ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <IconPlayerStopFilled data-icon="inline-start" />
            )}
            Stop
          </Button>
        )}
      </div>
      {stop.error || (issues > 0 && (active || status === 'error')) ? (
        <p role="alert" className="truncate text-label-12 text-red-900" data-testid="widget-issue">
          {stop.error ??
            (snapshot && ['offline', 'reconnecting'].includes(transcriptionHealth(snapshot.stt))
              ? 'Transcription offline — still recording'
              : snapshot?.issues.at(-1)?.message)}
        </p>
      ) : (
        <p className="truncate text-label-12 text-gray-900" data-testid="widget-account">
          {who}
        </p>
      )}
    </main>
  );
}
