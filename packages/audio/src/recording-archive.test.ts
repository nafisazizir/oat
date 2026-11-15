/**
 * RecordingArchive (task 2.8, D-24): multi-part meetings (stop → resume → read across parts, seek by meeting
 * time) and disk failures (a file that cannot be created, ENOSPC mid-recording).
 */
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  InMemoryAudioRecordingStore,
  locateMeetingTime,
  nextPartAfter,
  type AudioRecording,
} from './audio-recording.ts';
import { FileSource } from './file-source.ts';
import { meetingSeek, readMeetingRange } from './meeting-audio.ts';
import type { ArchiveFile } from './opus-archive.ts';
import { probeOpusFile, readOpusRange } from './opus-reader.ts';
import {
  audioArchivePath,
  RecordingArchive,
  type ArchiveError,
  type ArchiveWriterTuning,
} from './recording-archive.ts';
import { RecordingController, type RecordingError } from './recording-controller.ts';
import { correlation, onset, rms, tone } from './testing/signals.ts';
import { encodeWav } from './wav.ts';

const RATE = 16_000;
const ms = (n: number) => Math.round((n * RATE) / 1000);

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oat-meeting-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Records one session of `meetingId` from a synthetic two-channel WAV (mic tone / system tone). */
async function session(options: {
  store: InMemoryAudioRecordingStore;
  baseDir: string;
  meetingId: string;
  offsetMs: number;
  seconds: number;
  micFreq: number;
  systemFreq?: number;
  writer?: ArchiveWriterTuning;
  speed?: number | 'fast';
}) {
  const wav = encodeWav({
    sampleRate: RATE,
    channels: [
      tone(ms(options.seconds * 1000), options.micFreq),
      tone(ms(options.seconds * 1000), options.systemFreq ?? options.micFreq * 2),
    ],
  });
  const errors: ArchiveError[] = [];
  const recordingErrors: RecordingError[] = [];
  const controller = new RecordingController({
    createSource: () => new FileSource({ input: { stereo: wav }, speed: options.speed ?? 'fast' }),
  });
  controller.onError((error) => recordingErrors.push(error));
  const archive = new RecordingArchive({
    controller,
    store: options.store,
    baseDir: options.baseDir,
    meetingId: options.meetingId,
    offsetMs: options.offsetMs,
    ...(options.writer ? { writer: options.writer } : {}),
    onError: (error) => errors.push(error),
  });
  await controller.start();
  await controller.source?.whenStopped();
  const rows = await archive.done();
  return { rows, errors, recordingErrors, state: controller.state };
}

describe('multi-part meetings (D-24)', () => {
  const baseDir = () => join(dir, 'parts');
  const store = new InMemoryAudioRecordingStore();
  let rows: AudioRecording[];

  beforeAll(async () => {
    // Session 1: meeting time 0–2 s. Stopped, resumed later: session 2 at meeting time 10–13 s.
    const first = await session({
      store,
      baseDir: baseDir(),
      meetingId: 'mtg',
      offsetMs: 0,
      seconds: 2,
      micFreq: 440,
    });
    const second = await session({
      store,
      baseDir: baseDir(),
      meetingId: 'mtg',
      offsetMs: 10_000,
      seconds: 3,
      micFreq: 660,
    });
    expect([...first.errors, ...second.errors]).toEqual([]);
    rows = await store.list({ meetingId: 'mtg' });
  });

  it('writes each session as its own part: <source>.opus, then <source>.2.opus', async () => {
    expect(rows.map((r) => [r.source, r.part, r.offsetMs, r.status, r.durationMs])).toEqual([
      ['mic', 1, 0, 'complete', 2000],
      ['system', 1, 0, 'complete', 2000],
      ['mic', 2, 10_000, 'complete', 3000],
      ['system', 2, 10_000, 'complete', 3000],
    ]);
    expect(rows.map((r) => r.path.split('/').at(-1))).toEqual([
      'mic.opus',
      'system.opus',
      'mic.2.opus',
      'system.2.opus',
    ]);
    const tags = (await probeOpusFile(rows[2]?.path as string)).tags.comments;
    expect(tags).toMatchObject({ OAT_PART: '2', OAT_OFFSET_MS: '10000', OAT_MEETING_ID: 'mtg' });
  });

  it('reads a meeting-time range across parts, with silence between sessions', async () => {
    const range = await readMeetingRange(store, 'mtg', 'mic', 1000, 11_000);
    expect(range.pcm.length).toBe(ms(10_000));
    expect(range.covered).toEqual([
      { part: 1, startMs: 1000, endMs: 2000 },
      { part: 2, startMs: 10_000, endMs: 11_000 },
    ]);
    // 1000–2000: the 440 Hz session-1 tone, at its place.
    expect(
      correlation(
        tone(ms(2000), 440).subarray(ms(1050), ms(1950)),
        range.pcm.subarray(ms(50), ms(950)),
      ),
    ).toBeGreaterThan(0.9);
    // 2000–10000: no recording → silence.
    expect(rms(range.pcm, ms(1010), ms(8990))).toBe(0);
    // 10000–11000: session 2 starts exactly at meeting time 10 s.
    expect(Math.abs(onset(range.pcm, ms(1000)) - ms(9000))).toBeLessThanOrEqual(ms(2));
    expect(
      correlation(
        tone(ms(1000), 660).subarray(ms(50), ms(950)),
        range.pcm.subarray(ms(9050), ms(9950)),
      ),
    ).toBeGreaterThan(0.9);
    // The whole meeting: 0 → end of the last part.
    expect((await readMeetingRange(store, 'mtg', 'system')).endMs).toBe(13_000);
  });

  it('maps a meeting time (segment startMs) to (part, file time, byte offset)', async () => {
    expect(locateMeetingTime(rows, 'mic', 1500)).toMatchObject({ part: 1, fileMs: 1500 });
    expect(locateMeetingTime(rows, 'mic', 12_000)).toMatchObject({ part: 2, fileMs: 2000 });
    expect(locateMeetingTime(rows, 'mic', 5000)).toBeUndefined();
    expect(nextPartAfter(rows, 'mic', 5000)).toMatchObject({ part: 2, offsetMs: 10_000 });
    expect(locateMeetingTime(rows, 'mic', 13_000)).toBeUndefined();

    const seek = await meetingSeek(rows, 'system', 12_000);
    expect(seek).toMatchObject({ part: 2, fileMs: 2000 });
    const bytes = await readFile(seek?.recording.path as string);
    const offset = seek?.byteOffset as number;
    expect(String.fromCharCode(...bytes.subarray(offset, offset + 4))).toBe('OggS');
    expect(offset).toBeGreaterThan(200); // past the headers: a real seek, not the start of the file
    // Decoding the part at that file time gives the session-2 system tone (1320 Hz).
    const { pcm } = await readOpusRange(seek?.recording.path as string, 2000, 2500);
    expect(correlation(tone(ms(2500), 1320).subarray(ms(2000), ms(2500)), pcm)).toBeGreaterThan(
      0.9,
    );
  });

  it('never overwrites an unexpected file: takes the next free part number', async () => {
    const stray = audioArchivePath(baseDir(), 'mtg', 'mic', 3);
    await writeFile(stray, 'not ours');
    const third = await session({
      store,
      baseDir: baseDir(),
      meetingId: 'mtg',
      offsetMs: 20_000,
      seconds: 1,
      micFreq: 550,
    });
    expect(third.errors).toEqual([]);
    expect(third.rows.map((r) => [r.source, r.part])).toEqual([
      ['mic', 4],
      ['system', 3],
    ]);
    expect(await readFile(stray, 'utf8')).toBe('not ours');
  });
});

