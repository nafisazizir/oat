/**
 * Listening back to a meeting's local audio (task 3.7, D-10, D-24, D-30). Electron-free: `index.ts` wires
 * `open` to the `playback:open` bridge channel and `handle` to the `oat-audio://` protocol.
 *
 * How the renderer gets audio: `playback:open` (a trusted-frame IPC call) mints a random capability token for
 * one meeting of the signed-in account and answers `oat-audio://<token>/`. The `<audio>` element then loads
 * `<token>/<mic|system|mix>.wav`: a 16-bit mono WAV of the **whole meeting clock** (time 0 = the meeting's
 * first recording start, the clock transcript segments use), decoded on the fly from the account's Ogg Opus
 * parts — part `p` is placed at its `offsetMs`, holes between parts are silence, `mix` sums mic + system.
 * So `audio.currentTime × 1000` *is* the meeting time: a transcript segment seeks to its `startMs`, and the
 * playhead's time picks the segment to highlight, with no mapping in the renderer. Range requests are served
 * by decoding only the requested samples (seek = the Opus page index of each part, 80 ms pre-roll).
 *
 * Why not hand the renderer the `.opus` files: a meeting has several parts per source (D-24) and two
 * sources to mix; one element on one clock keeps seek, speed and highlight trivial, and the renderer never
 * learns a path. Decoding 16 kHz mono Opus costs well under 1 % of a core per source (measured in the e2e).
 *
 * Safety: every request re-checks the token (unknown/expired → 404), that its account is still the signed-in
 * one (D-30) and that the meeting's audio is still `available` (deleted mid-play → 410); files come only from
 * `AudioStorage.playable` (the account's rows, resolved inside `<userData>/audio/<meetingId>/`, real folder)
 * and are opened with `O_NOFOLLOW` and checked to be regular files.
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import {
  type AudioRecording,
  type AudioSourceKind,
  decodeOggOpus,
  inspectOggOpus,
  type OggOpusStream,
} from '@oat/audio/node';
import {
  PLAYBACK_MAX_PARTS,
  PLAYBACK_SCHEME,
  type PlaybackInfo,
  type PlaybackPart,
  type PlaybackSource,
} from '@oat/core/bridge';

import type { PlayableAudio } from './audio-storage.ts';
import type { Logger } from './ipc.ts';

export const WAV_HEADER_BYTES = 44;
/** Samples decoded per streamed chunk (4 s at 16 kHz). */
export const CHUNK_SAMPLES = 64_000;
/** The RIFF size fields are 32-bit: a WAV holds at most this many 16-bit samples (~37 h at 16 kHz). */
export const MAX_WAV_SAMPLES = Math.floor((0xffff_ffff - 36) / 2);
const OPUS_RATES = new Set([8000, 12_000, 16_000, 24_000, 48_000]);
const DEFAULT_RATE = 16_000;
const TOKEN = /^[0-9a-f]{32}$/;
const PATH = /^\/(mic|system|mix)\.wav$/;
export const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_TOKENS = 32;
/** Parsed Opus files kept in memory (LRU), by total file bytes (~6 MB per source-hour): a meeting's parts all fit. */
const PROBE_CACHE_BYTES = 256 * 1024 * 1024;

/** One source of one part, probed. */
export interface PlaybackTrack {
  readonly source: AudioSourceKind;
  readonly part: number;
  /** Where the file starts on the meeting clock. */
  readonly offsetMs: number;
  readonly stream: OggOpusStream;
  readonly partial: boolean;
}

export interface Timeline {
  readonly sampleRate: number;
  /** WAV samples (meeting clock from 0 to the end of the last part, capped by `MAX_WAV_SAMPLES`). */
  readonly samples: number;
  readonly durationMs: number;
  readonly parts: PlaybackPart[];
}

/** Output rate: the first part's (if Opus can decode to it), else 16 kHz. */
export function playbackRate(recordings: readonly Pick<AudioRecording, 'sampleRate'>[]): number {
  const rate = recordings[0]?.sampleRate ?? DEFAULT_RATE;
  return OPUS_RATES.has(rate) ? rate : DEFAULT_RATE;
}

/** Track length in output samples (the file is the truth: a crash-left row may not know its length). */
function trackSamples(track: PlaybackTrack, rate: number): number {
  return Math.round((track.stream.durationMs * rate) / 1000);
}

