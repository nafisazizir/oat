/**
 * Live transcript (2.5): a virtualised list of segments, "me" (mic) on the right in the ink bubble and
 * "them" (system audio) on the left in the oat bubble, interims italic and muted until their final
 * replaces them. Follows the live end while the user is at the bottom; scrolling up stops that and offers
 * "Jump to live".
 */
import type { RecordingSnapshot, LiveSegment } from '@oat/core/bridge';
import { Button } from '@oat/ui/components/button';
import { cn } from '@oat/ui/lib/utils';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDownIcon, AudioLinesIcon, Loader2Icon, WifiOffIcon } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { formatClock } from '../../../shared/transcript.ts';
import {
  archiveFailed,
  isNearBottom,
  startsGroup,
  type TranscriptionHealth,
  transcriptionHealth,
} from '../recording-view.ts';
import type { TranscriptView } from '../recording-state.ts';

export function TranscriptPanel({
  transcript,
  snapshot,
}: {
  transcript: TranscriptView;
  snapshot: RecordingSnapshot | null;
}) {
  const segments = transcript.segments;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  const programmatic = useRef(false);

  // The virtualizer is a mutable object read during render; React Compiler correctly skips memoizing
  // this component, which is what we want.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: segments.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 10,
    getItemKey: (index) => segments[index]!.id,
    paddingStart: 16,
    paddingEnd: 24,
  });

  const scrollToEnd = useCallback(() => {
    if (segments.length === 0) return;
    programmatic.current = true;
    virtualizer.scrollToIndex(segments.length - 1, { align: 'end' });
    requestAnimationFrame(() => {
      // Measured heights can grow the list after the first jump: settle at the very bottom.
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      programmatic.current = false;
    });
  }, [segments.length, virtualizer]);

  // New or updated segments: stay on the live end if the user is following it.
  useLayoutEffect(() => {
    if (followingRef.current) scrollToEnd();
  }, [segments, scrollToEnd]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || programmatic.current) return;
    const atBottom = isNearBottom(el);
    followingRef.current = atBottom;
    setFollowing(atBottom);
  };

  const jumpToLive = () => {
    followingRef.current = true;
    setFollowing(true);
    scrollToEnd();
  };

  // A new meeting starts at the live end again.
  useEffect(() => {
    followingRef.current = true;
    setFollowing(true);
  }, [transcript.meetingId]);

  const status = snapshot?.status ?? 'idle';
  const items = virtualizer.getVirtualItems();

  return (
    <section
      aria-label="Live transcript"
      className="relative flex min-h-0 flex-1 flex-col"
      data-testid="transcript"
      data-count={segments.length}
    >
      {segments.length === 0 ? (
        <EmptyTranscript
          status={status}
          loaded={transcript.loaded}
          health={snapshot ? transcriptionHealth(snapshot.stt) : 'off'}
          failed={transcript.failed}
          archiveFailed={archiveFailed(snapshot)}
        />
      ) : (
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto px-6"
          data-testid="transcript-scroll"
        >
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            <div
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${items[0]?.start ?? 0}px)` }}
            >
              {items.map((item) => {
                const segment = segments[item.index]!;
                return (
                  <div key={item.key} data-index={item.index} ref={virtualizer.measureElement}>
                    <SegmentRow
                      segment={segment}
                      header={startsGroup(segment, segments[item.index - 1])}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
      {!following && segments.length > 0 && (
        <Button
          size="sm"
          variant="secondary"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 shadow-md"
          onClick={jumpToLive}
          data-testid="jump-to-live"
        >
          <ArrowDownIcon data-icon="inline-start" />
          Jump to live
        </Button>
      )}
    </section>
  );
}

function SegmentRow({ segment, header }: { segment: LiveSegment; header: boolean }) {
  const me = segment.source === 'mic';
  return (
    <div
      className={cn('flex flex-col pb-1.5', me ? 'items-end' : 'items-start', header && 'pt-3')}
      data-testid="transcript-segment"
      data-source={segment.source}
      data-final={segment.isFinal}
      data-id={segment.id}
    >
      {header && (
        <div className="mb-1 flex items-baseline gap-2 px-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/80">{me ? 'Me' : 'Them'}</span>
          <time
            className="font-mono tabular-nums"
            dateTime={`PT${Math.floor(segment.startMs / 1000)}S`}
          >
            {formatClock(segment.startMs)}
          </time>
        </div>
      )}
      <p
        data-selectable
        className={cn(
          'max-w-[78%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed',
          me
            ? 'rounded-br-md bg-me text-me-foreground'
            : 'rounded-bl-md bg-them text-them-foreground',
          !segment.isFinal && 'italic opacity-60',
        )}
      >
        {segment.text}
      </p>
    </div>
  );
}

function EmptyTranscript({
  status,
  loaded,
  health,
  failed,
  archiveFailed,
}: {
  status: RecordingSnapshot['status'];
  loaded: boolean;
  health: TranscriptionHealth;
  failed: boolean;
  archiveFailed: boolean;
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
            : 'Start recording to transcribe your microphone (you) and your computer’s audio (them), live.'}
        </p>
      </div>
    </div>
  );
}
