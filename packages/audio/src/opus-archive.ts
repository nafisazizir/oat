/**
 * `OpusArchiveWriter`: incremental Ogg Opus file writer for one source of one recording (task 2.8, D-10,
 * SPEC §6). Node only (filesystem); the codec is libopus compiled to WASM (`libopus-wasm`), so it runs
 * unchanged in the Electron main process and in Node tests without a native addon.
 *
 * - **Format:** mono Opus at the source rate (16 kHz), ~24 kbps VBR + DTX, 20 ms packets, in Ogg pages
 *   (RFC 7845 / RFC 3533). Granule positions are exact; the final page trims encoder padding so the decoded
 *   length equals the archived timeline to the sample.
 * - **Timeline:** sample 0 of the file is `originUs` on the capture clock (the recording's `started` time),
 *   so a transcript segment at `startMs` on the recording clock is at `startMs` in the file. Each frame is
 *   placed by its `tUs`: a jump forward (overrun, pause/resume on the live sidecar, device switch, clock
 *   resync) is filled with digital silence; an overlap (`tUs` earlier than the archive's end) drops the
 *   overlapping samples. Silence is cheap: once the encoder reaches its steady "silent" packet it is
 *   repeated verbatim (a few bytes per 20 ms) instead of being re-encoded.
 * - **Durability:** completed Opus packets are buffered into a page that is written once it holds
 *   `pageMs` of audio (default 1 s) or on `flush()`/`close()`, so a crash of the app loses at most ~1 s.
 *   The file is `fdatasync`ed after the header pages, every `fsyncMs` of captured audio (default 5 s;
 *   inserted silence does not count), and on `flush()`/`close()`, bounding loss on power failure / kernel
 *   panic. Pages are only ever appended, so a torn tail is repaired by truncating to the last CRC-valid page (`repairOpusFile`).
 */
import { randomBytes } from 'node:crypto';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

import { Application, createEncoder, loadLibopus, type OpusEncoderHandle } from 'libopus-wasm';

import { buildOggPage, lacingFor, OGG_BOS, OGG_EOS, OGG_MAX_SEGMENTS } from './ogg.ts';
import {
  buildOpusHead,
  buildOpusTags,
  isOpusSampleRate,
  OPUS_GRANULE_RATE,
  type OpusSampleRate,
} from './ogg-opus.ts';
import { DEFAULT_SAMPLE_RATE, type AudioFrame, type AudioSourceKind } from './types.ts';

export const ARCHIVE_BITRATE = 24_000;
export const ARCHIVE_FRAME_MS = 20;
export const ARCHIVE_PAGE_MS = 1000;
export const ARCHIVE_FSYNC_MS = 5000;
/** A single gap longer than this is treated as a clock bug rather than filled with silence. */
export const ARCHIVE_MAX_GAP_MS = 24 * 60 * 60 * 1000;
/** `write()` waits for the disk once this much is queued (≈ 2 min of audio); below, it returns at once. */
const MAX_IO_BACKLOG_BYTES = 256 * 1024;
/** `tUs` deviations up to this many samples count as contiguous (µs rounding). */
const JITTER_SAMPLES = 2;
/** Zero frames to encode, at most, before repeating the encoder's steady silent packet. */
const MAX_SILENCE_WARMUP_FRAMES = 50;
/** Lacing values kept free on the last page so `close()` can append its padding packets. */
const CLOSE_RESERVE_SEGMENTS = 24;

