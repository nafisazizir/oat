import type { SttSegmentData, SttSource, SttWord } from './types.ts';

/** Subset of Deepgram's live `Results` message we use. Times are seconds of audio on that socket. */
export interface DeepgramWord {
  word: string;
  start: number;
  end: number;
  confidence?: number;
  punctuated_word?: string;
}

export interface DeepgramResults {
  type: 'Results';
  start: number;
  duration: number;
  is_final?: boolean;
  speech_final?: boolean;
  from_finalize?: boolean;
  channel: {
    alternatives: { transcript: string; confidence?: number; words?: DeepgramWord[] }[];
  };
}

export function isDeepgramResults(message: unknown): message is DeepgramResults {
  const m = message as Partial<DeepgramResults> | null;
  return (
    !!m &&
    m.type === 'Results' &&
    typeof m.start === 'number' &&
    typeof m.duration === 'number' &&
    Array.isArray(m.channel?.alternatives)
  );
}

export interface MapResultsContext {
  source: SttSource;
  /** Socket seconds → recording ms (see `SocketTimeline`). */
  toRecordingMs: (socketSeconds: number) => number;
  /**
   * Recording-ms watermark: everything before it was already finalized (on this or an earlier
   * connection). Results at or before it are duplicates from a replay and are dropped; words whose
   * midpoint lies before it are trimmed. `undefined` = nothing finalized yet.
   */
  committedMs: number | undefined;
}

export interface MappedResults {
  /** `null` when there is nothing new to show (empty transcript, or all of it already finalized). */
  segment: SttSegmentData | null;
  /** Recording ms where this result's audio window ends; the new watermark after a final. */
  chunkEndMs: number;
}

/** Maps one `Results` message onto the recording clock, minus anything already finalized. */
export function mapDeepgramResults(msg: DeepgramResults, ctx: MapResultsContext): MappedResults {
  const chunkStartMs = ctx.toRecordingMs(msg.start);
  const chunkEndMs = ctx.toRecordingMs(msg.start + msg.duration);
  const isFinal = msg.is_final === true;
  const alt = msg.channel.alternatives[0];
  const committed = ctx.committedMs;
  if (!alt || (committed !== undefined && chunkEndMs <= committed + 1)) {
    return { segment: null, chunkEndMs };
  }

  const allWords: SttWord[] = (alt.words ?? []).map((w) => ({
    word: w.word,
    ...(w.punctuated_word !== undefined ? { punctuatedWord: w.punctuated_word } : {}),
    startMs: Math.round(ctx.toRecordingMs(w.start)),
    endMs: Math.round(ctx.toRecordingMs(w.end)),
    ...(w.confidence !== undefined ? { confidence: w.confidence } : {}),
  }));

  let words = allWords;
  let text = alt.transcript.trim();
  if (committed !== undefined) {
    if (allWords.length > 0) {
      words = allWords
        .filter((w) => (w.startMs + w.endMs) / 2 >= committed)
        .map((w) => (w.startMs < committed ? { ...w, startMs: Math.round(committed) } : w));
      if (words.length < allWords.length) {
        text = words.map((w) => w.punctuatedWord ?? w.word).join(' ');
      }
    } else if ((chunkStartMs + chunkEndMs) / 2 < committed) {
      return { segment: null, chunkEndMs };
    }
  }
  if (text === '') return { segment: null, chunkEndMs };

  const floor = committed ?? -Infinity;
  const segment: SttSegmentData = {
    source: ctx.source,
    startMs: Math.round(words[0]?.startMs ?? Math.max(chunkStartMs, floor)),
    endMs: Math.round(words.at(-1)?.endMs ?? chunkEndMs),
    text,
    isFinal,
    ...(isFinal ? { speechFinal: msg.speech_final === true } : {}),
    ...(words.length > 0 ? { words } : {}),
    ...(alt.confidence !== undefined ? { confidence: alt.confidence } : {}),
  };
  return { segment, chunkEndMs };
}
