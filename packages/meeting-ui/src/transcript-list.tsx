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
 * - `activeId`: the line under the playback head (3.7, `activeSegmentAt`): highlighted and kept in view while
 *   the user hasn't scrolled the list themselves (wheel, touch, scrollbar, keys); then "Back to playback"
 *   offers the way back. `playheadKey` changing (the user seeked) follows the playhead again.
 */
import { Button } from '@oat/ui/components/button';
import { cn } from '@oat/ui/lib/utils';
import { useVirtualizer } from '@tanstack/react-virtual';
import { IconArrowDown, IconWaveSine } from '@tabler/icons-react';
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
  /** The line under the playback head: highlighted (`data-active`) and kept in view. */
  activeId?: string | undefined;
  /** Bumped when the user seeks: the list follows the playhead again even if they had scrolled away. */
  playheadKey?: number;
  /** Changes when another meeting is shown (the live view starts at the bottom again). */
  resetKey?: string | null;
  className?: string;
}

export function TranscriptList({
  segments,
  follow = false,
  focusId,
  onSelect,
  activeId,
  playheadKey,
  resetKey,
  className,
}: TranscriptListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(follow);
  const followingRef = useRef(follow);
  const programmatic = useRef(false);
  // Playback: keep the active line in view until the user scrolls the list themselves.
  const [tracking, setTracking] = useState(true);
  const trackingRef = useRef(true);

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
    // Playback (an active line) owns the scroll position; the live end never pulls it away.
    if (follow && followingRef.current && !focusId && !activeId) scrollToEnd();
  }, [segments, scrollToEnd, follow, focusId, activeId]);

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

  // The line under the playhead: into view (centred) when it isn't fully visible, while tracking.
  const activeIndex = activeId ? segments.findIndex((s) => s.id === activeId) : -1;
  const revealActive = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller || activeIndex < 0 || !activeId) return;
    const el = scroller.querySelector<HTMLElement>(`[data-segment-id="${CSS.escape(activeId)}"]`);
    if (el) {
      const r = el.getBoundingClientRect();
      const b = scroller.getBoundingClientRect();
      if (r.top >= b.top + 8 && r.bottom <= b.bottom - 8) return;
    }
    const target = virtualizer.getOffsetForIndex(activeIndex, 'center');
    if (!target) return;
    // Ours, not the user's: `onScroll` must not read it as "left the live end".
    programmatic.current = true;
    scroller.scrollTop = target[0];
    requestAnimationFrame(() => (programmatic.current = false));
  }, [activeId, activeIndex, virtualizer]);
  useEffect(() => {
    if (trackingRef.current) revealActive();
  }, [revealActive]);
  useEffect(() => {
    if (playheadKey === undefined) return;
    trackingRef.current = true;
    setTracking(true);
    revealActive();
    // Only a seek re-arms tracking; the active line moving on its own is handled above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playheadKey]);

  /** The user scrolls the list (not us): stop moving it under them while audio plays. */
  const userScrolls = () => {
    if (!activeId || !trackingRef.current) return;
    trackingRef.current = false;
    setTracking(false);
  };
  const backToPlayhead = () => {
    trackingRef.current = true;
    setTracking(true);
    revealActive();
  };

  const onScroll = () => {
    const el = scrollRef.current;
    // While a line is playing, playback owns the scroll (live follow and playhead tracking never both run).
    if (!follow || activeId || !el || programmatic.current) return;
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
        onWheel={userScrolls}
        onTouchMove={userScrolls}
        onPointerDown={(event) => {
          // The scrollbar only: a press on the scroller itself, right of its content box (not the padding).
          const el = event.currentTarget;
          if (event.target !== el) return;
          const x = event.clientX - el.getBoundingClientRect().left;
          if (el.offsetWidth > el.clientWidth && x >= el.clientLeft + el.clientWidth) userScrolls();
        }}
        onKeyDown={(event) => {
          if (['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
            userScrolls();
          }
        }}
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
                    active={segment.id === activeId}
                    onSelect={onSelect}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {follow && !activeId && !following && segments.length > 0 && (
        <Button
          size="sm"
          variant="secondary"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 material-menu"
          onClick={jumpToLive}
          data-testid="jump-to-live"
        >
          <IconArrowDown data-icon="inline-start" />
          Jump to live
        </Button>
      )}
      {activeId && !tracking && (
        <Button
          size="sm"
          variant="secondary"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 material-menu"
          onClick={backToPlayhead}
          data-testid="back-to-playhead"
        >
          <IconWaveSine data-icon="inline-start" />
          Back to playback
        </Button>
      )}
    </div>
  );
}

function SegmentRow({
  segment,
  header,
  focused,
  active,
  onSelect,
}: {
  segment: TranscriptItem;
  header: boolean;
  focused: boolean;
  active: boolean;
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
      data-active={active || undefined}
      aria-current={focused ? 'true' : active ? 'time' : undefined}
    >
      {header && (
        <div className="mb-1 flex items-baseline gap-2 px-1">
          <span className="text-label-12 text-gray-1000">{speaker}</span>
          <time
            className="text-label-12-mono text-gray-900 tabular-nums"
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
          'max-w-[85%] rounded-lg bg-gray-100 px-3.5 py-2 text-copy-14 text-gray-1000 transition-[background-color,box-shadow] duration-100',
          // Interim: a step lighter on the ramp, still ≥ 4.5:1 on the bubble (9.3b).
          !final && 'text-gray-900 italic',
          onSelect &&
            cn(
              'cursor-pointer outline-none focus-visible:ring-3 focus-visible:ring-gray-600/50',
              'hover:bg-gray-200',
            ),
          active && 'ring-2 ring-gray-1000',
          focused && 'ring-2 ring-brand-600 ring-offset-2 ring-offset-background-100',
        )}
      >
        {segment.text}
      </p>
    </div>
  );
}
