'use client';

import { Alert, AlertTitle, AlertDescription } from '@oat/ui/components/alert';
import { Button } from '@oat/ui/components/button';
import { Popover, PopoverTrigger, PopoverContent } from '@oat/ui/components/popover';
import {
  IconMicrophone,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerStop,
} from '@tabler/icons-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useSyncExternalStore } from 'react';

import { browserRecording, supportsRecording } from '@/lib/browser-recording';
import { useHydrated } from '@/lib/use-hydrated';

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
}: {
  documentId: string;
  eligible: boolean;
}) {
  const state = useBrowserRecording();
  const hydrated = useHydrated();
  const [open, setOpen] = useState(false);
  const here = state.documentId === documentId;
  const active = here && !['idle', 'ended'].includes(state.status);
  if (active) return <LiveControls />;
  if (
    !eligible ||
    !hydrated ||
    !supportsRecording() ||
    (state.documentId !== null && !here && !['idle', 'ended'].includes(state.status))
  )
    return null;
  const start = (tab: boolean) => {
    setOpen(false);
    void browserRecording.start(documentId, tab);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="outline" size="sm" disabled={state.pending > 0} />}>
        <IconMicrophone aria-hidden />
        Record
      </PopoverTrigger>
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

function LiveControls() {
  const state = useBrowserRecording();
  const busy = state.changing || state.status === 'starting' || state.status === 'stopping';
  const seconds = Math.floor(state.elapsed);
  return (
    <div
      className="flex items-center gap-1.5"
      data-testid="web-recording"
      data-status={state.status}
    >
      <span className="inline-flex items-center gap-1.5 text-label-13 text-gray-1000" role="status">
        <span className="size-1.5 rounded-full bg-red-700" aria-hidden />
        <span className="sr-only">
          {busy ? state.status : state.status === 'paused' ? 'Paused' : 'Recording'}
        </span>
      </span>
      <span className="text-label-13 text-gray-900 tabular-nums">
        {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={state.status === 'paused' ? 'Resume' : 'Pause'}
        title={state.status === 'paused' ? 'Resume recording' : 'Pause recording'}
        disabled={busy}
        onClick={() => void browserRecording.pause()}
      >
        {state.status === 'paused' ? (
          <IconPlayerPlay aria-hidden />
        ) : (
          <IconPlayerPause aria-hidden />
        )}
      </Button>
      <Button
        variant="outline"
        size="icon-sm"
        aria-label="Stop recording"
        title="Stop recording"
        disabled={busy}
        onClick={() => void browserRecording.stop()}
      >
        <IconPlayerStop aria-hidden />
      </Button>
    </div>
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
            <Button variant="outline" size="sm" onClick={() => browserRecording.retry()}>
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
        <p role="status" className="text-label-12 text-amber-900" data-testid="recording-sync">
          {state.syncError
            ? 'Transcript sync failed.'
            : 'Transcript sync is taking longer than usual.'}{' '}
          <Button variant="ghost" size="xs" onClick={() => browserRecording.retry()}>
            Retry
          </Button>
        </p>
      )}
    </>
  );
}

/** The singleton keeps capture and queued sync alive across client-side navigation. */
export function BrowserRecordingBanner() {
  const state = useBrowserRecording();
  const pathname = usePathname();
  if (
    !state.documentId ||
    pathname === `/d/${state.documentId}` ||
    (['idle', 'ended'].includes(state.status) && !state.pending)
  )
    return null;
  return (
    <div className="flex flex-col gap-2 border-b border-gray-alpha-400 bg-background-100 px-4 py-2">
      <div className="flex items-center gap-3">
        <Link href={`/d/${state.documentId}`} className="text-label-14 text-brand-900 underline">
          Open recording note
        </Link>
        {!['idle', 'ended'].includes(state.status) && <LiveControls />}
      </div>
      <RecordingFeedback documentId={state.documentId} />
    </div>
  );
}