function trackStart(track: PlaybackTrack, rate: number): number {
  return Math.round((track.offsetMs * rate) / 1000);
}

/** The meeting's parts on the meeting clock (sources merged per part) and the WAV's length. */
export function buildTimeline(tracks: readonly PlaybackTrack[], sampleRate: number): Timeline {
  const byPart = new Map<
    number,
    { start: number; end: number; sources: Set<AudioSourceKind>; partial: boolean }
  >();
  let end = 0;
  for (const t of tracks) {
    const start = t.offsetMs;
    const stop = t.offsetMs + t.stream.durationMs;
    if (!(stop > start)) continue; // no audio in this file
    end = Math.max(end, stop);
    const p = byPart.get(t.part) ?? { start, end: stop, sources: new Set(), partial: false };
    p.start = Math.min(p.start, start);
    p.end = Math.max(p.end, stop);
    p.sources.add(t.source);
    p.partial ||= t.partial;
    byPart.set(t.part, p);
  }
  const samples = Math.min(MAX_WAV_SAMPLES, Math.round((end * sampleRate) / 1000));
  const durationMs = (samples * 1000) / sampleRate;
  const parts = [...byPart.entries()]
    .map(([part, p]) => ({
      part,
      startMs: Math.min(p.start, durationMs),
      endMs: Math.min(p.end, durationMs),
      sources: (['mic', 'system'] as const).filter((s) => p.sources.has(s)),
      partial: p.partial,
    }))
    .filter((p) => p.endMs > p.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.part - b.part)
    .slice(0, PLAYBACK_MAX_PARTS);
  return { sampleRate, samples, durationMs, parts };
}

/** RIFF/WAVE header for `samples` 16-bit mono samples. */
export function wavHeader(samples: number, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(WAV_HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i);
  };
  const data = samples * 2;
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + data, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, data, true);
  return bytes;
}

/**
 * A single `Range: bytes=…` against `total` bytes: `undefined` = no (or an ignorable multi-range) header,
 * serve everything; `null` = unsatisfiable (416); else the inclusive byte span.
 */
export function parseRange(
  header: string | null,
  total: number,
): { start: number; end: number } | null | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined; // multi-range or garbage: RFC 9110 lets us ignore it
  const [, a = '', b = ''] = m;
  if (a === '' && b === '') return null;
  let start: number;
  let end: number;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(a);
    // `bytes=10-5` is invalid syntax: ignore the header, serve everything (RFC 9110 §14.2).
    if (b !== '' && Number(b) < start) return undefined;
    end = b === '' ? total - 1 : Math.min(Number(b), total - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if (start >= total || end < start) return null;
  return { start, end };
}

/** `oat-audio://<token>/<source>.wav[?v=<n>]` → its parts, or `null`. */
export function parsePlaybackUrl(raw: string): { token: string; source: PlaybackSource } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  // `?v=<n>`: the renderer's cache-buster (the timeline grew: a new part was recorded); ignored here.
  if (url.search && !/^\?v=\d{1,15}$/.test(url.search)) return null;
  if (url.protocol !== `${PLAYBACK_SCHEME}:` || url.username || url.port) return null;
  const path = PATH.exec(url.pathname);
  if (!TOKEN.test(url.hostname) || !path) return null;
  return { token: url.hostname, source: path[1] as PlaybackSource };
}

/**
 * Samples [from, to) of the meeting clock for `source` (`mix` = mic + system summed, clipped). Holes are
 * silence. Each overlapping part is decoded from its seek page (`decodeOggOpus`: page index + pre-roll).
 */
export async function decodeSamples(
  tracks: readonly PlaybackTrack[],
  source: PlaybackSource,
  from: number,
  to: number,
  sampleRate: number,
  log?: Logger,
): Promise<Int16Array> {
  const n = Math.max(0, to - from);
  const sum = new Int32Array(n);
  for (const track of tracks) {
    if (source !== 'mix' && track.source !== source) continue;
    const start = trackStart(track, sampleRate);
    const lo = Math.max(from, start);
    const hi = Math.min(to, start + trackSamples(track, sampleRate));
    if (hi <= lo) continue;
    try {
      const range = await decodeOggOpus(
        track.stream,
        ((lo - start) * 1000) / sampleRate,
        ((hi - start) * 1000) / sampleRate,
        { sampleRate },
      );
      const count = Math.min(range.pcm.length, hi - lo);
      const at = lo - from;
      for (let i = 0; i < count; i++) sum[at + i]! += range.pcm[i]!;
    } catch (error) {
      log?.error(`playback: could not decode part ${track.part} (${track.source})`, error);
    }
  }
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.max(-32768, Math.min(32767, sum[i]!));
  return out;
}

