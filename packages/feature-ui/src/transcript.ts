/**
 * Transcript deep links (6.4): `/d/<id>?t=<seconds>&seg=<segment id>` opens a meeting note with its transcript
 * scrolled to that moment (search hits from 3.6 carry `t` only; citations carry both). `block=<id>` scrolls
 * the note itself to a block.
 */

import type { TranscriptLine } from '@oat/services/dto/meeting';

export type { TranscriptLine } from '@oat/services/dto/meeting';

export type DeepLinkFocus = {
  /** Seconds into the recording. */
  t?: number;
  seg?: string;
  block?: string;
};

const ID = /^[\w.:-]{1,100}$/;

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** Reads `t`, `seg` and `block` from page search params, dropping anything malformed. */
export function parseDeepLink(
  params: Record<string, string | string[] | undefined>,
): DeepLinkFocus {
  const focus: DeepLinkFocus = {};
  const t = one(params.t);
  if (t !== undefined && /^\d{1,7}(\.\d+)?$/.test(t)) focus.t = Number(t);
  const seg = one(params.seg);
  if (seg && ID.test(seg)) focus.seg = seg;
  const block = one(params.block);
  if (block && ID.test(block)) focus.block = block;
  return focus;
}

/** Whether the link asks for the transcript. */
export const wantsTranscript = (focus: DeepLinkFocus) =>
  focus.t !== undefined || focus.seg !== undefined;

/**
 * The line a deep link points at: the segment itself when it is in this transcript, else the line being
 * spoken at `t` (the last one starting at or before it), else none.
 */
export function focusedLine(
  lines: readonly Pick<TranscriptLine, 'id' | 'startMs'>[],
  focus: DeepLinkFocus,
): string | undefined {
  if (focus.seg && lines.some((l) => l.id === focus.seg)) return focus.seg;
  if (focus.t === undefined || lines.length === 0) return undefined;
  const at = focus.t * 1000;
  let hit = lines[0]!;
  for (const line of lines) {
    if (line.startMs > at) break;
    hit = line;
  }
  return hit.id;
}

const enc = encodeURIComponent;

/** Link to a transcript moment of a meeting note. */
export function segmentHref(documentId: string, startMs: number, segmentId: string): string {
  return `/d/${enc(documentId)}?t=${Math.floor(startMs / 1000)}&seg=${enc(segmentId)}`;
}

/** Link to a block of a note. */
export function blockHref(documentId: string, blockId: string): string {
  return `/d/${enc(documentId)}?block=${enc(blockId)}`;
}

/** `m:ss` / `h:mm:ss` for a recording offset. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * A block id as a CSS string literal. Works on the server too (no `CSS.escape` there): ids come from
 * `parseDeepLink` (`[\w.:-]`) or the server's resolved citations, and quotes/backslashes/newlines are escaped
 * anyway, and `<` too (no `</style>` inside the rule).
 */
export function cssString(value: string): string {
  return `"${value
    .replace(/["\\]/g, '\\$&')
    .replace(/[\n\r\f]/g, ' ')
    .replace(/</g, '\\3c ')}"`;
}
