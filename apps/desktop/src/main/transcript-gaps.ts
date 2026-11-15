/**
 * Pure helpers for transcript back-fill (task 2.7): span math for gaps in STT coverage, and the merge of a
 * batch transcription into a transcript that already has live finals (dedupe by word midpoint, stable ids).
 * No I/O, no Electron.
 */
import { createHash } from 'node:crypto';

import type { AudioSourceKind } from '@oat/audio';
import type { SttSegmentData, SttWord } from '@oat/stt';

export interface Span {
  readonly startMs: number;
  readonly endMs: number;
}

/** Gaps shorter than this are not worth a batch request (and are within the providers' own slack). */
export const MIN_GAP_MS = 500;

/** Sorted, overlapping/touching spans joined, empty ones dropped. */
export function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = spans
    .filter((s) => s.endMs > s.startMs)
    .map((s) => ({ startMs: s.startMs, endMs: s.endMs }))
    .sort((a, b) => a.startMs - b.startMs);
  const out: { startMs: number; endMs: number }[] = [];
  for (const s of sorted) {
    const last = out.at(-1);
    if (last && s.startMs <= last.endMs) last.endMs = Math.max(last.endMs, s.endMs);
    else out.push(s);
  }
  return out;
}

/** `span` minus every span in `minus` (the remaining pieces, in order). */
export function subtractSpans(span: Span, minus: readonly Span[]): Span[] {
  let pieces: Span[] = span.endMs > span.startMs ? [span] : [];
  for (const m of mergeSpans(minus)) {
    pieces = pieces.flatMap((p) => {
      if (m.endMs <= p.startMs || m.startMs >= p.endMs) return [p];
      const out: Span[] = [];
      if (m.startMs > p.startMs) out.push({ startMs: p.startMs, endMs: m.startMs });
      if (m.endMs < p.endMs) out.push({ startMs: m.endMs, endMs: p.endMs });
      return out;
    });
  }
  return pieces;
}

/** Total length of (merged) spans. */
export function spanLength(spans: readonly Span[]): number {
  return mergeSpans(spans).reduce((n, s) => n + (s.endMs - s.startMs), 0);
}

/**
 * Per-source STT coverage of one recording session, on the recording clock (frame `tUs` / 1000): what audio
 * reached the STT stream, what the stream finalized, and what is known to be lost. `gaps()` = the ranges to
 * back-fill from the archive once the session has ended.
 */
export class SessionCoverage {
  readonly #audio = new Map<AudioSourceKind, { startMs: number; endMs: number }>();
  readonly #lost = new Map<AudioSourceKind, Span[]>();
  readonly #finalEnd = new Map<AudioSourceKind, number>();

  /** A frame of `source` covering [startMs, endMs) was captured (whether or not STT got it). */
  audio(source: AudioSourceKind, startMs: number, endMs: number): void {
    const a = this.#audio.get(source);
    if (!a) this.#audio.set(source, { startMs, endMs });
    else {
      a.startMs = Math.min(a.startMs, startMs);
      a.endMs = Math.max(a.endMs, endMs);
    }
  }

  /** A final segment of `source` ended here (a non-empty final; also a lower bound of the watermark). */
  final(source: AudioSourceKind, endMs: number): void {
    this.#finalEnd.set(source, Math.max(this.#finalEnd.get(source) ?? -Infinity, endMs));
  }

  /** [fromMs, toMs) of `source` will never be transcribed live. */
  lost(source: AudioSourceKind, fromMs: number, toMs: number): void {
    if (!(toMs > fromMs)) return;
    const list = this.#lost.get(source) ?? [];
    list.push({ startMs: fromMs, endMs: toMs });
    this.#lost.set(source, mergeSpans(list));
  }

  /**
   * The stream of `source` ended without finalizing everything (stopped while offline, fatal error, finish
   * timeout, or no provider at all): from its watermark (`committedMs`, else the last final's end, else the
   * first audio) to the end of the audio is lost.
   */
  unfinished(source: AudioSourceKind, committedMs: number | undefined): void {
    const audio = this.#audio.get(source);
    if (!audio) return;
    const from = Math.max(
      audio.startMs,
      committedMs ?? this.#finalEnd.get(source) ?? audio.startMs,
    );
    this.lost(source, from, audio.endMs);
  }

