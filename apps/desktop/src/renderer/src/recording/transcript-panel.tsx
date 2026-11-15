/**
 * The meeting's transcript (2.5, 3.4): the shared virtualised list (`@oat/meeting-ui`), "me" (mic) on the
 * right, "them" (system audio) on the left, interims italic and muted until their final replaces them.
 * While this meeting is being recorded it follows the live end (scrolling up stops that and offers "Jump to
 * live"); a past meeting shows its stored transcript. The empty states explain what is (not) happening.
 */
import type { RecordingSnapshot } from '@oat/core/bridge';
import { type TranscriptItem, TranscriptList } from '@oat/meeting-ui';
import { cn } from '@oat/ui/lib/utils';
import { AudioLinesIcon, Loader2Icon, WifiOffIcon } from 'lucide-react';

import { archiveFailed, type TranscriptionHealth, transcriptionHealth } from '../recording-view.ts';

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
}) {
  const status = live ? (snapshot?.status ?? 'idle') : 'idle';
  return (
    <section
      aria-label={live ? 'Live transcript' : 'Transcript'}
      className="relative flex min-h-0 flex-1 flex-col"
      data-testid="transcript"
      data-count={segments.length}
      data-live={live || undefined}
    >
      {segments.length === 0 ? (
        <EmptyTranscript
          status={status}
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