export interface OpusArchiveWriterOptions {
  /** Target file; parent directories are created. */
  path: string;
  /** Capture-clock time (µs) of the file's first sample: the recording's `started` event `tUs`. */
  originUs: number;
  /** Rate of incoming frames and of the encoder (8/12/16/24/48 kHz). Default 16 kHz. */
  sampleRate?: number;
  /** Target VBR bitrate. Default 24 kbps. */
  bitrate?: number;
  /**
   * Opus discontinuous transmission: stretches without voice activity (room tone, the noise floor) are sent
   * as 1–2 byte packets and decoded as comfort noise. Cuts a typical meeting archive by ~40 %. Default true.
   */
  dtx?: boolean;
  /** Opus packet duration: 10, 20, 40 or 60 ms. Default 20. */
  frameMs?: number;
  /** Audio per Ogg page before it is written to the file. Default 1000 ms. */
  pageMs?: number;
  /** Audio between `fdatasync` calls (0 = after every page). Default 5000 ms. */
  fsyncMs?: number;
  /** Written to the `OpusTags` header (`OAT_SOURCE`). */
  source?: AudioSourceKind;
  /** Extra `OpusTags` comments (`KEY` → value). */
  comments?: Readonly<Record<string, string>>;
  /** Ogg stream serial number. Default random. */
  serial?: number;
  /** Replace an existing file. Default `false` (opening an existing path fails). */
  overwrite?: boolean;
  /** Opens the file (default `fs.promises.open`); injectable to simulate disk errors in tests. */
  openFile?: (path: string, flags: string) => Promise<ArchiveFile>;
}

/** The file operations the writer needs (a subset of `FileHandle`). */
export type ArchiveFile = Pick<FileHandle, 'write' | 'datasync' | 'close'>;

export interface OpusArchiveStats {
  /** Archived timeline length (audio + inserted silence), in samples at `sampleRate`. */
  readonly samples: number;
  readonly durationMs: number;
  /** Silence inserted for gaps, in samples. */
  readonly gapSamples: number;
  /** Samples discarded because a frame overlapped audio already archived. */
  readonly overlapSamples: number;
  /** Bytes handed to the file so far (all written pages). */
  readonly bytes: number;
  readonly pages: number;
}

export class OpusArchiveWriter {
  readonly path: string;
  readonly sampleRate: OpusSampleRate;
  readonly originUs: number;
  readonly frameSamples: number;
  /** Encoder lookahead at 48 kHz (`OpusHead` pre-skip). */
  readonly preSkip: number;

  readonly #fh: ArchiveFile;
  readonly #encoder: OpusEncoderHandle;
  readonly #serial: number;
  readonly #ratio: number; // granule units per input sample
  readonly #lookahead: number; // encoder delay at sampleRate
  readonly #pageSamples: number;
  readonly #fsyncSamples: number;

  readonly #pending: Int16Array; // the frame being filled
  #pendingLen = 0;
  #timeline = 0; // samples archived (audio + silence)
  #encoded = 0; // samples fed to the encoder (multiple of frameSamples)
  #gapSamples = 0;
  #overlapSamples = 0;

  #pagePackets: Uint8Array[] = [];
  #pageSegments = 0;
  #pageAudio = 0; // samples in #pagePackets
  #sequence = 0;
  #pages = 0;
  #bytes = 0;
  #sinceSync = 0; // captured (non-silence) samples since the last fdatasync

  #io: Promise<void> = Promise.resolve();
  #ioError: unknown;
  #ioBacklog = 0; // bytes queued for writing but not yet written
  #closed = false;
  #closing: Promise<OpusArchiveStats> | undefined;

