'use client';
import { formatClock } from './format.ts';
import type { PlaybackInfo, PlaybackSource } from './playback.ts';
import { Badge } from '@oat/ui/components/badge';
import { Button } from '@oat/ui/components/button';
import { cn } from '@oat/ui/lib/utils';
import { Spinner } from '@oat/ui/components/spinner';
import {
  IconAlertCircle,
  IconDeviceLaptop,
  IconMicrophone,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconRotate,
  IconTrash,
} from '@tabler/icons-react';
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useRef,
  useEffect,
  useSyncExternalStore,
} from 'react';
import {
  clampMs,
  type PlaybackClock,
  playbackNotice,
  SEEK_STEP_MS,
  SOURCE_LABELS,
  scrubberSpans,
} from './playback.ts';
export interface MeetingPlayback {
  /** `null` while loading (or no meeting). */
  info: PlaybackInfo | null;
  /** The audio can be played now. */
  available: boolean;
  loadError: string | null;
  playError: string | null;
  playing: boolean;
  buffering: boolean;
  clock: PlaybackClock;
  /** Bumped on every user seek (the transcript follows the playhead again). */
  seekCount: number;
  source: PlaybackSource;
  sourceOptions?: readonly PlaybackSource[];
  speed: number;
  seek: (ms: number) => void;
  seekBy: (deltaMs: number) => void;
  toggle: () => void;
  pause: () => void;
  setSource: (source: PlaybackSource) => void;
  cycleSpeed: () => void;
  retry: () => void;
}

const DRAG_SEEK_MS = 100;
/** Is a key event for the player? (Not typing, not on a control that handles the key itself.) */
export function playerKey(event: KeyboardEvent<HTMLElement>, player: MeetingPlayback): boolean {
  if (
    !player.available ||
    event.defaultPrevented ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey
  ) {
    return false;
  }
  const target = event.target as HTMLElement;
  if (target.closest('input, textarea, select, [contenteditable="true"], [role="separator"]')) {
    return false;
  }
  if (event.key === ' ') {
    // Buttons and transcript lines act on Space themselves.
    if (target.closest('button, [role="button"], [role="radio"]')) return false;
    event.preventDefault();
    player.toggle();
    return true;
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    if (target.closest('[role="slider"], [role="radio"]')) return false;
    event.preventDefault();
    player.seekBy(event.key === 'ArrowLeft' ? -SEEK_STEP_MS : SEEK_STEP_MS);
    return true;
  }
  return false;
}

export function PlaybackBar({ player }: { player: MeetingPlayback }) {
  const { info, loadError } = player;
  if (info?.status === 'none') return null;
  if (loadError && !info) {
    return (
      <PlayerFrame state="error">
        <Notice icon={<IconAlertCircle />} title="Couldn’t load the audio" detail={loadError}>
          <Button variant="ghost" size="xs" onClick={player.retry}>
            <IconRotate data-icon="inline-start" />
            Retry
          </Button>
        </Notice>
      </PlayerFrame>
    );
  }
  if (!info) {
    return (
      <PlayerFrame state="loading">
        <div className="flex h-8 items-center gap-2 text-label-13 text-gray-900">
          <Spinner aria-hidden className="size-3.5" />
          Loading audio…
        </div>
      </PlayerFrame>
    );
  }
  const notice = playbackNotice(info.status);
  if (notice) {
    const icon =
      info.status === 'deleted' ? (
        <IconTrash />
      ) : info.status === 'other-device' ? (
        <IconDeviceLaptop />
      ) : (
        <IconMicrophone />
      );
    return (
      <PlayerFrame state={info.status}>
        <Notice icon={icon} title={notice.title} detail={notice.detail} />
      </PlayerFrame>
    );
  }
  if (player.playError) {
    return (
      <PlayerFrame state="error">
        <Notice icon={<IconAlertCircle />} title="Couldn’t play the audio" detail="Try again.">
          <Button variant="ghost" size="xs" onClick={player.retry}>
            <IconRotate data-icon="inline-start" />
            Retry
          </Button>
        </Notice>
      </PlayerFrame>
    );
  }
  return <Player player={player} info={info} />;
}

function PlayerFrame({ state, children }: { state: string; children: ReactNode }) {
  return (
    <div
      className="shrink-0 border-b border-gray-alpha-400 px-3 py-2"
      data-testid="playback"
      data-state={state}
      role="region"
      aria-label="Audio playback"
    >
      {children}
    </div>
  );
}

