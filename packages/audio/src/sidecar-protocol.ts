/**
 * TypeScript port of the oat-audio wire protocol reference (`native/oat-audio/PROTOCOL.md`, protocol 1, D-16).
 *
 * `FrameParser` / `validateFrames` mirror `native/oat-audio/scripts/check-frames.mjs`, which stays the
 * contract: `sidecar-protocol.test.ts` runs both over the same byte streams and requires identical results.
 * On top of that this module maps raw frames to the typed `AudioFrame` / `AudioEvent` model.
 *
 * Pure: `Uint8Array` + `DataView` only, no Node APIs.
 */
import type { AudioEvent, AudioFrame, AudioSourceKind, AudioStopReason } from './types.ts';

/** Protocol number this package speaks (`oat-audio version` → `protocol`, `started.protocol`). */
export const SIDECAR_PROTOCOL = 1;
export const HEADER_SIZE = 14;
export const MAX_PAYLOAD = 16 * 1024 * 1024;
export const KIND = Object.freeze({ AUDIO: 1, EVENT: 2 } as const);
export const SOURCE = Object.freeze({ MIC: 0, SYSTEM: 1, NONE: 255 } as const);
export type WireSourceName = AudioSourceKind | 'none';
export const SOURCE_NAMES: Readonly<Record<number, WireSourceName>> = Object.freeze({
  0: 'mic',
  1: 'system',
  255: 'none',
});

/** One complete wire frame. `tUs` is a bigint exactly as on the wire (u64). */
export interface RawFrame {
  readonly kind: 1 | 2;
  readonly source: number;
  readonly sourceName: WireSourceName;
  readonly tUs: bigint;
  /** A copy: never aliases the parser's buffer. */
  readonly payload: Uint8Array;
  /** Parsed JSON for event frames. */
  readonly event?: { readonly type?: unknown; readonly [key: string]: unknown };
}

/** The byte stream violates PROTOCOL.md. Not recoverable: the stream position is lost. */
export class ProtocolError extends Error {
  override readonly name = 'ProtocolError';
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Incremental parser: `push(chunk)` returns the frames completed by that chunk (frames may be split across
 * arbitrary chunk boundaries); `pending` is the number of leftover bytes. Throws `ProtocolError` on an
 * unknown kind/source, an oversized payload or a non-JSON event; after that the parser is unusable.
 */
export class FrameParser {
  /** Copies of the unconsumed bytes (never views of caller memory), joined only once a frame is complete. */
  #parts: Uint8Array[] = [];
  #pendingLen = 0;
  /** Byte length of the frame at the head of the pending bytes, once its header is known (0 = unknown). */
  #need = 0;
  #offset = 0; // bytes of the stream consumed before the pending bytes, for error messages
  #failed: ProtocolError | undefined;

  push(chunk: Uint8Array): RawFrame[] {
    if (this.#failed) throw this.#failed;
    // A plain view (not a Node Buffer, whose `slice` aliases instead of copying).
    const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (this.#pendingLen === 0) return this.#parse(bytes);
    // Partial frame pending: buffer a copy and only join (one copy) when the frame can complete, so a large
    // payload arriving in many chunks costs linear, not quadratic, copying.
    this.#parts.push(bytes.slice());
    this.#pendingLen += bytes.length;
    if (this.#need === 0 && this.#pendingLen >= HEADER_SIZE) {
      this.#need = this.#frameLength(this.#join(), 0);
    }
    if (this.#need === 0 || this.#pendingLen < this.#need) return [];
    return this.#parse(this.#join());
  }

  get pending(): number {
    return this.#pendingLen;
  }

  #join(): Uint8Array {
    if (this.#parts.length !== 1) {
      const out = new Uint8Array(this.#pendingLen);
      let off = 0;
      for (const part of this.#parts) {
        out.set(part, off);
        off += part.length;
      }
      this.#parts = [out];
    }
    return this.#parts[0] as Uint8Array;
  }

  /** Validates the header at `off` and returns header + payload length. */
  #frameLength(buf: Uint8Array, off: number): number {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const kind = view.getUint8(off);
    const source = view.getUint8(off + 1);
    const len = view.getUint32(off + 10, true);
    const at = this.#offset + off;
    if (kind !== KIND.AUDIO && kind !== KIND.EVENT)
      this.#fail(`unknown frame kind ${kind} at byte ${at}`);
    if (!(source in SOURCE_NAMES)) this.#fail(`unknown source ${source} at byte ${at}`);
    if (len > MAX_PAYLOAD) this.#fail(`payload too large (${len}) at byte ${at}`);
    return HEADER_SIZE + len;
  }

  /** Parse complete frames from `buf` (which holds all pending bytes) and keep a copy of the tail. */
  #parse(buf: Uint8Array): RawFrame[] {
    const frames: RawFrame[] = [];
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let off = 0;
    let need = 0;
    while (buf.length - off >= HEADER_SIZE) {
      const size = this.#frameLength(buf, off);
      if (buf.length - off < size) {
        need = size;
        break;
      }
      const kind = view.getUint8(off) as 1 | 2;
      const source = view.getUint8(off + 1);
      const tUs = view.getBigUint64(off + 2, true);
      const payload = buf.slice(off + HEADER_SIZE, off + size);
      let event: RawFrame['event'];
      if (kind === KIND.EVENT) {
        try {
          event = JSON.parse(utf8.decode(payload)) as RawFrame['event'];
        } catch (e) {
          this.#fail(
            `event payload is not JSON at byte ${this.#offset + off}: ${(e as Error).message}`,
          );
        }
      }
      frames.push({
        kind,
        source,
        sourceName: SOURCE_NAMES[source] as WireSourceName,
        tUs,
        payload,
        ...(event !== undefined ? { event } : {}),
      });
      off += size;
    }
    this.#offset += off;
    // Keep a copy of the unconsumed tail: never a view of the caller's chunk (it may be reused), and never
    // retain a large chunk for a few leftover bytes.
    const tail = buf.slice(off);
    this.#parts = tail.length ? [tail] : [];
    this.#pendingLen = tail.length;
    this.#need = need;
    return frames;
  }

