/**
 * Local audio archive (task 2.8): FileSource fixtures → RecordingController → RecordingArchive →
 * OpusArchiveWriter → decode, plus timeline alignment across gaps, flushing, seeking and the size budget.
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { InMemoryAudioRecordingStore, type AudioRecording } from './audio-recording.ts';
import { FileSource } from './file-source.ts';
import { OpusArchiveWriter } from './opus-archive.ts';
import {
  decodeOggOpus,
  inspectOggOpus,
  OPUS_PREROLL_MS,
  opusSeekOffset,
  opusSeekPage,
  probeOpusFile,
  readOpusRange,
} from './opus-reader.ts';
import { audioArchivePath, defaultOatDataDir, RecordingArchive } from './recording-archive.ts';
import { RecordingController } from './recording-controller.ts';
import {
  bestLag,
  correlation,
  onset,
  rms,
  toFrames,
  tone,
  voiceLike,
  whiteNoise,
} from './testing/signals.ts';
import type { AudioFrame } from './types.ts';
import { decodeWav, type DecodedWav } from './wav.ts';

const FIXTURE = new URL('../../../fixtures/audio/one-on-one.wav', import.meta.url);
const RATE = 16_000;
const FRAME = 320; // 20 ms
const MB_PER_HOUR = (bytes: number, ms: number) => ((bytes / ms) * 3_600_000) / 1e6;

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oat-archive-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Writes frames through a fresh writer and closes it. */
async function archive(name: string, frames: Iterable<AudioFrame>, originUs = 0, pageMs?: number) {
  const writer = await OpusArchiveWriter.open({
    path: join(dir, `${name}.opus`),
    originUs,
    source: 'mic',
    ...(pageMs ? { pageMs } : {}),
  });
  for (const frame of frames) await writer.write(frame);
  const stats = await writer.close();
  return { path: writer.path, stats, writer };
}

