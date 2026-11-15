/**
 * Pure helpers for the meeting view (desktop + web): clock and duration text, transcript grouping, the
 * meeting's time line, participant initials, panel width clamping. No React, no DOM; unit-tested.
 */

/** One transcript segment as the meeting view shows it (a live segment or a stored final). */
export interface TranscriptItem {
  /** Stable segment id (D-19). */
  id: string;
  /** `mic` = me, `system` = the others on the call. */
  source: 'mic' | 'system';
  /** On the meeting clock (ms since the meeting's first recording started). */
  startMs: number;
  endMs?: number;
  text: string;
  /** Default true. Interims are shown italic and muted until their final replaces them. */
  isFinal?: boolean;
  /** Label instead of "Me" / "Them" (a diarised speaker). */
  speaker?: string;
}

export interface Participant {
  id: string;
  name: string;
  email: string | null;
  /** `calendar` = from the event's attendee list; `manual` = added by hand. */
  source: 'calendar' | 'manual';
}

/** `m:ss`, or `h:mm:ss` from an hour on. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "under a minute", "12 min", "1 h", "1 h 5 min". */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'under a minute';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** Speaker label of a segment: its own, else "Me" (mic) / "Them" (system audio). */
export function speakerOf(item: Pick<TranscriptItem, 'source' | 'speaker'>): string {
  return item.speaker?.trim() || (item.source === 'mic' ? 'Me' : 'Them');
}

/** Show the speaker/time header above a segment when the speaker changes or after a long pause. */
export function startsGroup(
  segment: Pick<TranscriptItem, 'source' | 'speaker' | 'startMs'>,
  previous: Pick<TranscriptItem, 'source' | 'speaker' | 'startMs' | 'endMs'> | undefined,
  gapMs = 30_000,
): boolean {
  return (
    !previous ||
    previous.source !== segment.source ||
    speakerOf(previous) !== speakerOf(segment) ||
    segment.startMs - (previous.endMs ?? previous.startMs) > gapMs
  );
}

/** Near the bottom of a scroll container (autoscroll keeps following the live end). */
export function isNearBottom(
  el: { scrollTop: number; scrollHeight: number; clientHeight: number },
  slack = 48,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}

/** Time order; ties by source (me first) then id, so every view shows the same order. */
export function compareTranscriptItems(a: TranscriptItem, b: TranscriptItem): number {
  return (
    a.startMs - b.startMs ||
    (a.source === b.source ? 0 : a.source === 'mic' ? -1 : 1) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * Stored finals and live segments of one meeting as one list: a live segment replaces the stored row with
 * its id (it is newer), everything in time order. Used while a meeting is recorded again (a new part).
 */
export function mergeTranscripts(
  stored: readonly TranscriptItem[],
  live: readonly TranscriptItem[],
): TranscriptItem[] {
  if (live.length === 0) return [...stored];
  if (stored.length === 0) return [...live];
  const byId = new Map<string, TranscriptItem>();
  for (const s of stored) byId.set(s.id, s);
  for (const s of live) byId.set(s.id, s);
  return [...byId.values()].sort(compareTranscriptItems);
}

/** Up to two initials ("Ada Lovelace" → "AL", "ada@x.io" → "A"). */
export function initials(name: string): string {
  const words = name
    .replace(/@.*$/, '')
    .split(/[\s._-]+/)
    .filter(Boolean);
  const letters = words.length > 1 ? [words[0]!, words.at(-1)!] : words.slice(0, 1);
  return letters.map((w) => w.charAt(0).toUpperCase()).join('') || '?';
}

/** A meeting counts as in progress for this long without an end time (a crashed recording never ends). */
export const IN_PROGRESS_MAX_MS = 6 * 60 * 60_000;

export interface MeetingWhen {
  /** "Thu, Nov 14 · 3:04 PM"; null when the meeting was never recorded. */
  label: string | null;
  /** "12 min" once ended (or while in progress, so far). */
  duration: string | null;
  inProgress: boolean;
}

/**
 * The meeting's time line. `timeZone` undefined = the viewer's zone; the web passes `'UTC'` for the server
 * render (and the first client render) so hydration matches, then the local zone.
 */
export function meetingWhen(
  startedAt: string | null,
  endedAt: string | null,
  now: number,
  timeZone?: string,
): MeetingWhen {
  if (!startedAt) return { label: null, duration: null, inProgress: false };
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return { label: null, duration: null, inProgress: false };
  const day = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  }).format(start);
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone, timeZoneName: 'short' } : {}),
  }).format(start);
  const end = endedAt ? Date.parse(endedAt) : NaN;
  const inProgress = !Number.isFinite(end) && now - start >= 0 && now - start < IN_PROGRESS_MAX_MS;
  const duration = Number.isFinite(end)
    ? formatDuration(end - start)
    : inProgress
      ? formatDuration(now - start)
      : null;
  return { label: `${day} · ${time}`, duration, inProgress };
}

/** Short date for lists: "3:04 PM" today, "Nov 14" this year, "Nov 14, 2025" before. */
export function shortWhen(iso: string | null, now: number): string {
  if (!iso) return '';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const d = new Date(at);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(d);
  }
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  }).format(d);
}

/** A side panel width kept within `[min, max]` (and a sane default for garbage). */
export function clampWidth(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.round(Math.min(max, Math.max(min, value)));
}

/** A typed email address: plausible enough to store (the server re-checks). */
export function isPlausibleEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 320;
}

/** Segments are searched back this far from the playhead (a single line is never longer). */
const ACTIVE_LOOKBACK_MS = 5 * 60_000;

/**
 * The segment under the playhead at meeting time `ms` (playback, 3.7). `segments` are in time order (as the
 * transcript shows them). Among the lines that contain `ms` — `[startMs, endMs)`, a line without an end lasts
 * until the next one starts — the one that started last wins (the other side talking over me); in a short
 * pause (≤ `holdMs` after a line ended) that line stays highlighted; otherwise nothing is.
 */
export function activeSegmentAt(
  segments: readonly Pick<TranscriptItem, 'id' | 'startMs' | 'endMs'>[],
  ms: number,
  holdMs = 1_500,
): string | undefined {
  if (!Number.isFinite(ms)) return undefined;
  // First index whose line starts after the playhead.
  let lo = 0;
  let hi = segments.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (segments[mid]!.startMs <= ms) lo = mid + 1;
    else hi = mid;
  }
  let recent: { id: string; end: number } | undefined;
  for (let i = lo - 1; i >= 0; i--) {
    const s = segments[i]!;
    if (ms - s.startMs > ACTIVE_LOOKBACK_MS) break;
    const end = s.endMs ?? segments[i + 1]?.startMs ?? s.startMs;
    if (ms < end) return s.id;
    if (ms - end <= holdMs && (!recent || end > recent.end)) recent = { id: s.id, end };
  }
  return recent?.id;
}