/** Little-endian bytes of 16-bit samples (WAV byte order, whatever the CPU's). */
function pcmBytes(pcm: Int16Array): Uint8Array {
  const bytes = new Uint8Array(pcm.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i]!, true);
  return bytes;
}

/** Bytes [start, end] of the WAV, decoded chunk by chunk as the reader pulls. */
export function wavStream(
  timeline: Timeline,
  start: number,
  end: number,
  decode: (from: number, to: number) => Promise<Int16Array>,
): ReadableStream<Uint8Array> {
  const header = wavHeader(timeline.samples, timeline.sampleRate);
  let pos = start;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (pos > end) {
        controller.close();
        return;
      }
      if (pos < WAV_HEADER_BYTES) {
        const chunk = header.slice(pos, Math.min(WAV_HEADER_BYTES, end + 1));
        pos += chunk.length;
        controller.enqueue(chunk);
        return;
      }
      const s0 = Math.floor((pos - WAV_HEADER_BYTES) / 2);
      const s1 = Math.min(
        timeline.samples,
        s0 + CHUNK_SAMPLES,
        Math.floor((end - WAV_HEADER_BYTES) / 2) + 1,
      );
      const bytes = pcmBytes(await decode(s0, s1));
      const skip = pos - WAV_HEADER_BYTES - s0 * 2;
      const take = Math.min(bytes.length - skip, end + 1 - pos);
      if (take <= 0) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(skip, skip + take));
      pos += take;
    },
  });
}

export interface AudioPlaybackOptions {
  /** `AudioStorage.playable`: availability + the signed-in account's validated rows. */
  playable: (meetingId: string) => Promise<PlayableAudio>;
  /** The signed-in account (whose database is open), or `null`. */
  currentUser: () => string | null;
  log: Logger;
  now?: () => number;
}

interface Grant {
  meetingId: string;
  userId: string;
  expiresAt: number;
}

interface Probe {
  key: string;
  stream: OggOpusStream;
  bytes: number;
}

/** Thrown by `open` when signed out (→ bridge `unauthorized`). */
export class PlaybackError extends Error {
  override name = 'PlaybackError';
  constructor(
    readonly code: 'unauthorized',
    message: string,
  ) {
    super(message);
  }
}

export class AudioPlayback {
  readonly #o: AudioPlaybackOptions;
  readonly #now: () => number;
  readonly #grants = new Map<string, Grant>();
  /** Probed files by path (validated by size + mtime), most recently used last. */
  readonly #probes = new Map<string, Probe>();
  #probeBytes = 0;

  constructor(options: AudioPlaybackOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
  }

  /** Timeline + playback URL of one of the signed-in account's meetings (or why there is no audio). */
  async open(meetingId: string): Promise<PlaybackInfo> {
    const user = this.#o.currentUser();
    if (!user) throw new PlaybackError('unauthorized', 'Sign in first.');
    const { availability, recordings } = await this.#o.playable(meetingId);
    const none = { meetingId, url: null, durationMs: 0, parts: [] };
    if (availability.status !== 'available') return { ...none, status: availability.status };
    const timeline = await this.#timeline(recordings);
    if (!timeline || timeline.samples === 0) return { ...none, status: 'deleted' };
    return {
      meetingId,
      status: 'available',
      url: `${PLAYBACK_SCHEME}://${this.#grant(meetingId, user)}/`,
      durationMs: timeline.durationMs,
      parts: timeline.parts,
    };
  }

  /** Parsed files currently cached (diagnostics, tests). */
  get cachedFiles(): number {
    return this.#probes.size;
  }

  /** Forget every token (sign-out, account switch). Requests with an old token get 404. */
  revokeAll(): void {
    this.#grants.clear();
    this.#probes.clear();
    this.#probeBytes = 0;
  }