describe('RecordingArchive — fixture through RecordingController', () => {
  let wav: DecodedWav;
  let rows: AudioRecording[];
  let store: InMemoryAudioRecordingStore;
  const base = () => join(dir, 'base');

  beforeAll(async () => {
    wav = decodeWav(await readFile(FIXTURE));
    store = new InMemoryAudioRecordingStore();
    const controller = new RecordingController({
      createSource: () => new FileSource({ input: { stereo: FIXTURE }, speed: 'fast' }),
    });
    const archiver = new RecordingArchive({
      controller,
      store,
      baseDir: base(),
      meetingId: 'meeting-1',
      offsetMs: 0,
      now: () => 1_700_000_000_000,
      // `speed: 'fast'` pushes the whole fixture (~45 s × 2 sources ≈ 4,500 frames) as fast as the CPU
      // allows, so how far the Opus encoder falls behind depends on machine load. With the default queue
      // (3,000 frames) a loaded machine dropped frames (line `droppedFrames === 0`, flake 2026-11-14). This
      // suite checks the archive's content, not back-pressure, so the queue holds the whole fixture.
      maxQueuedFrames: 10_000,
    });
    await controller.start();
    await controller.source?.whenStopped();
    rows = await archiver.done();
    expect(archiver.droppedFrames).toBe(0);
  });

  it('writes one complete row and file per source at <base>/audio/<meeting>/<source>.opus', async () => {
    expect(rows.map((r) => r.source).sort()).toEqual(['mic', 'system']);
    for (const row of rows) {
      expect(row).toMatchObject({
        meetingId: 'meeting-1',
        codec: 'opus',
        sampleRate: RATE,
        startedAt: 1_700_000_000_000,
        status: 'complete',
        path: join(base(), 'audio', 'meeting-1', `${row.source}.opus`),
      });
      expect((await stat(row.path)).size).toBe(row.bytes);
      const info = await probeOpusFile(row.path);
      expect(info.complete).toBe(true);
      expect(info.head).toMatchObject({ channels: 1, inputSampleRate: RATE });
      expect(info.tags.comments).toMatchObject({
        OAT_SOURCE: row.source,
        OAT_MEETING_ID: 'meeting-1',
        OAT_ORIGIN_US: '0',
      });
    }
    expect(await store.list({ meetingId: 'meeting-1', status: 'complete' })).toHaveLength(2);
  });

  it('decodes to the source PCM: same length (± 1 frame), aligned (lag 0), highly correlated', async () => {
    for (const row of rows) {
      const source = wav.channels[row.source === 'mic' ? 0 : 1] as Int16Array;
      const { pcm } = await readOpusRange(row.path);
      expect(Math.abs(pcm.length - source.length)).toBeLessThanOrEqual(FRAME);
      expect(Math.abs(row.durationMs - (source.length / RATE) * 1000)).toBeLessThanOrEqual(20);
      // Whole-file waveform correlation, and its peak (searched ±5 ms on a 10 s window) at lag 0: the
      // archive is sample-aligned to the source.
      expect(correlation(source, pcm, 0, FRAME, source.length - FRAME)).toBeGreaterThan(0.95); // ≈ 0.997
      expect(bestLag(source, pcm, 80, RATE * 5, RATE * 15).lag).toBe(0);
      // Loudness envelope (20 ms RMS) tracks the source almost perfectly.
      const env = (x: Int16Array) =>
        Int16Array.from({ length: Math.floor(source.length / FRAME) }, (_, i) =>
          Math.round(rms(x, i * FRAME, (i + 1) * FRAME)),
        );
      expect(correlation(env(source), env(pcm))).toBeGreaterThan(0.97);
    }
  });

  it('stays within the ~20 MB per meeting-hour budget (both sources)', () => {
    const bytes = rows.reduce((n, r) => n + r.bytes, 0);
    const ms = Math.max(...rows.map((r) => r.durationMs));
    const perHour = MB_PER_HOUR(bytes, ms);
    console.info(`archive size: ${perHour.toFixed(1)} MB/hour (mic + system, fixture speech)`);
    expect(perHour).toBeLessThanOrEqual(20);
  });

  it('seeks: a range decoded from the middle equals that slice of the full decode', async () => {
    const row = rows.find((r) => r.source === 'system') as AudioRecording;
    const bytes = await readFile(row.path);
    const stream = inspectOggOpus(bytes);
    const full = (await decodeOggOpus(stream)).pcm;
    const startMs = 12_345;
    const range = await decodeOggOpus(stream, startMs, startMs + 3000);
    expect(range.pcm.length).toBe(3 * RATE);
    const from = Math.round((startMs * RATE) / 1000);
    // Decoding restarts mid-stream with ≥ 80 ms pre-roll, so it converges to the same output.
    expect(correlation(full.subarray(from, from + 3 * RATE), range.pcm)).toBeGreaterThan(0.99);
    // The seek page starts at or before (target − pre-roll) and the next page starts after it.
    const page = opusSeekPage(stream, startMs);
    const target = stream.head.preSkip + (startMs - OPUS_PREROLL_MS) * 48;
    expect(stream.pageStarts[page]).toBeLessThanOrEqual(target);
    expect(stream.pageStarts[page + 1]).toBeGreaterThan(target);
    const offset = opusSeekOffset(stream, startMs);
    expect(String.fromCharCode(...bytes.subarray(offset, offset + 4))).toBe('OggS');
  });
});

