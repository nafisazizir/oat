/**
 * Reading the local Ogg Opus archive (task 2.8): probe a file, map a recording-clock time to the byte offset
 * where decoding must start, and decode a time range back to PCM — used by tests and by the archive backfill
 * (task 2.9, D-17). Works on any mono Ogg Opus stream, including a crash-truncated one (it stops at the last
 * complete page).
 */
import { readFile } from 'node:fs/promises';

import { createDecoder } from 'libopus-wasm';

import {
  oggPackets,
  OGG_CONTINUED,
  OGG_EOS,
  OGG_NO_GRANULE,
  parseOggPages,
  type OggHole,
  type OggPage,
} from './ogg.ts';
import {
  isOpusSampleRate,
  OPUS_GRANULE_RATE,
  opusPacketSamples48k,
  parseOpusHead,
  parseOpusTags,
  type OpusHead,
  type OpusTags,
} from './ogg-opus.ts';
import { DEFAULT_SAMPLE_RATE } from './types.ts';

/** Decoder pre-roll before a seek target (RFC 7845 §4.6 recommends at least 80 ms). */
export const OPUS_PREROLL_MS = 80;

export interface OggOpusStream {
  readonly head: OpusHead;
  readonly tags: OpusTags;
  readonly serial: number;
  /** Audio pages only (header pages excluded), in file order. */
  readonly pages: readonly OggPage[];
  /**
   * Granule position at the start of each audio page: its granule minus the durations of its packets (so a
   * page that follows a corrupt, skipped region still lands at its true time), never before the previous
   * page's end.
   */
  readonly pageStarts: readonly number[];
  /** Corrupt regions skipped between valid pages; the audio they held decodes as silence. */
  readonly holes: readonly OggHole[];
  /** Granule of the last page that ends a packet (pre-skip included); 0 without audio. */
  readonly endGranule: number;
  /** Playable duration: (endGranule − preSkip) / 48 kHz, in ms. */
  readonly durationMs: number;
  /** Byte length of the parsed input and the end of its last valid page. */
  readonly bytes: number;
  readonly validEnd: number;
  /** The last valid page carries end-of-stream and nothing follows it. */
  readonly complete: boolean;
  /** Why parsing stopped early (torn/corrupt tail), if it did. */
  readonly parseError?: string;
}

/** Parses an Ogg Opus file image. Throws if the two header packets are missing or invalid. */
export function inspectOggOpus(bytes: Uint8Array): OggOpusStream {
  const parsed = parseOggPages(bytes);
  const all = parsed.pages;
  const first = all[0];
  if (!first) throw new Error(`not an Ogg file (${parsed.error ?? 'empty'})`);
  const serial = first.serial;
  const pages = all.filter((p) => p.serial === serial);
  let head: OpusHead | undefined;
  let tags: OpusTags | undefined;
  let audioFrom = -1;
  for (const packet of oggPackets(pages)) {
    if (!head) head = parseOpusHead(packet.data);
    else {
      tags = parseOpusTags(packet.data);
      audioFrom = packet.pageIndex + 1; // audio starts on a fresh page (RFC 7845 §3)
      break;
    }
  }
  if (!head || !tags) throw new Error('missing OpusHead/OpusTags headers');
  if (head.mappingFamily !== 0)
    throw new Error(`unsupported channel mapping ${head.mappingFamily}`);
  const audio = pages.slice(audioFrom);
  const pageStarts: number[] = [];
  let granule = 0;
  for (const page of audio) {
    const own = page.granule === OGG_NO_GRANULE ? undefined : wholePacketSamples48k(page);
    pageStarts.push(own === undefined ? granule : Math.max(granule, page.granule - own));
    if (page.granule !== OGG_NO_GRANULE) granule = page.granule;
  }
  const last = all.at(-1);
  return {
    head,
    tags,
    serial,
    pages: audio,
    pageStarts,
    endGranule: granule,
    durationMs: (Math.max(0, granule - head.preSkip) / OPUS_GRANULE_RATE) * 1000,
    bytes: bytes.length,
    validEnd: parsed.validEnd,
    holes: parsed.holes,
    complete:
      parsed.validEnd === bytes.length && last !== undefined && (last.flags & OGG_EOS) !== 0,
    ...(parsed.error ? { parseError: parsed.error } : {}),
  };
}

/**
 * Total duration (48 kHz) of the packets on a page when they all start and end on it; `undefined` for a
 * page that continues or leaves a packet unfinished (its own packets can't be told apart then).
 */
function wholePacketSamples48k(page: OggPage): number | undefined {
  if (page.flags & OGG_CONTINUED || page.lacing.at(-1) === 255) return undefined;
  let total = 0;
  let start = 0;
  let pos = 0;
  for (const v of page.lacing) {
    pos += v;
    if (v < 255) {
      total += opusPacketSamples48k(page.body.subarray(start, pos));
      start = pos;
    }
  }
  return total;
}

export async function probeOpusFile(path: string): Promise<OggOpusStream> {
  return inspectOggOpus(await readFile(path));
}