  #fail(message: string): never {
    this.#failed = new ProtocolError(message);
    this.#parts = [];
    this.#pendingLen = 0;
    throw this.#failed;
  }
}

/** Encode one frame (tests, fake sidecar). `payload` is raw bytes, PCM samples or an event object. */
export function encodeFrame(
  kind: 1 | 2,
  source: number,
  tUs: number | bigint,
  payload: Uint8Array | Int16Array | Record<string, unknown>,
): Uint8Array {
  let body: Uint8Array;
  if (payload instanceof Uint8Array) body = payload;
  else if (payload instanceof Int16Array) {
    body = new Uint8Array(payload.length * 2);
    const v = new DataView(body.buffer);
    payload.forEach((s, i) => v.setInt16(i * 2, s, true));
  } else body = new TextEncoder().encode(JSON.stringify(payload));
  const out = new Uint8Array(HEADER_SIZE + body.length);
  const v = new DataView(out.buffer);
  v.setUint8(0, kind);
  v.setUint8(1, source);
  v.setBigUint64(2, BigInt(tUs), true);
  v.setUint32(10, body.length, true);
  out.set(body, HEADER_SIZE);
  return out;
}

const LITTLE_ENDIAN_HOST = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Decode an audio payload (s16le) into samples. Always copies; length must be even (validated). */
export function decodePcm(payload: Uint8Array): Int16Array {
  if (payload.length % 2) throw new ProtocolError(`odd audio payload length ${payload.length}`);
  if (LITTLE_ENDIAN_HOST) return new Int16Array(payload.slice().buffer);
  const pcm = new Int16Array(payload.length / 2);
  const v = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  for (let i = 0; i < pcm.length; i++) pcm[i] = v.getInt16(i * 2, true);
  return pcm;
}

/** Map an audio frame to `AudioFrame`, shifting its clock by `offsetUs` (restart continuity). */
export function toAudioFrame(raw: RawFrame, sampleRate: number, offsetUs = 0): AudioFrame {
  if (raw.kind !== KIND.AUDIO) throw new ProtocolError('not an audio frame');
  if (raw.sourceName === 'none') {
    throw new ProtocolError(`audio frame with source none at t_us=${raw.tUs}`);
  }
  return {
    source: raw.sourceName,
    tUs: Number(raw.tUs) + offsetUs,
    pcm: decodePcm(raw.payload),
    sampleRate,
  };
}

const STOP_REASONS = new Set<AudioStopReason>([
  'duration',
  'command',
  'stdin_eof',
  'signal',
  'error',
  'output_closed',
]);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const isSource = (v: unknown): v is AudioSourceKind => v === 'mic' || v === 'system';

/**
 * Map an event frame to a typed `AudioEvent` (snake_case → camelCase, `t_us` + `offsetUs` → `tUs`).
 * Returns `undefined` for unknown types and for per-source events without a source (forward compatibility:
 * PROTOCOL.md says consumers ignore what they do not understand). Unknown fields are dropped.
 */