describe('OpusArchiveWriter — timeline alignment across gaps', () => {
  const ORIGIN = 5_000_000; // the recording's `started` tUs
  const ms = (n: number) => Math.round((n * RATE) / 1000);
  // Bursts of distinct tones placed on the recording clock, with gaps between them:
  //  leading gap (first frame after `started`), an overrun (frames dropped), a long pause on the live clock.
  const bursts = [
    { atMs: 500, lenMs: 1000, freq: 440 }, // 500 ms leading gap
    { atMs: 1750, lenMs: 1000, freq: 660 }, // 250 ms overrun gap
    { atMs: 32_750, lenMs: 1500, freq: 550 }, // 30 s pause gap
  ];
  let path: string;
  let pcm: Int16Array;
  let stats: Awaited<ReturnType<OpusArchiveWriter['close']>>;

  beforeAll(async () => {
    const frames = bursts.flatMap((b) =>
      toFrames(tone(ms(b.lenMs), b.freq), { startUs: ORIGIN + b.atMs * 1000 }),
    );
    const written = await archive('gaps', frames, ORIGIN);
    path = written.path;
    stats = written.stats;
    pcm = (await readOpusRange(path)).pcm;
  });

  it('fills gaps with silence so every burst decodes at its recording-clock position', () => {
    const end = bursts.at(-1) as (typeof bursts)[number];
    expect(pcm.length).toBe(ms(end.atMs + end.lenMs));
    expect(stats.gapSamples).toBe(ms(500) + ms(250) + ms(30_000));
    let from = 0;
    for (const b of bursts) {
      const at = onset(pcm, from);
      expect(Math.abs(at - ms(b.atMs))).toBeLessThanOrEqual(ms(2));
      const body = pcm.subarray(ms(b.atMs + 50), ms(b.atMs + b.lenMs - 50));
      const ref = tone(ms(b.lenMs), b.freq).subarray(ms(50), ms(b.lenMs - 50));
      expect(correlation(ref, body)).toBeGreaterThan(0.9);
      from = ms(b.atMs + b.lenMs + 30);
    }
    // Gaps decode as silence.
    expect(rms(pcm, ms(30), ms(480))).toBeLessThan(30);
    expect(rms(pcm, ms(2800), ms(32_700))).toBeLessThan(30);
  });

  it('seeking by recording-clock ms lands on the right audio', async () => {
    const b = bursts[2] as (typeof bursts)[number];
    const range = await readOpusRange(path, b.atMs, b.atMs + 1000);
    expect(onset(range.pcm)).toBeLessThanOrEqual(ms(2));
    const before = await readOpusRange(path, b.atMs - 1000, b.atMs - 10);
    expect(rms(before.pcm)).toBeLessThan(30);
  });

  it('stores long gaps cheaply (repeated silent packets)', () => {
    // 30 s of silence would be ~90 KB at 24 kbps; repeated steady packets are a fraction of that.
    const audioMs = bursts.reduce((n, b) => n + b.lenMs, 0);
    expect(stats.bytes).toBeLessThan((audioMs / 1000) * 4000 + 40_000);
  });

  it('handles an hour-long pause cheaply and exactly', async () => {
    const writer = await OpusArchiveWriter.open({ path: join(dir, 'hour.opus'), originUs: 0 });
    await writer.write(toFrames(tone(ms(20), 440))[0] as AudioFrame);
    await writer.write(toFrames(tone(ms(20), 440), { startUs: 3_600_000_000 })[0] as AudioFrame);
    const s = await writer.close();
    expect(s.samples).toBe(ms(3_600_020));
    expect(s.bytes).toBeLessThan(1_000_000); // ≈ 0.8 MB for an hour of silence
    expect((await probeOpusFile(writer.path)).durationMs).toBe(3_600_020);
  });

  it('drops overlapping samples instead of shifting the timeline', async () => {
    const a = toFrames(tone(ms(1000), 440));
    // A frame that claims to start 100 ms before the archive's end (clock resync after a device switch).
    const overlap = toFrames(tone(ms(500), 880), { startUs: 900_000 });
    const { path: p, stats: s } = await archive('overlap', [...a, ...overlap]);
    expect(s.overlapSamples).toBe(ms(100));
    const out = (await readOpusRange(p)).pcm;
    expect(out.length).toBe(ms(1400));
    // The 880 Hz audio that remains starts at 1000 ms and is aligned with its own clock (offset 100 ms in).
    const ref = tone(ms(500), 880).subarray(ms(150), ms(450));
    expect(correlation(ref, out.subarray(ms(1050), ms(1350)))).toBeGreaterThan(0.9);
  });

  it('treats sub-sample µs rounding as contiguous', async () => {
    const frames = toFrames(voiceLike(ms(2000))).map((f, i) => ({
      ...f,
      tUs: f.tUs + (i % 2 ? 60 : -60),
    }));
    const { stats: s } = await archive('jitter', frames);
    expect(s.gapSamples).toBe(0);
    expect(s.overlapSamples).toBe(0);
    expect(s.samples).toBe(ms(2000));
  });
});

