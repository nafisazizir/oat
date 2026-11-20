export type PlaybackSource = 'mic' | 'system' | 'mix';
export interface PlaybackPart {
  part: number;
  startMs: number;
  endMs: number;
  sources: ('mic' | 'system')[];
  partial: boolean;
}
export interface PlaybackInfo {
  meetingId: string;
  status: 'available' | 'recording' | 'deleted' | 'other-device' | 'none';
  url: string | null;
  durationMs: number;
  parts: PlaybackPart[];
}
export const PLAYBACK_SPEEDS = [1, 1.25, 1.5, 2] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

/** ←/→ (and the scrubber's arrow keys) move this far. */
export const SEEK_STEP_MS = 5_000;
/** Holes shorter than this are just played through (silence) rather than skipped. */
export const SKIP_GAP_MIN_MS = 750;

export const SOURCE_LABELS: Record<PlaybackSource, string> = {
  mic: 'Me',
  system: 'Them',
  mix: 'Both',
};

export function availablePlaybackSource(
  preferred: PlaybackSource,
  parts: readonly PlaybackPart[],
): PlaybackSource {
  if (preferred === 'mix' || parts.some((part) => part.sources.includes(preferred)))
    return preferred;
  return parts.some((part) => part.sources.includes('mic'))
    ? 'mic'
    : parts.some((part) => part.sources.includes('system'))
      ? 'system'
      : 'mix';
}

export function nextSpeed(speed: number): PlaybackSpeed {
  const i = PLAYBACK_SPEEDS.indexOf(speed as PlaybackSpeed);
  return PLAYBACK_SPEEDS[(i + 1) % PLAYBACK_SPEEDS.length]!;
}

export function isSpeed(value: unknown): value is PlaybackSpeed {
  return PLAYBACK_SPEEDS.includes(value as PlaybackSpeed);
}

export function isSource(value: unknown): value is PlaybackSource {
  return value === 'mic' || value === 'system' || value === 'mix';
}

export function clampMs(ms: number, durationMs: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.min(Math.max(0, ms), Math.max(0, durationMs));
}

/** The part holding meeting time `ms`, if any. */
export function partAt(parts: readonly PlaybackPart[], ms: number): PlaybackPart | undefined {
  return parts.find((p) => p.startMs <= ms && ms < p.endMs);
}

/**
 * Where a seek to `ms` should land: `ms` itself inside a part; in a hole between parts (or before the
 * first) the start of the next part, so a click never lands on silence; past the last part its end.
 */
export function seekTarget(parts: readonly PlaybackPart[], ms: number, durationMs: number): number {
  const t = clampMs(ms, durationMs);
  if (parts.length === 0 || partAt(parts, t)) return t;
  const next = parts.find((p) => p.startMs > t);
  return next ? next.startMs : clampMs(parts.at(-1)!.endMs, durationMs);
}

/**
 * While playing: if the playhead is in a hole between parts that is worth skipping (≥ `SKIP_GAP_MIN_MS`),
 * the start of the next part; else `null` (keep playing).
 */
export function skipGap(parts: readonly PlaybackPart[], ms: number): number | null {
  if (parts.length === 0 || partAt(parts, ms)) return null;
  const next = parts.find((p) => p.startMs > ms);
  if (!next) return null;
  const prevEnd = parts.reduce((end, p) => (p.endMs <= ms ? Math.max(end, p.endMs) : end), 0);
  return next.startMs - prevEnd >= SKIP_GAP_MIN_MS ? next.startMs : null;
}

export interface ScrubberSpan {
  kind: 'part' | 'gap';
  /** Percent of the scrubber's width. */
  left: number;
  width: number;
  startMs: number;
  endMs: number;
  part?: number;
  partial?: boolean;
}

/** The scrubber's spans: each part, and each hole between/around parts (≥ 0.1 % wide to be drawn). */
export function scrubberSpans(parts: readonly PlaybackPart[], durationMs: number): ScrubberSpan[] {
  if (!(durationMs > 0)) return [];
  const pct = (ms: number) => (clampMs(ms, durationMs) / durationMs) * 100;
  const spans: ScrubberSpan[] = [];
  let at = 0;
  const gap = (from: number, to: number) => {
    if (pct(to) - pct(from) >= 0.1) {
      spans.push({
        kind: 'gap',
        left: pct(from),
        width: pct(to) - pct(from),
        startMs: from,
        endMs: to,
      });
    }
  };
  for (const p of parts) {
    if (p.startMs > at) gap(at, p.startMs);
    spans.push({
      kind: 'part',
      left: pct(p.startMs),
      width: pct(p.endMs) - pct(p.startMs),
      startMs: p.startMs,
      endMs: p.endMs,
      part: p.part,
      partial: p.partial,
    });
    at = Math.max(at, p.endMs);
  }
  if (durationMs > at) gap(at, durationMs);
  return spans;
}

export interface PlaybackNotice {
  title: string;
  detail: string;
}

/** What the player area says when there is nothing to play. `null` = show the player. */
export function playbackNotice(status: PlaybackInfo['status']): PlaybackNotice | null {
  switch (status) {
    case 'available':
      return null;
    case 'recording':
      return {
        title: 'Recording',
        detail: 'You can listen back once the recording stops.',
      };
    case 'deleted':
      return {
        title: 'Audio deleted',
        detail: 'The audio was removed from this Mac. The transcript and your notes are kept.',
      };
    case 'other-device':
      return {
        title: 'Audio is on another device',
        detail: 'Audio stays on the Mac that recorded it. Open this note there to listen back.',
      };
    case 'none':
      return {
        title: 'No audio',
        detail: 'No audio was saved for this note.',
      };
  }
}

/**
 * A tiny external store for the playhead (meeting ms). The player writes it every animation frame while
 * playing; React components read it with `useSyncExternalStore` and a coarse snapshot (the active segment
 * id, the time at 10 Hz), so the meeting view re-renders only when what it shows changes.
 */
export class PlaybackClock {
  #ms = 0;
  readonly #listeners = new Set<() => void>();

  get ms(): number {
    return this.#ms;
  }

  set(ms: number): void {
    if (ms === this.#ms) return;
    this.#ms = ms;
    for (const listener of this.#listeners) listener();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
}