  /** The `oat-audio://` protocol handler. */
  async handle(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return text(405, 'Method not allowed');
    }
    const target = parsePlaybackUrl(request.url);
    const grant = target && this.#grants.get(target.token);
    const user = this.#o.currentUser();
    if (!target || !grant || grant.expiresAt <= this.#now() || grant.userId !== user) {
      return text(404, 'Not found');
    }
    grant.expiresAt = this.#now() + TOKEN_TTL_MS; // in use: keep it alive (sliding expiry)
    const { availability, recordings } = await this.#o.playable(grant.meetingId);
    if (availability.status !== 'available') return text(410, 'Audio is no longer on this Mac');
    const tracks = await this.#tracks(recordings);
    const timeline = buildTimeline(tracks, playbackRate(recordings));
    const total = WAV_HEADER_BYTES + timeline.samples * 2;
    const range = parseRange(request.headers.get('range'), total);
    const headers: Record<string, string> = {
      'content-type': 'audio/wav',
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    };
    if (range === null) {
      return new Response(null, {
        status: 416,
        headers: { ...headers, 'content-range': `bytes */${total}`, 'content-length': '0' },
      });
    }
    const { start, end } = range ?? { start: 0, end: total - 1 };
    headers['content-length'] = String(end - start + 1);
    if (range) headers['content-range'] = `bytes ${start}-${end}/${total}`;
    const status = range ? 206 : 200;
    if (request.method === 'HEAD') return new Response(null, { status, headers });
    const body = wavStream(timeline, start, end, (from, to) =>
      decodeSamples(tracks, target.source, from, to, timeline.sampleRate, this.#o.log),
    );
    return new Response(body, { status, headers });
  }

  // --- internals ---------------------------------------------------------------------------------

  #grant(meetingId: string, userId: string): string {
    const now = this.#now();
    for (const [token, g] of this.#grants) {
      if (g.expiresAt <= now || g.userId !== userId) this.#grants.delete(token);
      else if (g.meetingId === meetingId) {
        g.expiresAt = now + TOKEN_TTL_MS; // sliding: a reopened (or long-open) note never gets a dying URL
        return token;
      }
    }
    while (this.#grants.size >= MAX_TOKENS) {
      this.#grants.delete(this.#grants.keys().next().value!);
    }
    const token = randomBytes(16).toString('hex');
    this.#grants.set(token, { meetingId, userId, expiresAt: now + TOKEN_TTL_MS });
    return token;
  }

  async #timeline(recordings: readonly AudioRecording[]): Promise<Timeline | null> {
    if (recordings.length === 0) return null;
    return buildTimeline(await this.#tracks(recordings), playbackRate(recordings));
  }

  async #tracks(recordings: readonly AudioRecording[]): Promise<PlaybackTrack[]> {
    const tracks: PlaybackTrack[] = [];
    for (const row of recordings) {
      const stream = await this.#probe(row.path);
      if (!stream) continue;
      tracks.push({
        source: row.source,
        part: row.part,
        offsetMs: row.offsetMs,
        stream,
        // `recording` here means a crash left it open (the active meeting is never `available`).
        partial: row.status === 'partial' || row.status === 'recording',
      });
    }
    return tracks;
  }

  /** Parses a file (cached while its size and mtime stay the same); never follows a symlink. */
  async #probe(path: string): Promise<OggOpusStream | null> {
    let file;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile()) return null;
      const key = `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
      const cached = this.#probes.get(path);
      if (cached?.key === key) {
        this.#probes.delete(path);
        this.#probes.set(path, cached);
        return cached.stream;
      }
      const stream = inspectOggOpus(await file.readFile());
      this.#probes.delete(path);
      this.#probes.set(path, { key, stream, bytes: stat.size });
      this.#probeBytes = 0;
      for (const p of this.#probes.values()) this.#probeBytes += p.bytes;
      while (this.#probeBytes > PROBE_CACHE_BYTES && this.#probes.size > 1) {
        const [oldest, entry] = this.#probes.entries().next().value!;
        this.#probes.delete(oldest);
        this.#probeBytes -= entry.bytes;
      }
      return stream;
    } catch (error) {
      this.#o.log.warn(`playback: skipped ${path}: ${(error as Error).message}`);
      return null;
    } finally {
      await file?.close().catch(() => undefined);
    }
  }
}

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}