describe('OpusArchiveWriter — file behaviour', () => {
  it('keeps the exact sample count for lengths that are not a whole number of frames', async () => {
    const input = voiceLike(12_345);
    const { path, stats } = await archive('odd', toFrames(input, { frameSamples: 800 }));
    expect(stats.samples).toBe(12_345);
    const { pcm } = await readOpusRange(path);
    expect(pcm.length).toBe(12_345);
    expect(bestLag(input, pcm, 50, 1000, 12_000).lag).toBe(0);
  });

  it('writes a page to disk at least every pageMs without being asked', async () => {
    const path = join(dir, 'paging.opus');
    const writer = await OpusArchiveWriter.open({ path, originUs: 0, pageMs: 1000 });
    for (const frame of toFrames(voiceLike(ms(3500)))) await writer.write(frame);
    // Not closed or flushed: the file on disk soon holds 3 one-second pages of audio (written in background).
    await vi.waitFor(async () => {
      const onDisk = inspectOggOpus(await readFile(path));
      expect(onDisk.pages.length).toBe(3);
      expect(onDisk.durationMs).toBeGreaterThanOrEqual(2900);
      expect(onDisk.complete).toBe(false);
    });
    await writer.flush();
    expect(inspectOggOpus(await readFile(path)).pages.length).toBe(4);
    await writer.close();
    await expect(writer.close()).resolves.toMatchObject({ samples: ms(3500) }); // idempotent
    await expect(writer.write(toFrames(tone(320, 440))[0] as AudioFrame)).rejects.toThrow(/closed/);

    function ms(n: number) {
      return Math.round((n * RATE) / 1000);
    }
  });

  it('refuses to overwrite an existing file unless asked, and rejects mismatched frames', async () => {
    const path = join(dir, 'exists.opus');
    await (await OpusArchiveWriter.open({ path, originUs: 0 })).close();
    await expect(OpusArchiveWriter.open({ path, originUs: 0 })).rejects.toMatchObject({
      code: 'EEXIST',
    });
    const writer = await OpusArchiveWriter.open({ path, originUs: 0, overwrite: true });
    await expect(
      writer.write({ source: 'mic', tUs: 0, pcm: new Int16Array(480), sampleRate: 24_000 }),
    ).rejects.toThrow(RangeError);
    const stats = await writer.close();
    expect(stats.samples).toBe(0);
    expect((await probeOpusFile(path)).durationMs).toBe(0);
  });

  it('stays near 24 kbps even for worst-case input (white noise)', async () => {
    const { stats } = await archive('noise', toFrames(whiteNoise(RATE * 60)));
    const perHour = MB_PER_HOUR(stats.bytes, stats.durationMs);
    console.info(`archive size, white noise: ${perHour.toFixed(1)} MB/hour per source`);
    expect(perHour).toBeLessThanOrEqual(11.5); // 24 kbps = 10.8 MB/hour + Ogg overhead
  });
});

describe('RecordingArchive — pause', () => {
  it('flushes on pause, keeps the file timeline equal to the FileSource timeline', async () => {
    const store = new InMemoryAudioRecordingStore();
    const controller = new RecordingController({
      createSource: () =>
        new FileSource({ input: { stereo: FIXTURE }, speed: 'fast', durationMs: 6000 }),
    });
    const archiver = new RecordingArchive({
      controller,
      store,
      baseDir: join(dir, 'pause'),
      meetingId: 'm2',
      offsetMs: 0,
    });
    const started = controller.start();
    let paused = false;
    controller.source?.onFrame((frame) => {
      if (!paused && frame.tUs >= 2_500_000) {
        paused = true;
        controller.pause();
      }
    });
    await started;
    const path = audioArchivePath(join(dir, 'pause'), 'm2', 'mic');
    // While paused, the partial page is flushed: the file on disk covers everything up to the pause point.
    await vi.waitFor(async () => {
      expect(inspectOggOpus(await readFile(path)).durationMs).toBeGreaterThanOrEqual(2500);
    });
    expect((await store.list({ status: 'recording' })).length).toBe(2);
    controller.resume();
    await controller.source?.whenStopped();
    const rows = await archiver.done();
    for (const row of rows) {
      expect(row.status).toBe('complete');
      expect(row.durationMs).toBe(6000);
    }
  });
});

describe('archive paths', () => {
  it('builds <base>/audio/<meeting>/<source>[.<part>].opus and rejects unsafe ids', () => {
    expect(audioArchivePath('/data/Oat', 'abc-123', 'system')).toBe(
      '/data/Oat/audio/abc-123/system.opus',
    );
    expect(audioArchivePath('/data/Oat', 'abc-123', 'mic', 3)).toBe(
      '/data/Oat/audio/abc-123/mic.3.opus',
    );
    expect(() => audioArchivePath('/data', 'm', 'mic', 0)).toThrow(RangeError);
    for (const id of ['../x', 'a/b', '', '.hidden', 'a b']) {
      expect(() => audioArchivePath('/data', id, 'mic')).toThrow(RangeError);
    }
  });

  it('defaults to ~/Library/Application Support/Oat on macOS', () => {
    expect(defaultOatDataDir('darwin', {}, '/Users/me')).toBe(
      '/Users/me/Library/Application Support/Oat',
    );
    expect(defaultOatDataDir('linux', {}, '/home/me')).toBe('/home/me/.local/share/Oat');
  });
});
