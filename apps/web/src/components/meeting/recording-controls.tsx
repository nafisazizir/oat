'use client';

import { Alert, AlertTitle, AlertDescription } from '@oat/ui/components/alert';
import { Button } from '@oat/ui/components/button';
import { ButtonGroup } from '@oat/ui/components/button-group';
import { Popover, PopoverTrigger, PopoverContent } from '@oat/ui/components/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@oat/ui/components/tooltip';
import {
  IconMicrophone,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerStop,
} from '@tabler/icons-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useSyncExternalStore, type ReactNode } from 'react';

import { browserRecording, supportsRecording } from '@/lib/browser-recording';
import { useHydrated } from '@/lib/use-hydrated';
import { useShellData } from '@oat/workspace-ui/shell-data';

export function useBrowserRecording() {
  return useSyncExternalStore(
    browserRecording.subscribe,
    browserRecording.snapshot,
    browserRecording.serverSnapshot,
  );
}

export function RecordingControls({
  documentId,
  eligible,
  transcriptToggle,
}: {
  documentId: string;
  eligible: boolean;
  transcriptToggle: ReactNode;
}) {
  const { user } = useShellData();
  const state = useBrowserRecording();
  const hydrated = useHydrated();
  const here = state.documentId === documentId;
  const active = here && !['idle', 'ended'].includes(state.status);
  const canStart =
    eligible &&
    hydrated &&
    supportsRecording() &&
    (state.documentId === null || here || ['idle', 'ended'].includes(state.status));
  return (
    <ButtonGroup
      aria-label="Transcript and recording controls"
      className="rounded-md shadow-sm"
      data-testid={active ? 'web-recording' : undefined}
      data-status={active ? state.status : undefined}
    >
      {transcriptToggle}
      {active ? (
        <LiveControls state={state} grouped />
      ) : canStart ? (
        <RecordMenu documentId={documentId} userId={user.id} disabled={state.pending > 0} />
      ) : null}
    </ButtonGroup>
  );
}

function RecordMenu({
  documentId,
  userId,
  disabled,
}: {
  documentId: string;
  userId: string;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const start = (tab: boolean) => {
    setOpen(false);
    void browserRecording.start(documentId, tab, userId);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button variant="outline" size="icon-lg" aria-label="Record" disabled={disabled} />
              }
            />
          }
        >
          <IconMicrophone aria-hidden />
        </TooltipTrigger>
        <TooltipContent>Record</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-64">
        <p className="text-label-14 text-gray-1000">Record a browser meeting</p>
        <p className="text-copy-13 text-gray-900">
          Only transcripts sync. Desktop captures native call apps.
        </p>
        <Button variant="ghost" className="w-full justify-start" onClick={() => start(false)}>
          Mic only
        </Button>
        <Button
          variant="ghost"
          className="w-full justify-start"
          disabled={!navigator.mediaDevices.getDisplayMedia}
          onClick={() => start(true)}
        >
          Mic + tab audio
        </Button>
      </PopoverContent>
    </Popover>
  );
}

function LiveControls({
  state,
  grouped = false,
}: {
  state: ReturnType<typeof useBrowserRecording>;
  grouped?: boolean;
}) {
  const busy = state.changing || state.status === 'starting' || state.status === 'stopping';
  const seconds = Math.floor(state.elapsed);
  const paused = state.status === 'paused';
  const activity = busy ? state.status : paused ? 'Paused' : 'Recording';
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const pauseButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={grouped ? 'outline' : 'ghost'}
            size={grouped ? 'icon-lg' : 'icon-sm'}
            aria-label={paused ? 'Resume' : 'Pause'}
            disabled={busy}
            onClick={() => void browserRecording.pause()}
          />
        }
      >
        {paused ? <IconPlayerPlay aria-hidden /> : <IconPlayerPause aria-hidden />}
      </TooltipTrigger>
      <TooltipContent>{paused ? 'Resume recording' : 'Pause recording'}</TooltipContent>
    </Tooltip>
  );
  if (grouped) {
    return (
      <>
        {pauseButton}
        <span className="sr-only" role="status">
          {activity}
        </span>
      </>
    );
  }
  return (
    <div
      className="flex items-center gap-1.5"
      data-testid="web-recording"
      data-status={state.status}
    >
      <span className="inline-flex items-center gap-1.5 text-label-13 text-gray-1000" role="status">
        <span className="size-1.5 rounded-full bg-red-700" aria-hidden />
        <span className="sr-only">{activity}</span>
      </span>
      <span className="text-label-13 text-gray-900 tabular-nums">{elapsed}</span>
      {pauseButton}
      <RecordingStopButton disabled={busy} />
    </div>
  );
}

export function RecordingStopButton({ disabled }: { disabled: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="secondary"
            size="icon-sm"
            aria-label="Stop recording"
            disabled={disabled}
            onClick={() => void browserRecording.stop()}
          />
        }
      >
        <IconPlayerStop aria-hidden />
      </TooltipTrigger>
      <TooltipContent>Stop recording</TooltipContent>
    </Tooltip>
  );
}

export function RecordingFeedback({ documentId }: { documentId: string }) {
  const state = useBrowserRecording();
  if (state.documentId !== documentId) return null;
  return (
    <>
      {state.error && (
        <Alert variant="destructive">
          <AlertTitle>Recording needs attention</AlertTitle>
          <AlertDescription>
            {state.error}
            <Button variant="secondary" size="sm" onClick={() => browserRecording.retry()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {state.notice && (
        <p role="status" className="text-copy-13 text-amber-900">
          {state.notice}
        </p>
      )}
      {state.audioNotice && (
        <p role="status" className="text-copy-13 text-amber-900">
          {state.audioNotice}
        </p>
      )}
      {(state.syncError || state.syncDelayed) && (
        <SyncWarning
          message={
            state.syncError
              ? 'Transcript sync failed.'
              : 'Transcript sync is taking longer than usual.'
          }
        />
      )}
    </>
  );
}

function SyncWarning({ message, recovery = false }: { message: string; recovery?: boolean }) {
  return (
    <p
      role="status"
      className="text-label-12 text-amber-900"
      data-testid={recovery ? 'recording-recovery' : 'recording-sync'}
    >
      {message}{' '}
      <Button variant="ghost" size="xs" onClick={() => browserRecording.retry()}>
        Retry
      </Button>
    </p>
  );
}

/** The singleton keeps capture and queued sync alive across client-side navigation. */
export function BrowserRecordingBanner() {
  const state = useBrowserRecording();
  const pathname = usePathname();
  const recovery = state.recoveryError ? (
    <div className="border-b border-gray-alpha-400 bg-background-100 px-4 py-2">
      <SyncWarning message={state.recoveryError} recovery />
    </div>
  ) : null;
  if (
    !state.documentId ||
    pathname === `/d/${state.documentId}` ||
    (['idle', 'ended'].includes(state.status) && !state.pending)
  )
    return recovery;
  return (
    <>
      {recovery}
      <div className="flex flex-col gap-2 border-b border-gray-alpha-400 bg-background-100 px-4 py-2">
        <div className="flex items-center gap-3">
          <Link href={`/d/${state.documentId}`} className="text-label-14 text-brand-900 underline">
            Open recording note
          </Link>
          {!['idle', 'ended'].includes(state.status) && <LiveControls state={state} />}
        </div>
        <RecordingFeedback documentId={state.documentId} />
      </div>
    </>
  );
}