  private constructor(
    path: string,
    fh: ArchiveFile,
    encoder: OpusEncoderHandle,
    options: Required<Pick<OpusArchiveWriterOptions, 'originUs' | 'pageMs' | 'fsyncMs'>> & {
      sampleRate: OpusSampleRate;
      serial: number;
    },
  ) {
    this.path = path;
    this.#fh = fh;
    this.#encoder = encoder;
    this.sampleRate = options.sampleRate;
    this.originUs = options.originUs;
    this.frameSamples = encoder.frameSize;
    this.#serial = options.serial;
    this.#ratio = OPUS_GRANULE_RATE / options.sampleRate;
    this.#lookahead = encoder.getLookahead();
    this.preSkip = Math.round(this.#lookahead * this.#ratio);
    this.#pageSamples = Math.max(1, Math.round((options.pageMs * options.sampleRate) / 1000));
    this.#fsyncSamples = Math.round((options.fsyncMs * options.sampleRate) / 1000);
    this.#pending = new Int16Array(this.frameSamples);
  }

  /** Creates the file and writes (and syncs) the two header pages. */
  static async open(options: OpusArchiveWriterOptions): Promise<OpusArchiveWriter> {
    const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
    if (!isOpusSampleRate(sampleRate))
      throw new RangeError(`unsupported Opus sample rate ${sampleRate}`);
    const frameMs = options.frameMs ?? ARCHIVE_FRAME_MS;
    if (![10, 20, 40, 60].includes(frameMs))
      throw new RangeError('frameMs must be 10, 20, 40 or 60');
    const pageMs = options.pageMs ?? ARCHIVE_PAGE_MS;
    const fsyncMs = options.fsyncMs ?? ARCHIVE_FSYNC_MS;
    if (!(pageMs > 0) || !(fsyncMs >= 0)) throw new RangeError('pageMs must be > 0, fsyncMs ≥ 0');
    if (!Number.isFinite(options.originUs)) throw new RangeError('originUs must be finite');

    const encoder = await createEncoder({
      sampleRate,
      channels: 1,
      frameSize: (sampleRate * frameMs) / 1000,
      application: Application.Audio,
      bitrate: options.bitrate ?? ARCHIVE_BITRATE,
      vbr: true,
      dtx: options.dtx ?? true,
    });
    let fh: ArchiveFile | undefined;
    try {
      await mkdir(dirname(options.path), { recursive: true });
      fh = await (options.openFile ?? open)(options.path, options.overwrite ? 'w' : 'wx');
      const writer = new OpusArchiveWriter(options.path, fh, encoder, {
        sampleRate,
        originUs: options.originUs,
        pageMs,
        fsyncMs,
        serial: options.serial ?? randomBytes(4).readUInt32LE(0),
      });
      const { version } = await loadLibopus();
      await writer.#writeHeaders(version, options);
      return writer;
    } catch (error) {
      encoder.free();
      await fh?.close().catch(() => undefined);
      throw error;
    }
  }

  get stats(): OpusArchiveStats {
    return {
      samples: this.#timeline,
      durationMs: (this.#timeline / this.sampleRate) * 1000,
      gapSamples: this.#gapSamples,
      overlapSamples: this.#overlapSamples,
      bytes: this.#bytes,
      pages: this.#pages,
    };
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** A file operation failed: nothing more can be written (the file holds every page before the failure). */
  get failed(): boolean {
    return this.#ioError !== undefined;
  }

  /**
   * Appends one frame at its `tUs` position (gaps filled with silence, overlaps dropped). Pages are written
   * in the background; this resolves at once unless a large write backlog has built up (backpressure).
   * Rejects if an earlier write failed (the file can no longer be appended to).
   */
  async write(frame: AudioFrame): Promise<void> {
    this.#assertWritable();
    if (frame.sampleRate !== this.sampleRate) {
      throw new RangeError(`frame rate ${frame.sampleRate} ≠ archive rate ${this.sampleRate}`);
    }
    const position = Math.round(((frame.tUs - this.originUs) * this.sampleRate) / 1_000_000);
    let pcm = frame.pcm;
    const delta = position - this.#timeline;
    if (delta > JITTER_SAMPLES) {
      this.writeSilence(delta);
    } else if (delta < -JITTER_SAMPLES) {
      const overlap = Math.min(-delta, pcm.length);
      this.#overlapSamples += overlap;
      pcm = pcm.subarray(overlap);
    }
    this.#append(pcm);
    // Encoding is synchronous and cheap; disk writes run behind. Wait for them only when they pile up.
    if (this.#ioBacklog > MAX_IO_BACKLOG_BYTES) await this.#settled();
  }

  /** Appends `samples` of digital silence at the end of the timeline (used for gaps). */
  writeSilence(samples: number): void {
    this.#assertWritable();
    const n = Math.round(samples);
    if (n <= 0) return;
    if ((n / this.sampleRate) * 1000 > ARCHIVE_MAX_GAP_MS) {
      throw new RangeError(`refusing to insert a ${Math.round(n / this.sampleRate)} s gap`);
    }
    this.#gapSamples += n;
    let remaining = n;
    // Complete the frame in progress.
    if (this.#pendingLen > 0) {
      const take = Math.min(remaining, this.frameSamples - this.#pendingLen);
      this.#pending.fill(0, this.#pendingLen, this.#pendingLen + take);
      this.#pendingLen += take;
      this.#timeline += take;
      remaining -= take;
      if (this.#pendingLen === this.frameSamples) this.#encodePending();
    }
    // Whole silent frames: encode until the encoder emits the same packet twice, then repeat it.
    let whole = Math.floor(remaining / this.frameSamples);
    remaining -= whole * this.frameSamples;
    let previous: Uint8Array | undefined;
    let steady = false;
    let warmup = 0;
    while (whole > 0) {
      let packet: Uint8Array;
      if (steady && previous) {
        packet = previous;
      } else {
        this.#pending.fill(0);
        packet = this.#encoder.encode(this.#pending);
        warmup++;
        steady =
          (previous !== undefined && sameBytes(previous, packet)) ||
          warmup >= MAX_SILENCE_WARMUP_FRAMES;
        previous = packet;
      }
      this.#timeline += this.frameSamples;
      this.#addPacket(packet);
      whole--;
    }
    // Leftover samples start the next frame.
    this.#pending.fill(0, 0, remaining);
    this.#pendingLen = remaining;
    this.#timeline += remaining;
  }

  /** Writes the page in progress (if any) and syncs the file. */
  async flush(): Promise<void> {
    this.#assertWritable();
    if (this.#pagePackets.length > 0) this.#emitPage(0);
    this.#enqueueSync();
    this.#sinceSync = 0;
    await this.#settled();
  }

  /**
   * Encodes the remaining samples plus enough padding to flush the encoder's lookahead, writes the final
   * page (EOS, granule trimmed to the exact timeline length), syncs and closes the file. Idempotent.
   */
  close(): Promise<OpusArchiveStats> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<OpusArchiveStats> {
    try {
      if (this.#ioError === undefined) {
        this.#closed = true;
        const total = this.#timeline;
        if (this.#pageSegments > OGG_MAX_SEGMENTS - CLOSE_RESERVE_SEGMENTS) this.#emitPage(0);
        // Pad with zeros until everything up to `total` has come out of the encoder's delay line.
        while (this.#encoded < total + this.#lookahead || this.#pendingLen > 0) {
          this.#pending.fill(0, this.#pendingLen);
          this.#pendingLen = this.frameSamples;
          this.#encodePending(false);
        }
        this.#emitPage(OGG_EOS, this.preSkip + total * this.#ratio);
        this.#enqueueSync();
      }
      await this.#settled();
      return this.stats;
    } finally {
      this.#closed = true;
      await this.#release();
    }
  }

  /**
   * Stops writing and closes the file without finishing the stream (as after a crash; used after a disk
   * error, and by tests). Pages already queued are still written. `repairOpusFile` finishes the file.
   * Safe to call at any time, also after `close()`.
   */
  async abandon(): Promise<void> {
    this.#closed = true;
    await this.#closing?.catch(() => undefined);
    this.#closing ??= Promise.resolve(this.stats);
    await this.#io;
    await this.#release();
  }

  #released = false;

  async #release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    this.#encoder.free();
    await this.#fh.close().catch(() => undefined);
  }

  #assertWritable(): void {
    if (this.#closed) throw new Error(`archive ${this.path} is closed`);
    if (this.#ioError !== undefined) throw toError(this.#ioError);
  }

  #append(pcm: Int16Array): void {
    this.#sinceSync += pcm.length; // inserted silence does not count: long gaps need no extra syncs
    let offset = 0;
    while (offset < pcm.length) {
      const take = Math.min(pcm.length - offset, this.frameSamples - this.#pendingLen);
      this.#pending.set(pcm.subarray(offset, offset + take), this.#pendingLen);
      this.#pendingLen += take;
      this.#timeline += take;
      offset += take;
      if (this.#pendingLen === this.frameSamples) this.#encodePending();
    }
  }

  #encodePending(autoPage = true): void {
    const packet = this.#encoder.encode(this.#pending);
    this.#pendingLen = 0;
    this.#addPacket(packet, autoPage);
  }

  #addPacket(packet: Uint8Array, autoPage = true): void {
    const segments = lacingFor(packet.length).length;
    if (this.#pageSegments + segments > OGG_MAX_SEGMENTS) this.#emitPage(0);
    this.#pagePackets.push(packet);
    this.#pageSegments += segments;
    this.#pageAudio += this.frameSamples;
    this.#encoded += this.frameSamples;
    if (autoPage && this.#pageAudio >= this.#pageSamples) this.#emitPage(0);
  }

  /** Granule (RFC 7845 §4) = 48 kHz samples decoded through the page's last packet, pre-skip included. */
  #emitPage(flags: number, granule = this.#encoded * this.#ratio): void {
    const page = buildOggPage({
      flags,
      granule,
      serial: this.#serial,
      sequence: this.#sequence++,
      packets: this.#pagePackets,
    });
    this.#pagePackets = [];
    this.#pageSegments = 0;
    this.#pageAudio = 0;
    this.#pages++;
    this.#bytes += page.length;
    this.#enqueueWrite(page);
    if (this.#sinceSync >= this.#fsyncSamples) {
      this.#sinceSync = 0;
      this.#enqueueSync();
    }
  }

  async #writeHeaders(libopusVersion: string, options: OpusArchiveWriterOptions): Promise<void> {
    const head = buildOpusHead({
      channels: 1,
      preSkip: this.preSkip,
      inputSampleRate: this.sampleRate,
    });
    const tags = buildOpusTags({
      vendor: `oat-audio (${libopusVersion})`,
      comments: {
        ENCODER: 'oat-audio OpusArchiveWriter',
        OAT_ORIGIN_US: String(this.originUs),
        ...(options.source ? { OAT_SOURCE: options.source } : {}),
        ...options.comments,
      },
    });
    for (const [packet, flags] of [
      [head, OGG_BOS],
      [tags, 0],
    ] as const) {
      const page = buildOggPage({
        flags,
        granule: 0,
        serial: this.#serial,
        sequence: this.#sequence++,
        packets: [packet],
      });
      this.#bytes += page.length;
      this.#enqueueWrite(page);
    }
    this.#enqueueSync();
    await this.#settled();
  }

  async #writeAll(bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await this.#fh.write(bytes, offset, bytes.length - offset);
      offset += bytesWritten;
    }
  }

  #enqueueSync(): void {
    this.#enqueue(() => this.#fh.datasync());
  }

  #enqueueWrite(bytes: Uint8Array): void {
    this.#ioBacklog += bytes.length;
    this.#enqueue(async () => {
      try {
        await this.#writeAll(bytes);
      } finally {
        this.#ioBacklog -= bytes.length;
      }
    });
  }

  /** Serialises file operations; `#io` never rejects. After the first failure later ones are skipped. */
  #enqueue(op: () => Promise<void>): void {
    this.#io = this.#io.then(async () => {
      if (this.#ioError !== undefined) return;
      try {
        await op();
      } catch (error) {
        this.#ioError = error;
      }
    });
  }

  /** Resolves when queued file operations are done; rejects with the first I/O error. */
  async #settled(): Promise<void> {
    await this.#io;
    if (this.#ioError !== undefined) throw toError(this.#ioError);
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
