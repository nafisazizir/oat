/**
 * Recording bar pieces shared by the main window and the widget: start/pause/stop, elapsed time, level
 * meters, the transcription status pill and the issue banner (which never hides while there are issues:
 * SPEC §8, recording never stops silently).
 */
import type {
  InvokeResponse,
  RecordingInput,
  RecordingIssue,
  RecordingSnapshot,
} from '@oat/core/bridge';
import { Button } from '@oat/ui/components/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@oat/ui/components/select';
import { cn } from '@oat/ui/lib/utils';
import { Spinner } from '@oat/ui/components/spinner';
import {
  IconAlertTriangle,
  IconMicrophone,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerStopFilled,
  IconWifiOff,
} from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { formatClock } from '../../../shared/transcript.ts';
import { BridgeCallError, call } from '../bridge.ts';
import {
  archiveFailed,
  elapsedNow,
  HEALTH_LABEL,
  isActive,
  levelFill,
  transcriptionHealth,
} from '../recording-view.ts';

/** Runs a recording command, keeping a pending flag and the error message. */
export function useRecordingAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<unknown>) {
    setPending(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof BridgeCallError ? e.message : 'Something went wrong.');
    } finally {
      setPending(false);
    }
  }
  return { pending, error, run };
}

/** Elapsed recording time, ticking while recording. */
export function Elapsed({
  snapshot,
  className,
}: {
  snapshot: RecordingSnapshot | null;
  className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  const ticking = snapshot?.status === 'recording';
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [ticking]);
  return (
    <span
      className={cn('text-label-14-mono text-gray-1000 tabular-nums', className)}
      data-testid="recording-elapsed"
      aria-label="Recorded time"
    >
      {formatClock(elapsedNow(snapshot, now))}
    </span>
  );
}

/** One source's level as a short bar in that voice's colour. */
export function LevelMeter({
  label,
  source,
  db,
  compact = false,
}: {
  label: string;
  source: 'mic' | 'system';
  db: number | undefined;
  compact?: boolean;
}) {
  const fill = levelFill(db);
  return (
    <div className="flex items-center gap-1.5" data-testid={`level-${source}`}>
      {!compact && <span className="text-label-12 text-gray-900">{label}</span>}
      <div
        role="meter"
        aria-label={`${label} level`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fill * 100)}
        className={cn(
          'h-1.5 overflow-hidden rounded-full',
          compact ? 'w-10' : 'w-14',
          source === 'mic' ? 'bg-me' : 'bg-them',
        )}
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-150 ease-out',
            source === 'mic' ? 'bg-me-foreground' : 'bg-them-foreground',
          )}
          style={{ width: `${fill * 100}%` }}
        />
      </div>
    </div>
  );
}

/** "Live" / "Reconnecting…" / "Transcription offline"; hidden when nothing is transcribing. */
export function SttStatusPill({ snapshot }: { snapshot: RecordingSnapshot | null }) {
  const health = snapshot ? transcriptionHealth(snapshot.stt) : 'off';
  if (health === 'off') return null;
  const tone = {
    live: 'bg-green-100 text-green-900',
    connecting: 'bg-gray-100 text-gray-900',
    reconnecting: 'bg-amber-100 text-amber-900',
    offline: 'bg-red-100 text-red-900',
  }[health];
  return (
    <span
      role="status"
      data-testid="stt-status"
      data-health={health}
      className={cn('inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-label-12', tone)}
    >
      {health === 'live' && <span aria-hidden className="size-1.5 rounded-full bg-green-700" />}
      {(health === 'connecting' || health === 'reconnecting') && (
        <Spinner aria-hidden className="size-3" />
      )}
      {health === 'offline' && <IconWifiOff aria-hidden className="size-3" />}
      {HEALTH_LABEL[health]}
    </span>
  );
}

const FILE_PREFIX = 'file:';

/** The input the bar offers first: the dev fixture when one is configured, else live capture. */
export function defaultInputChoice(options: InvokeResponse<'recording:options'> | null): string {
  return options?.defaultInput === 'file' && options.defaultFixture
    ? `${FILE_PREFIX}${options.defaultFixture}`
    : 'sidecar';
}

/** `recording:start` for an input choice; with `meetingId`, recording continues that meeting (D-24). */
export function startRequest(
  choice: string,
  meetingId?: string | null,
): { input: RecordingInput; fixture?: string; meetingId?: string } {
  const input: { input: RecordingInput; fixture?: string } = choice.startsWith(FILE_PREFIX)
    ? { input: 'file', fixture: choice.slice(FILE_PREFIX.length) }
    : { input: 'sidecar' };
  return meetingId ? { ...input, meetingId } : input;
}

