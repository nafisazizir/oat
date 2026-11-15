import type { ChunkSource } from '@oat/db';

/** A chunk as the chunkers produce it, before hashing/embedding. */
export interface ChunkDraft {
  source: ChunkSource;
  /** Position within (document, source), from 0. */
  ordinal: number;
  /** Exactly what gets embedded and stored (context prefix included). */
  text: string;
  /** Cited ids in order: block ids (notes) or transcript segment ids (transcript). */
  refIds: string[];
  /** Transcript time range (recording-clock ms); null for notes. */
  startMs: number | null;
  endMs: number | null;
  tokenCount: number;
}

/** What the transcript chunker needs from a `transcript_segment` row. */
export interface SegmentInput {
  id: string;
  source: 'mic' | 'system';
  speakerLabel: string | null;
  startMs: number;
  endMs: number;
  text: string;
}
