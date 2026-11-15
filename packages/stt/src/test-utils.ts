/**
 * Test helpers (used by unit, int and contract tests; not part of the public API). Streams the committed
 * meeting fixtures (`fixtures/audio`) through `FileSource` into an `SttProvider`, one stream per source.
 */
import { readFileSync } from 'node:fs';

import { AUDIO_SOURCES, FileSource, type FileSourceSpeed } from '@oat/audio';

import { parseGroundTruth, type GroundTruthSegment } from './fake.ts';
import type {
  SttError,
  SttProvider,
  SttSegment,
  SttSource,
  SttStatus,
  SttStream,
  SttStreamOptions,
} from './types.ts';

export const FIXTURES_DIR = new URL('../../../fixtures/audio/', import.meta.url);

export function fixtureWav(name: string): URL {
  return new URL(`${name}.wav`, FIXTURES_DIR);
}

export function groundTruth(name: string): GroundTruthSegment[] {
  return parseGroundTruth(
    JSON.parse(readFileSync(new URL(`${name}.segments.json`, FIXTURES_DIR), 'utf8')),
  );
}

/** Lower case, no punctuation, single spaces: compares transcripts independent of formatting. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

export interface StreamRecord {
  stream: SttStream;
  /** Initial status, then every status event. */
  statuses: SttStatus[];
  segments: SttSegment[];
  /** `performance.now()` at each segment's arrival (same index as `segments`). */
  arrivals: number[];
  errors: SttError[];
  /** Every frame written: recording µs span and `performance.now()` at the write. */
  writes: { tUs: number; endUs: number; at: number }[];
}

export function record(stream: SttStream): StreamRecord {
  const rec: StreamRecord = {
    stream,
    statuses: [stream.status],
    segments: [],
    arrivals: [],
    errors: [],
    writes: [],
  };
  stream.on('status', (s) => rec.statuses.push(s));
  stream.on('segment', (s) => {
    rec.segments.push(s);
    rec.arrivals.push(performance.now());
  });
  stream.on('error', (e) => rec.errors.push(e));
  return rec;
}

export interface PipeOptions {
  fixture: string;
  /** Default `fast`. */
  speed?: FileSourceSpeed;
  startMs?: number;
  durationMs?: number;
  stream?: Omit<SttStreamOptions, 'source' | 'sampleRate'>;
  /** Called after each frame was written (e.g. to pause the source or inject faults). */
  onFrame?: (source: SttSource, tUs: number, audio: FileSource) => void;
}

/** Streams a fixture through the provider (both sources) and waits for `finish()` on both streams. */
export async function pipeFixture(
  provider: SttProvider,
  options: PipeOptions,
): Promise<Record<SttSource, StreamRecord>> {
  const audio = new FileSource({
    input: { stereo: fixtureWav(options.fixture) },
    speed: options.speed ?? 'fast',
    startMs: options.startMs,
    durationMs: options.durationMs,
    levelIntervalMs: 0,
  });
  const records = Object.fromEntries(
    AUDIO_SOURCES.map((source) => [
      source,
      record(
        provider.openStream({ source, sampleRate: audio.sampleRate, ...(options.stream ?? {}) }),
      ),
    ]),
  ) as Record<SttSource, StreamRecord>;
  audio.onFrame((frame) => {
    const rec = records[frame.source];
    rec.writes.push({
      tUs: frame.tUs,
      endUs: frame.tUs + (frame.pcm.length / frame.sampleRate) * 1e6,
      at: performance.now(),
    });
    rec.stream.write(frame);
    options.onFrame?.(frame.source, frame.tUs, audio);
  });
  await audio.start();
  await audio.whenStopped();
  await Promise.all(AUDIO_SOURCES.map((s) => records[s].stream.finish()));
  return records;
}

/** Finals with text (retractions excluded). */
export const finals = (rec: StreamRecord) => rec.segments.filter((s) => s.isFinal && s.text !== '');
/** Finals with empty text: "drop the interim with this id". */
export const retractions = (rec: StreamRecord) =>
  rec.segments.filter((s) => s.isFinal && s.text === '');
export const interims = (rec: StreamRecord) => rec.segments.filter((s) => !s.isFinal);
export const finalText = (rec: StreamRecord) =>
  normalize(
    finals(rec)
      .map((s) => s.text)
      .join(' '),
  );
export const truthText = (truth: GroundTruthSegment[], source: SttSource) =>
  normalize(
    truth
      .filter((t) => t.source === source)
      .map((t) => t.text)
      .join(' '),
  );
