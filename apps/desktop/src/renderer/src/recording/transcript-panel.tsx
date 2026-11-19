/**
 * The meeting's transcript (2.5, 3.4): the shared virtualised list (`@oat/meeting-ui`), "me" (mic) on the
 * right, "them" (system audio) on the left, interims italic and muted until their final replaces them.
 * While this meeting is being recorded it follows the live end (scrolling up stops that and offers "Jump to
 * live"); a past meeting shows its stored transcript. The empty states explain what is (not) happening.
 */
import type { RecordingSnapshot, TranscriptBackfillStatus } from '@oat/core/bridge';
import { type TranscriptItem, TranscriptList } from '@oat/meeting-ui';
import { cn } from '@oat/ui/lib/utils';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@oat/ui/components/empty';
import { Spinner } from '@oat/ui/components/spinner';
import { IconAlertCircle, IconHistory, IconWaveSine, IconWifiOff } from '@tabler/icons-react';

import { archiveFailed, type TranscriptionHealth, transcriptionHealth } from '../recording-view.ts';
import { type TranscriptNotice, transcriptNotices } from './transcript-notices.ts';

export function TranscriptPanel({
  segments,
  live,
  snapshot,
  loaded,
  failed,
  meetingKey,
  focusId,
  onSelect,
  activeId,
  playheadKey,
  status = null,
}: {
  segments: readonly TranscriptItem[];
  /** This meeting is the one being recorded (or just was): follow the live end, show recording states. */
  live: boolean;
  snapshot: RecordingSnapshot | null;
  loaded: boolean;
  failed: boolean;
  /** Changes with the meeting shown. */
  meetingKey: string | null;
  focusId?: string | undefined;
  onSelect?: (segment: TranscriptItem) => void;
  /** Playback (3.7): the line under the playhead, and a counter bumped on every seek. */
  activeId?: string | undefined;
  playheadKey?: number;
  /** Back-fill progress / crash-recovery note of the meeting shown (2.7). */
  status?: TranscriptBackfillStatus | null;
}) {
  const recordingStatus = live ? (snapshot?.status ?? 'idle') : 'idle';
  const notices = transcriptNotices(status);
  return (
    <section
      aria-label={live ? 'Live transcript' : 'Transcript'}
      className="relative flex min-h-0 flex-1 flex-col"
      data-testid="transcript"
      data-count={segments.length}
      data-live={live || undefined}
    >
      {notices.length > 0 && <TranscriptNotices notices={notices} />}
      {segments.length === 0 ? (
        <EmptyTranscript
          status={recordingStatus}
          loaded={loaded}
          health={live && snapshot ? transcriptionHealth(snapshot.stt) : 'off'}
          failed={failed}
          archiveFailed={live && archiveFailed(snapshot)}
          past={!live && meetingKey !== null}
        />
      ) : (
        <TranscriptList
          segments={segments}
          follow={live}
          resetKey={meetingKey}
          focusId={focusId}
          onSelect={onSelect}
          activeId={activeId}
          playheadKey={playheadKey}
        />
      )}
    </section>
  );
}

const NOTICE_TONE: Record<TranscriptNotice['kind'], string> = {
  recovered: 'border-amber-300 bg-amber-100 text-gray-1000',
  filling: 'border-gray-alpha-400 bg-background-200 text-gray-900',
  retrying: 'border-amber-300 bg-amber-100 text-gray-1000',
  failed: 'border-red-300 bg-red-100 text-red-900',
  filled: 'border-gray-alpha-400 bg-background-200 text-gray-900',
};

/** Above the transcript: what happened to it (2.7). Live region, so progress is announced. */
function TranscriptNotices({ notices }: { notices: readonly TranscriptNotice[] }) {
  return (
    <div className="flex flex-col gap-1.5 px-3 pt-3" role="status" aria-live="polite">
      {notices.map((n) => (
        <p
          key={n.kind}
          data-testid="transcript-notice"
          data-kind={n.kind}
          className={cn(
            'flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-copy-13',
            NOTICE_TONE[n.kind],
          )}
        >
          {n.kind === 'filling' ? (
            <Spinner aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          ) : n.kind === 'filled' ? (
            <IconHistory aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <IconAlertCircle
              aria-hidden
              className={cn(
                'mt-0.5 size-3.5 shrink-0',
                n.kind === 'failed' ? 'text-red-900' : 'text-amber-900',
              )}
            />
          )}
          <span>{n.text}</span>
        </p>
      ))}
    </div>
  );
}

function EmptyTranscript({
  status,
  loaded,
  health,
  failed,
  archiveFailed,
  past,
}: {
  status: RecordingSnapshot['status'];
  loaded: boolean;
  health: TranscriptionHealth;
  failed: boolean;
  archiveFailed: boolean;
  /** A note that isn't being recorded. */
  past: boolean;
}) {
  if (!loaded || status === 'starting') {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-2 text-label-14 text-gray-900"
        data-testid="transcript-loading"
      >
        <Spinner aria-hidden className="size-5" />
        {status === 'starting'
          ? 'Starting…'
          : failed
            ? 'Couldn’t load the transcript. Retrying…'
            : 'Loading…'}
      </div>
    );
  }
  const listening = status === 'recording' || status === 'paused';
  if (listening && (health === 'offline' || health === 'reconnecting')) {
    return (
      <Empty className="flex-1 px-8" data-testid="transcript-empty">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconWifiOff aria-hidden />
          </EmptyMedia>
          <EmptyTitle>Waiting for transcription</EmptyTitle>
          <EmptyDescription>
            {archiveFailed
              ? 'Recording continues, but the audio can’t be saved on this Mac right now, so what is said while transcription is offline may be lost.'
              : 'Your audio is still being recorded and saved on this Mac. The transcript fills in when the connection is back.'}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <Empty className="flex-1 px-8" data-testid="transcript-empty">
      <EmptyHeader>
        <EmptyMedia
          variant="icon"
          className={listening ? 'bg-brand-100 text-brand-900' : undefined}
        >
          <IconWaveSine aria-hidden className={cn(listening && 'animate-pulse')} />
        </EmptyMedia>
        <EmptyTitle>{listening ? 'Listening…' : 'No transcript yet'}</EmptyTitle>
        <EmptyDescription>
          {listening
            ? 'What you and the other side say appears here as it’s spoken.'
            : past
              ? 'Nothing was transcribed for this note. Record to add to it.'
              : 'Start recording to transcribe your microphone (you) and your computer’s audio (them), live.'}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