export function toAudioEvent(raw: RawFrame, offsetUs = 0): AudioEvent | undefined {
  const e = raw.event;
  if (raw.kind !== KIND.EVENT || !e || typeof e.type !== 'string') return undefined;
  const tUs = Number(raw.tUs) + offsetUs;
  const frameSource = raw.sourceName === 'none' ? undefined : raw.sourceName;
  const source = frameSource ?? (isSource(e.source) ? e.source : undefined);
  switch (e.type) {
    case 'started': {
      const sources = Array.isArray(e.sources) ? e.sources.filter(isSource) : [];
      return {
        type: 'started',
        tUs,
        sampleRate: num(e.sample_rate, 16_000),
        frameMs: num(e.frame_ms, 50),
        sources,
        ...(typeof e.protocol === 'number' ? { protocol: e.protocol } : {}),
        ...(typeof e.version === 'string' ? { version: e.version } : {}),
        ...(typeof e.synthetic === 'boolean' ? { synthetic: e.synthetic } : {}),
        ...(typeof e.aec === 'boolean' ? { aec: e.aec } : {}),
      };
    }
    case 'stopped': {
      const reason = str(e.reason) as AudioStopReason;
      const samples = (e.samples ?? {}) as Record<string, unknown>;
      return {
        type: 'stopped',
        tUs,
        reason: STOP_REASONS.has(reason) ? reason : 'error',
        samples: { mic: num(samples.mic), system: num(samples.system) },
      };
    }
    case 'paused':
    case 'resumed':
      return { type: e.type, tUs };
    case 'error':
      return {
        type: 'error',
        tUs,
        ...(source ? { source } : {}),
        code: str(e.code, 'unknown'),
        message: str(e.message),
        fatal: e.fatal === true,
      };
    case 'device_changed':
      return source ? { type: 'device_changed', tUs, source, device: str(e.device) } : undefined;
    case 'format_changed':
      return source
        ? {
            type: 'format_changed',
            tUs,
            source,
            deviceSampleRate: num(e.device_sample_rate),
            previousDeviceSampleRate: num(e.previous_device_sample_rate),
            channels: num(e.channels),
          }
        : undefined;
    case 'level':
      return source
        ? { type: 'level', tUs, source, rmsDb: num(e.rms_db, -100), peakDb: num(e.peak_db, -100) }
        : undefined;
    case 'overrun':
      return source
        ? {
            type: 'overrun',
            tUs,
            source,
            stage: e.stage === 'capture' ? 'capture' : 'output',
            droppedSamples: num(e.dropped_samples),
            droppedMs: num(e.dropped_ms),
          }
        : undefined;
    default:
      return undefined;
  }
}

export interface ValidateOptions {
  /** Each expected source carries this many seconds of audio (± 1 frame). */
  expectSeconds?: number;
  /** Each source carries at most this many seconds of audio (+ 1 frame). */
  maxSeconds?: number;
  /** Expected sources (default: from the `started` event). */
  sources?: readonly string[];
  /** `FrameParser.pending` after the end of the stream. */
  trailingBytes?: number;
}

export interface SourceSummary {
  frames: number;
  bytes: number;
  seconds: number;
  droppedSamples: number;
  firstUs: number;
  lastUs: number;
}

export interface ValidationResult {
  errors: string[];
  summary: {
    frames: number;
    sampleRate: number;
    frameMs: number;
    sources: Record<string, SourceSummary>;
    levelEvents: number;
    errorEvents: unknown[];
    stopReason: string | null;
  };
}

/**
 * Validate a full capture (frames from `started` to `stopped`) — same checks and messages as
 * `check-frames.mjs` `validateFrames`.
 */
