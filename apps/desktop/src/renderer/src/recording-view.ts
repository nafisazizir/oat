/**
 * Pure helpers for the recording UI (bar, widget, transcript panel). No React, unit-tested.
 */
import type { RecordingSnapshot, SttStreamStatus, LiveSegment } from '@oat/core/bridge';

export type TranscriptionHealth = 'off' | 'connecting' | 'live' | 'reconnecting' | 'offline';

/**
 * One word for both STT streams, worst first: `offline` (a stream gave up), `reconnecting`,
 * `connecting`, `live` (every open stream is live), `off` (no streams).
 */
export function transcriptionHealth(stt: RecordingSnapshot['stt']): TranscriptionHealth {
  const all: SttStreamStatus[] = [stt.mic, stt.system];
  const active = all.filter((s) => s !== 'idle' && s !== 'closed');
  if (active.length === 0) return 'off';
  if (active.includes('error')) return 'offline';
  if (active.includes('reconnecting')) return 'reconnecting';
  if (active.includes('connecting')) return 'connecting';
  return 'live';
}

export const HEALTH_LABEL: Record<TranscriptionHealth, string> = {
  off: 'Transcription off',
  connecting: 'Connecting…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  offline: 'Transcription offline',
};

/** A source's audio file stopped being written (fatal archive issue): the recording isn't being kept. */
export function archiveFailed(snapshot: RecordingSnapshot | null): boolean {
  return !!snapshot?.issues.some((i) => i.scope === 'archive' && i.fatal);
}

/** Meter fill 0–1 from dBFS: −60 dB and below is empty, 0 dB full. */
export function levelFill(db: number | undefined | null): number {
  if (db === undefined || db === null || !Number.isFinite(db)) return 0;
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

/** Recorded time now: the snapshot's figure, ticked forward while recording. */
export function elapsedNow(snapshot: RecordingSnapshot | null, now: number): number {
  if (!snapshot) return 0;
  if (snapshot.status !== 'recording') return snapshot.elapsedMs;
  return snapshot.elapsedMs + Math.max(0, now - snapshot.elapsedAt);
}

/** Recording, paused or on its way: the controls show Pause/Resume + Stop. */
export function isActive(status: RecordingSnapshot['status'] | undefined): boolean {
  return status === 'starting' || status === 'recording' || status === 'paused';
}

/** Show the speaker/time header above a segment when the speaker changes or after a long pause. */
export function startsGroup(
  segment: LiveSegment,
  previous: LiveSegment | undefined,
  gapMs = 30_000,
): boolean {
  return (
    !previous || previous.source !== segment.source || segment.startMs - previous.endMs > gapMs
  );
}

/** Near the bottom of a scroll container (autoscroll keeps following the live end). */
export function isNearBottom(
  el: { scrollTop: number; scrollHeight: number; clientHeight: number },
  slack = 48,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}
