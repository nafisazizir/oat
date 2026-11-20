import { compareTranscriptItems, type TranscriptItem } from './format.ts';

export function updateLiveTranscript<T extends TranscriptItem>(
  current: readonly T[],
  segment: T,
): T[] {
  if (segment.isFinal === false && current.some((s) => s.id === segment.id && s.isFinal))
    return [...current];
  const next = current.filter((s) => s.id !== segment.id);
  if (segment.text) next.push(segment);
  return next.sort(compareTranscriptItems);
}
