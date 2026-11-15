/**
 * Transcript chunker: final transcript segments → windows of consecutive segments that cite their segment
 * ids and time range (recording-clock ms), so a citation can seek the transcript/audio (3.7, 6.4).
 *
 * Windows are greedy from the start of the meeting: a window closes once it spans `targetMs` or holds
 * `targetTokens`, and never grows past `maxMs`/`maxTokens`. Appending segments (a live meeting) therefore only
 * changes the last window, so earlier chunks keep their hashes and embeddings. The next window repeats the
 * trailing segments of the previous one that started within `overlapMs` of its end (≤ `overlapTokens`, and
 * never all of them). A single segment longer than `maxTokens` becomes several chunks with its id and range.
 *
 * Text: consecutive segments of one speaker are joined on one line, "Me: …" (mic) or "<label|Them>: …".
 */
import { estimateTokens, splitLongText } from './text.ts';
import type { ChunkDraft, SegmentInput } from './types.ts';

export interface TranscriptChunkOptions {
  /** Meeting/document title, embedded as context ("Transcript · <title>"). */
  title?: string;
  /** Close a window once it spans this long. Default 75 s. */
  targetMs?: number;
  /** Never span longer than this. Default 90 s. */
  maxMs?: number;
  /** Close a window once it holds this many tokens. Default 400. */
  targetTokens?: number;
  /** Never hold more than this. Default 500. */
  maxTokens?: number;
  /** Repeat trailing segments that started within this long of the window's end. Default 10 s. */
  overlapMs?: number;
  /** …up to this many tokens. Default 60. */
  overlapTokens?: number;
}

const DEFAULTS = {
  targetMs: 75_000,
  maxMs: 90_000,
  targetTokens: 400,
  maxTokens: 500,
  overlapMs: 10_000,
  overlapTokens: 60,
};

export function speakerName(segment: Pick<SegmentInput, 'source' | 'speakerLabel'>): string {
  if (segment.source === 'mic') return 'Me';
  return segment.speakerLabel?.trim() || 'Them';
}

/** Segment text with whitespace collapsed (STT output can carry stray spaces/newlines). */
const clean = (text: string) => text.replace(/\s+/g, ' ').trim();

function render(segments: readonly SegmentInput[]): string {
  const lines: { speaker: string; text: string }[] = [];
  for (const segment of segments) {
    const speaker = speakerName(segment);
    const text = clean(segment.text);
    const last = lines.at(-1);
    if (last && last.speaker === speaker) last.text = `${last.text} ${text}`;
    else lines.push({ speaker, text });
  }
  return lines.map((l) => `${l.speaker}: ${l.text}`).join('\n');
}

/** Stable order: by start time, then id (two segments can start together on mic and system). */
export function orderSegments<T extends Pick<SegmentInput, 'startMs' | 'id'>>(
  segments: readonly T[],
): T[] {
  return [...segments].sort(
    (a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

export function chunkTranscript(
  segments: readonly SegmentInput[],
  options: TranscriptChunkOptions = {},
): ChunkDraft[] {
  const o = { ...DEFAULTS, ...options };
  const title = options.title?.replace(/\s+/g, ' ').trim() ?? '';
  const prefix = title ? `Transcript · ${title}` : 'Transcript';
  const ordered = orderSegments(segments).filter((s) => clean(s.text) !== '');
  const tokensOf = (s: SegmentInput) => estimateTokens(`${speakerName(s)}: ${clean(s.text)}`);

  const chunks: ChunkDraft[] = [];
  const emit = (window: readonly SegmentInput[], body = render(window)) => {
    const text = `${prefix}\n\n${body}`;
    chunks.push({
      source: 'transcript',
      ordinal: chunks.length,
      text,
      refIds: window.map((s) => s.id),
      startMs: window[0]!.startMs,
      endMs: Math.max(...window.map((s) => s.endMs)),
      tokenCount: estimateTokens(text),
    });
  };

  let window: SegmentInput[] = [];
  let tokens = 0;
  let fresh = 0;
  const span = (w: readonly SegmentInput[], extra?: SegmentInput) => {
    const first = w[0] ?? extra;
    if (!first) return 0;
    const ends = w.map((s) => s.endMs);
    if (extra) ends.push(extra.endMs);
    return Math.max(...ends) - first.startMs;
  };
  const close = () => {
    if (fresh > 0) emit(window);
    // Overlap: trailing segments that started near the end, within the token budget, never the whole window.
    const end = span(window) + (window[0]?.startMs ?? 0);
    const carry: SegmentInput[] = [];
    let carried = 0;
    for (let i = window.length - 1; i > 0 && fresh > 0; i--) {
      const s = window[i]!;
      const t = tokensOf(s);
      if (end - s.startMs > o.overlapMs || carried + t > o.overlapTokens) break;
      carry.unshift(s);
      carried += t;
    }
    window = carry;
    tokens = carried;
    fresh = 0;
  };

  for (const segment of ordered) {
    const t = tokensOf(segment);
    if (t > o.maxTokens) {
      // One enormous segment: close what we have, then emit it in pieces that all cite it.
      if (fresh > 0) close();
      window = [];
      tokens = 0;
      for (const piece of splitLongText(clean(segment.text), o.maxTokens - 10)) {
        emit([segment], `${speakerName(segment)}: ${piece}`);
      }
      continue;
    }
    if (fresh > 0 && (tokens + t > o.maxTokens || span(window, segment) > o.maxMs)) close();
    // The overlap itself could still be too big together with this segment: drop it.
    if (
      fresh === 0 &&
      window.length > 0 &&
      (tokens + t > o.maxTokens || span(window, segment) > o.maxMs)
    ) {
      window = [];
      tokens = 0;
    }
    window.push(segment);
    tokens += t;
    fresh += 1;
    if (span(window) >= o.targetMs || tokens >= o.targetTokens) close();
  }
  if (fresh > 0) emit(window);
  return chunks;
}