  /** Sources that had audio. */
  sources(): AudioSourceKind[] {
    return [...this.#audio.keys()];
  }

  /** Merged lost ranges of each source, clipped to its audio, at least `minMs` long. */
  gaps(minMs = MIN_GAP_MS): { source: AudioSourceKind; startMs: number; endMs: number }[] {
    const out: { source: AudioSourceKind; startMs: number; endMs: number }[] = [];
    for (const [source, spans] of this.#lost) {
      const audio = this.#audio.get(source);
      for (const s of spans) {
        const startMs = audio ? Math.max(s.startMs, audio.startMs) : s.startMs;
        const endMs = audio ? Math.min(s.endMs, audio.endMs) : s.endMs;
        if (endMs - startMs >= minMs) out.push({ source, startMs, endMs });
      }
    }
    return out.sort((a, b) => a.startMs - b.startMs || a.source.localeCompare(b.source));
  }
}

/** A deterministic, UUID-shaped (v8) id: the same back-filled utterance always gets the same row id. */
export function backfillSegmentId(
  meetingId: string,
  source: AudioSourceKind,
  startMs: number,
): string {
  const h = createHash('sha256')
    .update(`oat-backfill\0${meetingId}\0${source}\0${Math.round(startMs)}`)
    .digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface MergedSegment {
  id: string;
  source: AudioSourceKind;
  startMs: number;
  endMs: number;
  text: string;
}

/**
 * Turns a batch result for `range` of one source into segments to store next to the existing finals:
 * - words whose midpoint lies outside `range` are dropped (the chunk edges belong to their neighbours);
 * - words whose midpoint lies inside an existing segment of that source are dropped (already transcribed —
 *   live, or by an earlier run of this job), so re-running never duplicates;
 * - an utterance is split where words were dropped; each piece keeps its words' punctuation and gets a
 *   stable id from its start time.
 * Segments without word timing are kept whole only if they don't overlap anything existing.
 */
export function mergeBackfill(options: {
  meetingId: string;
  source: AudioSourceKind;
  range: Span;
  segments: readonly SttSegmentData[];
  existing: readonly Span[];
}): MergedSegment[] {
  const { meetingId, source, range } = options;
  const existing = mergeSpans(options.existing);
  const inside = (ms: number, spans: readonly Span[]) =>
    spans.some((s) => ms >= s.startMs && ms < s.endMs);
  const keep = (w: { startMs: number; endMs: number }) => {
    const mid = (w.startMs + w.endMs) / 2;
    return mid >= range.startMs && mid < range.endMs && !inside(mid, existing);
  };
  const out: MergedSegment[] = [];
  const emit = (words: readonly SttWord[]) => {
    if (words.length === 0) return;
    const startMs = Math.max(0, Math.round(words[0]!.startMs));
    const endMs = Math.max(startMs, Math.round(words.at(-1)!.endMs));
    const text = words
      .map((w) => w.punctuatedWord ?? w.word)
      .join(' ')
      .trim();
    if (text)
      out.push({ id: backfillSegmentId(meetingId, source, startMs), source, startMs, endMs, text });
  };
  for (const segment of options.segments) {
    if (segment.source !== source || !segment.text.trim()) continue;
    if (!segment.words?.length) {
      const overlaps = existing.some((s) => s.startMs < segment.endMs && segment.startMs < s.endMs);
      if (!overlaps && keep(segment)) {
        const startMs = Math.max(0, Math.round(segment.startMs));
        out.push({
          id: backfillSegmentId(meetingId, source, startMs),
          source,
          startMs,
          endMs: Math.max(startMs, Math.round(segment.endMs)),
          text: segment.text.trim(),
        });
      }
      continue;
    }
    let run: SttWord[] = [];
    for (const word of segment.words) {
      if (keep(word)) run.push(word);
      else {
        emit(run);
        run = [];
      }
    }
    emit(run);
  }
  // Two pieces starting on the same ms would share an id: keep the first.
  const seen = new Set<string>();
  return out
    .sort((a, b) => a.startMs - b.startMs)
    .filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
}
