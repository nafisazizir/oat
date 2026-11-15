import { TranscriptSourceSchema } from '@oat/core';
import { z } from 'zod';
import type { EnhanceSegment } from '../../src/enhance.ts';

const segmentsSchema = z.array(
  z.object({
    source: TranscriptSourceSchema,
    startMs: z.int().nonnegative(),
    endMs: z.int().nonnegative(),
    text: z.string().min(1),
  }),
);

/** Validates ground-truth segments (e.g. `fixtures/audio/*.segments.json`). */
export function segments(raw: unknown): EnhanceSegment[] {
  return segmentsSchema.parse(raw);
}

/**
 * Text-only transcripts: `[source, text]` lines get plausible timings (~2.5 words/s, 400 ms gaps), so fixtures
 * stay readable and timestamps stay consistent.
 */
export function timed(lines: readonly (readonly ['mic' | 'system', string])[]): EnhanceSegment[] {
  let at = 500;
  return lines.map(([source, text]) => {
    const words = text.split(/\s+/).filter(Boolean).length;
    const startMs = at;
    const endMs = startMs + Math.max(1000, words * 400);
    at = endMs + 400;
    return { source, startMs, endMs, text };
  });
}