export function validateFrames(
  frames: readonly RawFrame[],
  opts: ValidateOptions = {},
): ValidationResult {
  const errors: string[] = [];
  const fail = (m: string) => errors.push(m);
  const events = frames.filter((f) => f.kind === KIND.EVENT);
  const typeOf = (f: RawFrame | undefined) => f?.event?.type;
  const started = events.find((f) => typeOf(f) === 'started');
  const stopped = events.find((f) => typeOf(f) === 'stopped');

  if (!frames.length) fail('no frames');
  if (frames.length && typeOf(frames[0]) !== 'started')
    fail('first frame is not a `started` event');
  if (frames.length && typeOf(frames.at(-1)) !== 'stopped')
    fail('last frame is not a `stopped` event');
  if (events.filter((f) => typeOf(f) === 'started').length > 1)
    fail('more than one `started` event');
  if (events.filter((f) => typeOf(f) === 'stopped').length > 1)
    fail('more than one `stopped` event');
  if (opts.trailingBytes)
    fail(`${opts.trailingBytes} trailing bytes after the last complete frame`);

  for (const f of events) {
    if (typeof f.event?.type !== 'string') fail(`event without string "type" at t_us=${f.tUs}`);
  }
  const se = started?.event;
  if (started && se?.protocol !== 1) fail(`unsupported protocol ${String(se?.protocol)}`);

  const sampleRate = num(se?.sample_rate, 16_000);
  const frameMs = num(se?.frame_ms, 50);
  const frameSamples = Math.round((sampleRate * frameMs) / 1000);
  const expectedSources =
    opts.sources ?? (Array.isArray(se?.sources) ? (se.sources as string[]) : ['mic', 'system']);

  type Acc = {
    frames: number;
    bytes: number;
    firstUs: bigint | null;
    lastUs: bigint | null;
    unexpected?: boolean;
  };
  const perSource: Record<string, Acc> = {};
  for (const name of expectedSources)
    perSource[name] = { frames: 0, bytes: 0, firstUs: null, lastUs: null };

  for (const f of frames) {
    if (f.kind !== KIND.AUDIO) continue;
    if (f.source === SOURCE.NONE) {
      fail(`audio frame with source none at t_us=${f.tUs}`);
      continue;
    }
    const s = (perSource[f.sourceName] ??= {
      frames: 0,
      bytes: 0,
      firstUs: null,
      lastUs: null,
      unexpected: true,
    });
    if (f.payload.length % 2) fail(`${f.sourceName}: odd audio payload length ${f.payload.length}`);
    if (f.payload.length > frameSamples * 2) {
      fail(`${f.sourceName}: frame of ${f.payload.length} bytes exceeds frame_ms=${frameMs}`);
    }
    if (s.lastUs !== null && f.tUs <= s.lastUs) {
      fail(`${f.sourceName}: t_us not strictly increasing (${s.lastUs} → ${f.tUs})`);
    }
    s.firstUs ??= f.tUs;
    s.lastUs = f.tUs;
    s.frames += 1;
    s.bytes += f.payload.length;
  }

  const frameBytes = frameSamples * 2;
  const seconds: Record<string, number> = {};
  for (const [name, s] of Object.entries(perSource)) {
    seconds[name] = s.bytes / 2 / sampleRate;
    if (s.unexpected) fail(`audio for unexpected source ${name}`);
    if (opts.expectSeconds != null) {
      const want = opts.expectSeconds * sampleRate * 2;
      if (Math.abs(s.bytes - want) > frameBytes) {
        fail(`${name}: ${s.bytes} audio bytes, expected ${want} ± ${frameBytes}`);
      }
    }
    if (opts.maxSeconds != null && s.bytes > opts.maxSeconds * sampleRate * 2 + frameBytes) {
      fail(`${name}: ${s.bytes} audio bytes exceeds --max-seconds ${opts.maxSeconds}`);
    }
    if (opts.expectSeconds != null && s.bytes === 0) fail(`${name}: no audio`);
  }

  const droppedSamples: Record<string, number> = {};
  for (const f of events.filter((e) => typeOf(e) === 'overrun')) {
    const ev = f.event ?? {};
    if (f.source === SOURCE.NONE) fail(`overrun event without a source at t_us=${f.tUs}`);
    if (!['capture', 'output'].includes(ev.stage as string)) {
      fail(`overrun event with unknown stage ${String(ev.stage)}`);
    }
    const dropped = ev.dropped_samples;
    if (!Number.isInteger(dropped) || (dropped as number) < 0)
      fail('overrun event without dropped_samples');
    droppedSamples[f.sourceName] = (droppedSamples[f.sourceName] ?? 0) + num(dropped);
  }

  for (const f of events.filter((e) => typeOf(e) === 'format_changed')) {
    if (f.source === SOURCE.NONE) fail(`format_changed event without a source at t_us=${f.tUs}`);
    if (!(num(f.event?.device_sample_rate) > 0))
      fail('format_changed event without device_sample_rate');
  }

  return {
    errors,
    summary: {
      frames: frames.length,
      sampleRate,
      frameMs,
      sources: Object.fromEntries(
        Object.entries(perSource).map(([n, s]) => [
          n,
          {
            frames: s.frames,
            bytes: s.bytes,
            seconds: Number((seconds[n] ?? 0).toFixed(3)),
            droppedSamples: droppedSamples[n] ?? 0,
            firstUs: Number(s.firstUs ?? 0n),
            lastUs: Number(s.lastUs ?? 0n),
          },
        ]),
      ),
      levelEvents: events.filter((f) => typeOf(f) === 'level').length,
      errorEvents: events.filter((f) => typeOf(f) === 'error').map((f) => f.event),
      stopReason: stopped ? str(stopped.event?.reason) || null : null,
    },
  };
}