function Notice({
  icon,
  title,
  detail,
  children,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5" data-testid="playback-notice">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-gray-100 text-gray-900 [&_svg]:size-3.5">
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="text-label-13 text-gray-1000" data-testid="playback-notice-title">
          {title}
        </p>
        <p className="text-copy-13 text-gray-900">{detail}</p>
      </div>
      {children}
    </div>
  );
}

function Player({ player, info }: { player: MeetingPlayback; info: PlaybackInfo }) {
  const { clock } = player;
  // 10 Hz is plenty for the time text and the thumb.
  const tenths = useSyncExternalStore(clock.subscribe, () => Math.round(clock.ms / 100));
  const ms = tenths * 100;
  const partial = info.parts.some((p) => p.partial);
  return (
    <PlayerFrame state={player.playing ? 'playing' : 'paused'}>
      <div className="flex flex-col gap-1.5" data-current-ms={Math.round(ms)}>
        <div className="flex items-center gap-2">
          <Button
            size="icon-sm"
            variant="default"
            onClick={player.toggle}
            aria-label={player.playing ? 'Pause' : 'Play'}
            title={player.playing ? 'Pause (Space)' : 'Play (Space)'}
            data-testid="playback-toggle"
          >
            {player.buffering && player.playing ? (
              <Spinner aria-hidden />
            ) : player.playing ? (
              <IconPlayerPauseFilled />
            ) : (
              <IconPlayerPlayFilled />
            )}
          </Button>
          <span
            className="text-label-12-mono text-gray-900 tabular-nums"
            data-testid="playback-time"
          >
            <span className="text-gray-1000">{formatClock(ms)}</span> /{' '}
            {formatClock(info.durationMs)}
          </span>
          {partial && (
            <Badge
              variant="secondary"
              title="Part of this recording was recovered after the app quit unexpectedly."
            >
              Partial
            </Badge>
          )}
          <div className="ms-auto flex items-center gap-1">
            {info.parts.some((part) => part.sources.includes('mic')) &&
              info.parts.some((part) => part.sources.includes('system')) && (
                <SourceToggle
                  value={player.source}
                  onChange={player.setSource}
                  available={player.sourceOptions}
                />
              )}
            <Button
              variant="ghost"
              size="xs"
              className="w-11 text-label-12-mono tabular-nums"
              onClick={player.cycleSpeed}
              aria-label={`Playback speed ${player.speed}×`}
              title="Playback speed"
              data-testid="playback-speed"
            >
              {player.speed}×
            </Button>
          </div>
        </div>
        <Scrubber player={player} info={info} ms={ms} />
      </div>
    </PlayerFrame>
  );
}

function SourceToggle({
  value,
  onChange,
  available,
}: {
  value: PlaybackSource;
  onChange: (source: PlaybackSource) => void;
  available?: readonly PlaybackSource[] | undefined;
}) {
  const order: PlaybackSource[] = ['mic', 'system', 'mix'];
  const enabled = order.filter((source) => !available || available.includes(source));
  const move = (event: KeyboardEvent, delta: number) => {
    event.preventDefault();
    const next = enabled[(enabled.indexOf(value) + delta + enabled.length) % enabled.length];
    if (!next) return;
    onChange(next);
    (
      event.currentTarget.parentElement?.querySelector(`[data-source="${next}"]`) as HTMLElement
    )?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label="Listen to"
      className="flex h-6 items-center rounded-md bg-gray-100 p-0.5"
      data-testid="playback-source"
    >
      {order.map((s) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={value === s}
          disabled={!!available && !available.includes(s)}
          tabIndex={value === s ? 0 : -1}
          data-source={s}
          onClick={() => onChange(s)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') move(event, 1);
            else if (event.key === 'ArrowLeft') move(event, -1);
          }}
          className={cn(
            'min-h-6 rounded-md px-1.5 text-label-12 text-gray-900 transition-colors outline-none hover:text-gray-1000 focus-visible:ring-3 focus-visible:ring-gray-600/50 disabled:cursor-not-allowed disabled:text-gray-700',
            value === s && 'bg-background-100 text-gray-1000 ring-1 ring-gray-alpha-400',
          )}
        >
          {SOURCE_LABELS[s]}
        </button>
      ))}
    </div>
  );
}