/**
 * Index of the audio page to start decoding from so that `ms` (plus `prerollMs` before it) is covered:
 * the last page that starts at or before `ms − prerollMs` and does not begin with a continued packet.
 * `-1` when the stream has no audio pages.
 */
export function opusSeekPage(
  stream: OggOpusStream,
  ms: number,
  prerollMs = OPUS_PREROLL_MS,
): number {
  const target = stream.head.preSkip + Math.max(0, ms - prerollMs) * (OPUS_GRANULE_RATE / 1000);
  let found = stream.pages.length > 0 ? 0 : -1;
  for (let i = 0; i < stream.pages.length; i++) {
    if ((stream.pageStarts[i] as number) > target) break;
    if (!((stream.pages[i] as OggPage).flags & OGG_CONTINUED)) found = i;
  }
  return found;
}

/** Byte offset in the file at which a player/decoder seeking to `ms` should start reading. */
export function opusSeekOffset(
  stream: OggOpusStream,
  ms: number,
  prerollMs = OPUS_PREROLL_MS,
): number {
  const page = opusSeekPage(stream, ms, prerollMs);
  return page < 0 ? stream.validEnd : (stream.pages[page] as OggPage).offset;
}

export interface OpusRangeOptions {
  /** Output rate (8/12/16/24/48 kHz). Default: the file's input rate if Opus-native, else 16 kHz. */
  sampleRate?: number;
}

export interface OpusRange {
  /** Mono PCM covering [startMs, endMs). */
  readonly pcm: Int16Array;
  readonly sampleRate: number;
  readonly startMs: number;
  /** Clamped to the file's duration. */
  readonly endMs: number;
}

/** Decodes [startMs, endMs) of an Ogg Opus image (recording-clock ms = file time) to mono PCM. */
export async function decodeOggOpus(
  bytes: Uint8Array | OggOpusStream,
  startMs = 0,
  endMs = Number.POSITIVE_INFINITY,
  options: OpusRangeOptions = {},
): Promise<OpusRange> {
  const stream = bytes instanceof Uint8Array ? inspectOggOpus(bytes) : bytes;
  const { head } = stream;
  if (head.channels !== 1)
    throw new Error(`expected a mono archive, got ${head.channels} channels`);
  const rate =
    options.sampleRate ??
    (isOpusSampleRate(head.inputSampleRate) ? head.inputSampleRate : DEFAULT_SAMPLE_RATE);
  if (!isOpusSampleRate(rate)) throw new RangeError(`unsupported output rate ${rate}`);
  const ratio = OPUS_GRANULE_RATE / rate; // granule units per output sample

  const start = Math.max(0, Math.min(startMs, stream.durationMs));
  const end = Math.max(start, Math.min(endMs, stream.durationMs));
  // Work in output samples on the file timeline (0 = first sample after pre-skip).
  const from = Math.round((start * rate) / 1000);
  const to = Math.round((end * rate) / 1000);
  const out = new Int16Array(to - from);
  const page = opusSeekPage(stream, start);
  if (out.length === 0 || page < 0)
    return { pcm: out, sampleRate: rate, startMs: start, endMs: end };

  const decoder = await createDecoder({ sampleRate: rate, channels: 1 });
  try {
    // Timeline position (output samples) of the next decoded sample.
    let position = ((stream.pageStarts[page] as number) - head.preSkip) / ratio;
    let current = page;
    for (const packet of oggPackets(stream.pages, page)) {
      if (packet.pageIndex !== current) {
        // A page after a skipped (corrupt) region starts later than where the previous one ended.
        current = packet.pageIndex;
        position = Math.max(
          position,
          ((stream.pageStarts[current] as number) - head.preSkip) / ratio,
        );
      }
      if (position >= to) break;
      let pcm: Int16Array;
      try {
        pcm = decoder.decode(packet.data);
      } catch {
        // A corrupt packet: conceal it so the timeline stays aligned.
        const samples = Math.round(opusPacketSamples48k(packet.data) / ratio);
        pcm = samples > 0 ? decoder.decodePacketLoss(samples) : new Int16Array(0);
      }
      const p0 = Math.round(position);
      const lo = Math.max(from, p0);
      const hi = Math.min(to, p0 + pcm.length);
      if (hi > lo) out.set(pcm.subarray(lo - p0, hi - p0), lo - from);
      position += pcm.length;
    }
  } finally {
    decoder.free();
  }
  return { pcm: out, sampleRate: rate, startMs: start, endMs: end };
}

/**
 * Decodes [startMs, endMs) of an archived recording to mono PCM (`startMs`/`endMs` on the recording clock,
 * which is the file's timeline). Reads the whole file; archives are ~10 MB per source-hour.
 */
export async function readOpusRange(
  path: string,
  startMs = 0,
  endMs = Number.POSITIVE_INFINITY,
  options: OpusRangeOptions = {},
): Promise<OpusRange> {
  return decodeOggOpus(await readFile(path), startMs, endMs, options);
}
