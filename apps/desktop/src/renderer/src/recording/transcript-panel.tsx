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
  AlertCircleIcon,
  AudioLinesIcon,
  HistoryIcon,
  Loader2Icon,
  WifiOffIcon,
} from 'lucide-react';

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
  recovered: 'border-warning/40 bg-warning/10',
  filling: 'border-border bg-muted/50 text-muted-foreground',
  retrying: 'border-warning/40 bg-warning/10',
  failed: 'border-destructive/30 bg-destructive/10 text-destructive',
  filled: 'border-border bg-muted/50 text-muted-foreground',
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
            'flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs',
            NOTICE_TONE[n.kind],
          )}
        >
          {n.kind === 'filling' ? (
            <Loader2Icon aria-hidden className="mt-px size-3.5 shrink-0 animate-spin" />
          ) : n.kind === 'filled' ? (
            <HistoryIcon aria-hidden className="mt-px size-3.5 shrink-0" />
          ) : (
            <AlertCircleIcon
              aria-hidden
              className={cn(
                'mt-px size-3.5 shrink-0',
                n.kind === 'failed' ? 'text-destructive' : 'text-warning',
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
        className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
        data-testid="transcript-loading"
      >
        <Loader2Icon aria-hidden className="size-5 animate-spin" />
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
      <div
        className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center"
        data-testid="transcript-empty"
      >
        <div className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <WifiOffIcon aria-hidden className="size-5" />
        </div>
        <div className="flex flex-col gap-1">
          <p className="font-heading text-lg font-medium">Waiting for transcription</p>
          <p className="max-w-xs text-sm text-muted-foreground">
            {archiveFailed
              ? 'Recording continues, but the audio can’t be saved on this Mac right now, so what is said while transcription is offline may be lost.'
              : 'Your audio is still being recorded and saved on this Mac. The transcript fills in when the connection is back.'}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center"
      data-testid="transcript-empty"
    >
      <div className="flex size-11 items-center justify-center rounded-full bg-accent text-accent-foreground">
        <AudioLinesIcon aria-hidden className={cn('size-5', listening && 'animate-pulse')} />
      </div>
      <div className="flex flex-col gap-1">
        <p className="font-heading text-lg font-medium">
          {listening ? 'Listening…' : 'No transcript yet'}
        </p>
        <p className="max-w-xs text-sm text-muted-foreground">
          {listening
            ? 'What you and the other side say appears here as it’s spoken.'
            : past
              ? 'Nothing was transcribed for this note. Record to add to it.'
              : 'Start recording to transcribe your microphone (you) and your computer’s audio (them), live.'}
        </p>
      </div>
    </div>
  );
}