/**
 * The main window's recording bar. Idle on a recorded note, it continues that note's recording (a new
 * part, D-24); anywhere else it starts a new meeting note.
 */
export function RecordingBar({
  snapshot,
  options,
  input,
  onInputChange,
  meetingId = null,
  recorded = true,
  hint = null,
  controlsContainer,
  compact = false,
  hideTranscriptionStatus = false,
}: {
  snapshot: RecordingSnapshot | null;
  options: InvokeResponse<'recording:options'> | null;
  /** Dev input choice (`sidecar` or `file:<fixture>`), shared with "New meeting note". */
  input: string;
  onInputChange: (choice: string) => void;
  /** The open note's meeting, when recording may continue it. */
  meetingId?: string | null;
  /** That meeting has been recorded before ("Continue recording"); false: its first recording (7.3). */
  recorded?: boolean;
  /** Why the open note can't be continued. */
  hint?: string | null;
  controlsContainer?: HTMLElement | null;
  compact?: boolean;
  hideTranscriptionStatus?: boolean;
}) {
  const action = useRecordingAction();
  const cancelStart = useRecordingAction();
  const status = snapshot?.status ?? 'idle';
  const active = isActive(status);
  const stopAction = status === 'starting' ? cancelStart : action;
  const error = status === 'starting' ? cancelStart.error : action.error;

  function start() {
    return action.run(() => call('recording:start', startRequest(input, meetingId)));
  }

  const controls = (
    <div
      className={cn(
        'flex items-center',
        compact ? 'flex-wrap justify-center gap-1' : 'gap-2',
        !compact && !controlsContainer && 'flex-wrap justify-center',
      )}
    >
      {status === 'recording' && (
        <Button
          size={compact ? 'icon-sm' : 'sm'}
          variant={compact ? 'ghost' : 'secondary'}
          aria-label="Pause"
          title={compact ? 'Pause recording' : undefined}
          disabled={action.pending}
          onClick={() => void action.run(() => call('recording:pause'))}
        >
          <IconPlayerPause data-icon="inline-start" />
          {!compact && 'Pause'}
        </Button>
      )}
      {status === 'paused' && (
        <Button
          size={compact ? 'icon-sm' : 'sm'}
          variant={compact ? 'ghost' : 'secondary'}
          aria-label="Resume"
          title={compact ? 'Resume recording' : undefined}
          disabled={action.pending}
          onClick={() => void action.run(() => call('recording:resume'))}
        >
          <IconPlayerPlay data-icon="inline-start" />
          {!compact && 'Resume'}
        </Button>
      )}
      {(status === 'idle' || status === 'error') && (
        <Button
          size="sm"
          variant="secondary"
          disabled={action.pending || cancelStart.pending || !snapshot}
          aria-label={meetingId && recorded ? 'Continue recording' : 'Start recording'}
          title={
            compact ? (meetingId && recorded ? 'Continue recording' : 'Start recording') : undefined
          }
          onClick={() => void start()}
        >
          {action.pending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <IconMicrophone data-icon="inline-start" />
          )}
          {compact
            ? meetingId && recorded
              ? 'Record more'
              : 'Record'
            : meetingId && recorded
              ? 'Continue recording'
              : 'Start recording'}
        </Button>
      )}
      {status === 'starting' && (
        <Button disabled size="sm" variant="secondary">
          <Spinner data-icon="inline-start" />
          Starting…
        </Button>
      )}
      {status === 'stopping' && (
        <Button disabled size="sm" variant="secondary">
          <Spinner data-icon="inline-start" />
          Saving…
        </Button>
      )}
      {(active || status === 'error') && (
        <Button
          size={compact ? 'icon-sm' : 'sm'}
          variant="secondary"
          disabled={
            cancelStart.pending ||
            status === 'stopping' ||
            (status !== 'starting' && action.pending)
          }
          onClick={() => void stopAction.run(() => call('recording:stop'))}
          aria-label={status === 'error' ? 'Dismiss' : 'Stop recording'}
          title={status === 'error' ? 'Dismiss' : 'Stop recording'}
        >
          <IconPlayerStopFilled data-icon="inline-start" />
          {!compact && (status === 'error' ? 'Dismiss' : 'Stop')}
        </Button>
      )}

      {active && (
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-2">
            {!compact && <RecordingDot status={status} />}
            <Elapsed snapshot={snapshot} />
          </span>
          {!compact && (
            <>
              <LevelMeter compact label="Me" source="mic" db={snapshot?.levels.mic?.rmsDb} />
              <LevelMeter
                compact
                label="Them"
                source="system"
                db={snapshot?.levels.system?.rmsDb}
              />
            </>
          )}
        </div>
      )}
      <div className="flex items-center gap-2">
        {!hideTranscriptionStatus &&
          (!compact || (active && snapshot && transcriptionHealth(snapshot.stt) !== 'live')) && (
            <SttStatusPill snapshot={snapshot} />
          )}
        {options && options.fixtures.length > 0 && (status === 'idle' || status === 'error') && (
          <Select
            size="sm"
            items={[
              { value: 'sidecar', label: 'Mic + system audio' },
              ...options.fixtures.map((f) => ({
                value: `${FILE_PREFIX}${f}`,
                label: `Fixture: ${f}`,
              })),
            ]}
            value={input}
            onValueChange={(value) => {
              if (value !== null) onInputChange(value);
            }}
          >
            <SelectTrigger aria-label="Audio input (dev)" data-testid="audio-input">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="sidecar">Mic + system audio</SelectItem>
              {options.fixtures.map((f) => (
                <SelectItem key={f} value={`${FILE_PREFIX}${f}`}>
                  Fixture: {f}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  );
  return (
    <div
      className="flex flex-col gap-2"
      title={hint ?? undefined}
      data-testid="recording-bar"
      data-status={status}
    >
      {controlsContainer ? createPortal(controls, controlsContainer) : controls}
      {error && (
        <p role="status" className="text-copy-13 text-red-900">
          {error}
        </p>
      )}
      {hint && !error && (status === 'idle' || status === 'error') && (
        <p className="sr-only" data-testid="recording-hint">
          {hint}
        </p>
      )}
    </div>
  );
}

export function RecordingDot({ status }: { status: RecordingSnapshot['status'] }) {
  return (
    <span
      aria-hidden
      className={cn(
        'size-2 rounded-full',
        status === 'recording' && 'animate-pulse bg-red-700',
        status === 'paused' && 'bg-amber-700',
        status === 'error' && 'bg-red-700',
        (status === 'idle' || status === 'starting' || status === 'stopping') && 'bg-gray-500',
      )}
    />
  );
}

/**
 * Every problem of the current recording, newest first. Stays while there are issues (it is cleared by the
 * next start only): a problem that fixed itself still shows what happened, under a calmer heading.
 */
export function IssueBanner({ snapshot }: { snapshot: RecordingSnapshot | null }) {
  const issues = snapshot?.issues ?? [];
  if (!snapshot || issues.length === 0) return null;
  const health = transcriptionHealth(snapshot.stt);
  const audioDown = snapshot.status === 'error';
  const active = isActive(snapshot.status);
  const sttDown = health === 'offline' || health === 'reconnecting';
  const notSaved = archiveFailed(snapshot);
  const heading = audioDown
    ? 'Recording stopped'
    : notSaved && active
      ? 'Audio isn’t being saved on this Mac'
      : sttDown && active
        ? 'Transcription is offline — still recording'
        : active
          ? 'Recording, with a hiccup'
          : 'This recording had problems';
  const severe = audioDown || (active && (sttDown || notSaved));
  return (
    <div
      role="alert"
      data-testid="recording-issues"
      className={cn(
        'flex gap-3 rounded-lg border px-3 py-2.5 text-gray-1000',
        severe ? 'border-red-300 bg-red-100' : 'border-amber-300 bg-amber-100',
      )}
    >
      <IconAlertTriangle
        aria-hidden
        className={cn('mt-0.5 size-4 shrink-0', severe ? 'text-red-900' : 'text-amber-900')}
      />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-label-14">{heading}</p>
        <ul className="flex flex-col gap-0.5 text-copy-13 text-gray-900">
          {[...issues]
            .reverse()
            .slice(0, 3)
            .map((issue) => (
              <IssueLine key={issue.id} issue={issue} startedAt={snapshot.startedAt} />
            ))}
        </ul>
      </div>
    </div>
  );
}

function IssueLine({ issue, startedAt }: { issue: RecordingIssue; startedAt: number | null }) {
  const at = startedAt !== null ? formatClock(issue.at - startedAt) : null;
  return (
    <li data-scope={issue.scope} data-code={issue.code} data-selectable>
      {at && <span className="me-1.5 text-label-13-mono tabular-nums">{at}</span>}
      {issue.message}
      {issue.count > 1 && <span className="ms-1 tabular-nums">(×{issue.count})</span>}
    </li>
  );
}