function Scrubber({
  player,
  info,
  ms,
}: {
  player: MeetingPlayback;
  info: PlaybackInfo;
  ms: number;
}) {
  const track = useRef<HTMLDivElement>(null);
  const duration = info.durationMs;
  const spans = scrubberSpans(info.parts, duration);
  const pct = duration > 0 ? (clampMs(ms, duration) / duration) * 100 : 0;
  const multi = info.parts.length > 1;

  const msAt = (clientX: number) => {
    const box = track.current?.getBoundingClientRect();
    if (!box || box.width === 0) return 0;
    return ((clientX - box.left) / box.width) * duration;
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    lastSeek.current = performance.now();
    player.seek(msAt(event.clientX));
  };
  // Dragging seeks at most ~10 times a second (each seek is a new range request + decode in main); the
  // last position always lands (trailing call, and on release).
  const lastSeek = useRef(0);
  const pending = useRef<number | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => () => window.clearTimeout(timer.current ?? undefined), []);
  const flushDrag = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (pending.current === null) return;
    lastSeek.current = performance.now();
    player.seek(pending.current);
    pending.current = null;
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    pending.current = msAt(event.clientX);
    const wait = DRAG_SEEK_MS - (performance.now() - lastSeek.current);
    if (wait <= 0) flushDrag();
    else if (timer.current === null) timer.current = window.setTimeout(flushDrag, wait);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step: Record<string, number> = {
      ArrowLeft: -SEEK_STEP_MS,
      ArrowDown: -SEEK_STEP_MS,
      ArrowRight: SEEK_STEP_MS,
      ArrowUp: SEEK_STEP_MS,
      PageDown: -30_000,
      PageUp: 30_000,
    };
    if (event.key in step) player.seekBy(step[event.key]!);
    else if (event.key === 'Home') player.seek(0);
    else if (event.key === 'End') player.seek(duration);
    else if (event.key === ' ') player.toggle();
    else return;
    event.preventDefault();
  };

  return (
    <div
      ref={track}
      role="slider"
      tabIndex={0}
      aria-label="Playback position"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration / 1000)}
      aria-valuenow={Math.round(ms / 1000)}
      aria-valuetext={`${formatClock(ms)} of ${formatClock(duration)}`}
      data-testid="playback-scrubber"
      className="group relative flex h-4 cursor-pointer touch-none items-center rounded outline-none focus-visible:ring-3 focus-visible:ring-gray-600/50"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={flushDrag}
      onPointerCancel={flushDrag}
      onKeyDown={onKeyDown}
    >
      {spans.map((s) =>
        s.kind === 'part' ? (
          <div
            key={`p${s.part}`}
            data-testid="playback-part"
            data-part={s.part}
            title={
              multi
                ? `Recording ${s.part}: ${formatClock(s.startMs)}–${formatClock(s.endMs)}`
                : undefined
            }
            className={cn(
              'absolute h-1 overflow-hidden rounded-full bg-gray-alpha-400',
              s.partial &&
                'bg-[repeating-linear-gradient(90deg,var(--color-gray-alpha-400)_0_4px,transparent_4px_6px)]',
            )}
            // Back-to-back sessions: a 3 px notch shows where one recording ends and the next begins.
            style={{
              left: `${s.left}%`,
              width: multi ? `max(calc(${s.width}% - 3px), 2px)` : `max(${s.width}%, 2px)`,
            }}
          >
            <div
              className="h-full bg-brand-700"
              style={{
                width: `${Math.min(100, Math.max(0, ((pct - s.left) / Math.max(s.width, 1e-6)) * 100))}%`,
              }}
            />
          </div>
        ) : (
          <div
            key={`g${s.startMs}`}
            data-testid="playback-gap"
            title={`No audio ${formatClock(s.startMs)}–${formatClock(s.endMs)}`}
            className="absolute h-px border-t border-dashed border-gray-alpha-600"
            style={{ left: `${s.left}%`, width: `${s.width}%` }}
          />
        ),
      )}
      <div
        aria-hidden
        className="absolute size-3 -translate-x-1/2 rounded-full border-2 border-background-100 bg-brand-700 transition-transform group-hover:scale-110"
        style={{ left: `${pct}%` }}
      />
    </div>
  );
}
