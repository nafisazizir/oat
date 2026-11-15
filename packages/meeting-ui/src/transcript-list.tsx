'use client';

/**
 * The meeting transcript as a virtualised list (desktop live panel, desktop past meeting, web document page):
 * "me" (mic) on the right in the ink bubble, "them" (system audio) on the left in the oat bubble, interims
 * italic and muted until their final replaces them, a speaker + time header when the speaker changes or after
 * a pause.
 *
 * - `follow`: live mode. Stays on the newest line while the user is at the bottom; scrolling up stops that
 *   and offers "Jump to live".
 * - `focusId`: a line to bring into view (centred) and highlight, e.g. a `?t=&seg=` deep link. Re-applied
 *   whenever it changes, and once the line exists (a transcript that loads later).
 * - `onSelect`: clicking a line (or Enter/Space on it) picks it: the jump target for playback (3.7).
 */
import { Button } from '@oat/ui/components/button';
import { cn } from '@oat/ui/lib/utils';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDownIcon } from 'lucide-react';
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import {
  formatClock,
  isNearBottom,
  speakerOf,
  startsGroup,
  type TranscriptItem,
} from './format.ts';

export interface TranscriptListProps {
  segments: readonly TranscriptItem[];
  follow?: boolean;
  focusId?: string | undefined;
  onSelect?: (segment: TranscriptItem) => void;
  /** Changes when another meeting is shown (the live view starts at the bottom again). */
  resetKey?: string | null;
  className?: string;
}

export function TranscriptList({
  segments,
  follow = false,
  focusId,
  onSelect,
  resetKey,
  className,
}: TranscriptListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(follow);
  const followingRef = useRef(follow);
  const programmatic = useRef(false);

  const virtualizer = useVirtualizer({
    count: segments.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 72,
    overscan: 10,
    getItemKey: (index) => segments[index]!.id,
    paddingStart: 12,
    paddingEnd: 24,
    // Before the scroller is measured (server render, first paint): render the first screenful.
    initialRect: { width: 360, height: 800 },
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
    if (follow && followingRef.current && !focusId) scrollToEnd();
  }, [segments, scrollToEnd, follow, focusId]);

  // Another meeting: back to the live end.
  useEffect(() => {
    followingRef.current = follow;
    setFollowing(follow);
  }, [resetKey, follow]);

  // Bring the focused line into view once it exists; again whenever the focus changes.
  const focusIndex = focusId ? segments.findIndex((s) => s.id === focusId) : -1;
  const focusedOnce = useRef<string | null>(null);
  useEffect(() => {
    if (focusIndex < 0 || !focusId || focusedOnce.current === focusId) return;
    focusedOnce.current = focusId;
    followingRef.current = false;
    setFollowing(false);
    const scroller = scrollRef.current;
    if (!scroller) return;
    const row = () =>
      scroller.querySelector<HTMLElement>(`[data-segment-id="${CSS.escape(focusId)}"]`);
    // Already fully on screen (e.g. the line the user just clicked): leave the scroll position alone.
    const visible = row()?.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    if (visible && visible.top >= box.top && visible.bottom <= box.bottom) return;

    programmatic.current = true;
    /** Jump to where the virtualizer thinks the row is (renders it), straight on the scroller. */
    const jump = () => {
      const target = virtualizer.getOffsetForIndex(focusIndex, 'center');
      if (target) scroller.scrollTop = target[0];
    };
    jump();
    // Rows measured taller or shorter than estimated (and late styles on a busy machine) move the target:
    // centre it on the real layout, frame by frame, until it stays put (for at most 3 s).
    const deadline = performance.now() + 3_000;
    let settled = 0;
    let frame = requestAnimationFrame(function settle() {
      const el = row();
      if (el) {
        const r = el.getBoundingClientRect();
        const b = scroller.getBoundingClientRect();
        const delta = r.top + r.height / 2 - (b.top + b.height / 2);
        if (Math.abs(delta) < 2 || b.height === 0) settled++;
        else {
          settled = 0;
          scroller.scrollTop += delta;
        }
      } else {
        settled = 0;
        jump();
      }
      if (settled < 3 && performance.now() < deadline) {
        frame = requestAnimationFrame(settle);
        return;
      }
      programmatic.current = false;
      // Never got there (e.g. hidden while loading): try again on the next change.
      if (settled < 3) focusedOnce.current = null;
    });
    return () => {
      cancelAnimationFrame(frame);
      programmatic.current = false;
      focusedOnce.current = null;
    };
  }, [focusId, focusIndex, virtualizer]);
  useEffect(() => {
    if (!focusId) focusedOnce.current = null;
  }, [focusId]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!follow || !el || programmatic.current) return;
    const atBottom = isNearBottom(el);
    followingRef.current = atBottom;
    setFollowing(atBottom);
  };

  const jumpToLive = () => {
    followingRef.current = true;
    setFollowing(true);
    scrollToEnd();
  };

  const items = virtualizer.getVirtualItems();

  return (
    <div className={cn('relative flex min-h-0 flex-1 flex-col', className)}>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-4"
        data-testid="transcript-scroll"
      >
        <div
          role="list"
          aria-label="Transcript"
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
        >
          <div
            className="absolute top-0 left-0 w-full"
            style={{ transform: `translateY(${items[0]?.start ?? 0}px)` }}
          >
            {items.map((item) => {
              const segment = segments[item.index]!;
              return (
                <div
                  key={item.key}
                  role="listitem"
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                >
                  <SegmentRow
                    segment={segment}
                    header={startsGroup(segment, segments[item.index - 1])}
                    focused={segment.id === focusId}
                    onSelect={onSelect}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {follow && !following && segments.length > 0 && (
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
    </div>
  );
}

function SegmentRow({
  segment,
  header,
  focused,
  onSelect,
}: {
  segment: TranscriptItem;
  header: boolean;
  focused: boolean;
  onSelect: ((segment: TranscriptItem) => void) | undefined;
}) {
  const me = segment.source === 'mic';
  const final = segment.isFinal !== false;
  const speaker = speakerOf(segment);
  const select = onSelect
    ? {
        role: 'button',
        tabIndex: 0,
        'aria-label': `${speaker} at ${formatClock(segment.startMs)}: ${segment.text}`,
        onClick: () => {
          // Selecting text inside a line is not a click on it.
          if (window.getSelection()?.toString()) return;
          onSelect(segment);
        },
        onKeyDown: (event: KeyboardEvent) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          onSelect(segment);
        },
      }
    : {};
  return (
    <div
      className={cn('flex flex-col pb-1.5', me ? 'items-end' : 'items-start', header && 'pt-3')}
      data-testid="transcript-segment"
      data-source={segment.source}
      data-final={final}
      data-id={segment.id}
      data-segment-id={segment.id}
      data-focused={focused || undefined}
      aria-current={focused ? 'true' : undefined}
    >
      {header && (
        <div className="mb-1 flex items-baseline gap-2 px-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/80">{speaker}</span>
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
        {...select}
        className={cn(
          'max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed transition-shadow duration-base',
          me
            ? 'rounded-br-md bg-me text-me-foreground'
            : 'rounded-bl-md bg-them text-them-foreground',
          !final && 'italic opacity-60',
          onSelect &&
            'cursor-pointer outline-none hover:ring-1 hover:ring-ring/30 focus-visible:ring-2 focus-visible:ring-ring',
          focused && 'ring-2 ring-primary/60 ring-offset-2 ring-offset-background',
        )}
      >
        {segment.text}
      </p>
    </div>
  );
}