/** Opens real files, but writes to `system` files fail with ENOSPC after `budget` bytes (or opening fails). */
function failingDisk(options: {
  budget?: number;
  failOpen?: boolean;
}): ArchiveWriterTuning['openFile'] {
  return async (path, flags) => {
    if (!path.includes('system')) return open(path, flags);
    if (options.failOpen) {
      throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), {
        code: 'EACCES',
      });
    }
    const fh = await open(path, flags);
    let written = 0;
    const file = {
      write: async (buffer: Uint8Array, offset: number, length: number, position?: number) => {
        if (written + length > (options.budget ?? 0)) {
          throw Object.assign(new Error('ENOSPC: no space left on device, write'), {
            code: 'ENOSPC',
          });
        }
        written += length;
        return fh.write(buffer, offset, length, position);
      },
      datasync: () => fh.datasync(),
      close: () => fh.close(),
    };
    return file as unknown as ArchiveFile;
  };
}

describe('disk failures', () => {
  it('ENOSPC mid-recording: reported once, that file finished as partial, the other source and the recording carry on', async () => {
    const store = new InMemoryAudioRecordingStore();
    const result = await session({
      store,
      baseDir: join(dir, 'enospc'),
      meetingId: 'full',
      offsetMs: 0,
      seconds: 6,
      micFreq: 440,
      speed: 20, // paced, so the disk error lands while frames are still arriving
      writer: { pageMs: 500, openFile: failingDisk({ budget: 4000 }) },
    });
    expect(result.state).toBe('idle');
    expect(result.recordingErrors).toEqual([]); // no subscriber_error flood
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      name: 'ArchiveError',
      code: 'archive_write_failed',
      source: 'system',
      cause: expect.objectContaining({ code: 'ENOSPC' }),
    });
    const mic = result.rows.find((r) => r.source === 'mic') as AudioRecording;
    const system = result.rows.find((r) => r.source === 'system') as AudioRecording;
    expect(mic).toMatchObject({ status: 'complete', durationMs: 6000 });
    expect(system.status).toBe('partial');
    expect(system.durationMs).toBeGreaterThan(400);
    expect(system.durationMs).toBeLessThan(6000);
    expect(system.bytes).toBe((await stat(system.path)).size);
    const info = await probeOpusFile(system.path);
    expect(info.complete).toBe(true);
    expect((await readOpusRange(system.path)).pcm.length).toBe(ms(info.durationMs));
  });

  it('a file that cannot be created: row `failed`, reported, the other source still archived', async () => {
    const store = new InMemoryAudioRecordingStore();
    const result = await session({
      store,
      baseDir: join(dir, 'eacces'),
      meetingId: 'denied',
      offsetMs: 0,
      seconds: 1,
      micFreq: 440,
      writer: { openFile: failingDisk({ failOpen: true }) },
    });
    expect(result.state).toBe('idle');
    expect(result.errors.map((e) => [e.code, e.source])).toEqual([
      ['archive_open_failed', 'system'],
    ]);
    const rows = await store.list({ meetingId: 'denied' });
    expect(rows.map((r) => [r.source, r.status])).toEqual([
      ['mic', 'complete'],
      ['system', 'failed'],
    ]);
  });
});
