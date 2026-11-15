/**
 * Crash recovery of the audio archive (task 2.8): a file torn at any byte, a corrupt page, a process killed
 * mid-recording, and the `audio_recording` status transitions.
 */
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { recoverRecordings, repairOpusFile } from './archive-recovery.ts';
import { InMemoryAudioRecordingStore, type AudioRecording } from './audio-recording.ts';
import { OpusArchiveWriter } from './opus-archive.ts';
import { decodeOggOpus, inspectOggOpus, probeOpusFile, readOpusRange } from './opus-reader.ts';
import { bestLag, correlation, prng, toFrames, voiceLike } from './testing/signals.ts';

const RATE = 16_000;
const CHILD = fileURLToPath(new URL('./testing/archive-crash-child.ts', import.meta.url));

let dir: string;
/** An archive that was never closed (as if the app died), 10 s of audio in 500 ms pages. */
let unclosed: string;
let reference: Int16Array; // full decode of `unclosed`
let signal: Int16Array;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oat-recovery-'));
  unclosed = join(dir, 'unclosed.opus');
  signal = voiceLike(RATE * 10, RATE, 5);
  const writer = await OpusArchiveWriter.open({ path: unclosed, originUs: 0, pageMs: 500 });
  for (const frame of toFrames(signal)) await writer.write(frame);
  await writer.abandon();
  reference = (await decodeOggOpus(await readFile(unclosed))).pcm;
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('repairOpusFile', () => {
  it('leaves a finished file alone', async () => {
    const path = join(dir, 'finished.opus');
    const writer = await OpusArchiveWriter.open({ path, originUs: 0 });
    for (const frame of toFrames(signal.subarray(0, RATE * 2))) await writer.write(frame);
    await writer.close();
    const before = await readFile(path);
    const result = await repairOpusFile(path);
    expect(result).toMatchObject({
      wasComplete: true,
      truncatedBytes: 0,
      eosAdded: false,
      playable: true,
    });
    expect(result.durationMs).toBe(2000);
    expect(Buffer.compare(await readFile(path), before)).toBe(0);
  });

  it('turns a file torn at any byte into a finished, playable prefix of the recording', async () => {
    const original = await readFile(unclosed);
    const random = prng(2_8);
    const headerEnd = inspectOggOpus(original).pages[0]?.offset as number;
    const cuts = [headerEnd + 1, original.length - 1, original.length];
    for (let i = 0; i < 25; i++)
      cuts.push(headerEnd + Math.floor(random() * (original.length - headerEnd)));
    for (const [i, cut] of cuts.entries()) {
      const path = join(dir, `torn-${i}.opus`);
      await writeFile(path, original.subarray(0, cut));
      const result = await repairOpusFile(path);
      expect(result.playable).toBe(true);
      expect(result.eosAdded).toBe(true);
      const info = await probeOpusFile(path);
      expect(info.complete).toBe(true);
      expect(info.bytes).toBe(result.bytes);
      expect(info.durationMs).toBe(result.durationMs);
      // Whole pages are kept: at most one 500 ms page (plus the torn bytes) is lost.
      const cutPages = inspectOggOpus(original.subarray(0, cut)).pages;
      expect(info.pages.length).toBe(cutPages.length);
      // The prefix decodes to exactly what the full file decodes to over the same span.
      const { pcm } = await readOpusRange(path);
      expect(pcm.length).toBe(Math.round((info.durationMs * RATE) / 1000));
      expect(pcm).toEqual(reference.subarray(0, pcm.length));
      // Repair is idempotent.
      const again = await repairOpusFile(path);
      expect(again).toMatchObject({ wasComplete: true, truncatedBytes: 0, bytes: result.bytes });
    }
  });

  it('skips a corrupt middle page (bad CRC): every later page is kept and decodes at its true time', async () => {
    const original = await readFile(unclosed);
    const stream = inspectOggOpus(original);
    expect(stream.pages).toHaveLength(20); // 10 s in 500 ms pages
    const bad = stream.pages[2] as (typeof stream.pages)[number]; // audio 1000–1500 ms
    const corrupt = Buffer.from(original);
    corrupt[bad.offset + bad.size - 3] = (corrupt[bad.offset + bad.size - 3] as number) ^ 0x55;
    const path = join(dir, 'corrupt.opus');
    await writeFile(path, corrupt);

    const result = await repairOpusFile(path);
    expect(result).toMatchObject({
      playable: true,
      holes: 1,
      holeBytes: bad.size,
      truncatedBytes: 0,
      eosAdded: true,
      durationMs: stream.durationMs,
    });
    const info = await probeOpusFile(path);
    expect(info.pages).toHaveLength(19);
    expect(info.holes).toEqual([expect.objectContaining({ offset: bad.offset, size: bad.size })]);
    expect(info.complete).toBe(true);

    const { pcm } = await readOpusRange(path);
    expect(pcm.length).toBe(reference.length);
    const preSkip = stream.head.preSkip / 3; // in 16 kHz samples
    const holeFrom = 2 * 8000 - preSkip;
    const holeTo = 3 * 8000 - preSkip;
    // Before the hole: bit-identical. The hole: silence. After it: the same audio at the same time
    // (the decoder restarts cold, so allow a short convergence before comparing).
    expect(pcm.subarray(0, holeFrom)).toEqual(reference.subarray(0, holeFrom));
    expect(pcm.subarray(holeFrom, holeTo).every((v) => v === 0)).toBe(true);
    expect(correlation(reference, pcm, 0, holeTo + 1600, pcm.length)).toBeGreaterThan(0.99);
    expect(bestLag(reference, pcm, 40, holeTo + 1600, holeTo + 16_000).lag).toBe(0);

    // Idempotent: a second repair changes nothing.
    const before = await readFile(path);
    expect(await repairOpusFile(path)).toMatchObject({
      wasComplete: true,
      holes: 1,
      truncatedBytes: 0,
    });
    expect(Buffer.compare(await readFile(path), before)).toBe(0);
  });

  it('reports files without usable headers or missing files without throwing', async () => {
    const path = join(dir, 'headless.opus');
    await copyFile(unclosed, path);
    await truncate(path, 30);
    expect(await repairOpusFile(path)).toMatchObject({
      existed: true,
      playable: false,
      durationMs: 0,
    });
    expect(await repairOpusFile(join(dir, 'nope.opus'))).toMatchObject({
      existed: false,
      playable: false,
    });
  });

  it('recovers a recording whose process was SIGKILLed mid-write', async () => {
    const path = join(dir, 'killed.opus');
    const child = spawn(process.execPath, [CHILD, path], { stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (d: Buffer) => d.toString().includes('ready') && resolve());
      child.on('exit', (code) => reject(new Error(`child exited early (${code})`)));
    });
    await vi.waitFor(async () => expect((await stat(path)).size).toBeGreaterThan(20_000), {
      timeout: 10_000,
    });
    child.kill('SIGKILL');
    await exited;

    const result = await repairOpusFile(path);
    expect(result.playable).toBe(true);
    expect(result.durationMs).toBeGreaterThan(1000);
    const { pcm } = await readOpusRange(path);
    const source = voiceLike(pcm.length, RATE, 3);
    const best = bestLag(source, pcm, 40, 320, pcm.length - 320);
    expect(best.lag).toBe(0);
    expect(best.value).toBeGreaterThan(0.9);
  });
});

describe('recoverRecordings', () => {
  it('finalises rows left behind by a crash and leaves finished ones alone', async () => {
    const store = new InMemoryAudioRecordingStore();
    const torn = join(dir, 'row-torn.opus');
    await writeFile(torn, (await readFile(unclosed)).subarray(0, 40_000));
    const closedLate = join(dir, 'row-closed.opus');
    const writer = await OpusArchiveWriter.open({ path: closedLate, originUs: 0 });
    for (const frame of toFrames(signal.subarray(0, RATE))) await writer.write(frame);
    const closedBytes = (await writer.close()).bytes;
    // An earlier partial file with a corrupt middle page: recovery must never touch it again.
    const alreadyPartial = join(dir, 'row-partial.opus');
    const damaged = Buffer.from(await readFile(unclosed));
    const page5 = inspectOggOpus(damaged).pages[5] as { offset: number };
    damaged[page5.offset + 40] = (damaged[page5.offset + 40] as number) ^ 0xff;
    await writeFile(alreadyPartial, damaged);

    const row = (id: string, path: string, status: AudioRecording['status']): AudioRecording => ({
      id,
      meetingId: 'm',
      source: 'mic',
      part: 1,
      offsetMs: 0,
      path,
      codec: 'opus',
      sampleRate: RATE,
      startedAt: id.length,
      durationMs: 0,
      bytes: 0,
      status,
    });
    await store.insert(row('torn', torn, 'recording'));
    await store.insert(row('closed', closedLate, 'recording')); // closed, but the row update was lost
    await store.insert(row('partial', alreadyPartial, 'partial'));
    await store.insert(row('missing', join(dir, 'gone.opus'), 'recording'));
    await store.insert(row('done', closedLate, 'complete'));
    await store.insert(row('skip', torn, 'recording'));

    const recovered = await recoverRecordings(store, { skipIds: ['skip'] });
    expect(recovered.map((r) => r.recording.id).sort()).toEqual(['closed', 'missing', 'torn']);
    const get = async (id: string) => (await store.get(id)) as AudioRecording;

    const tornRow = await get('torn');
    expect(tornRow.status).toBe('partial');
    expect(tornRow.bytes).toBe((await stat(torn)).size);
    expect(tornRow.durationMs).toBe(Math.round((await probeOpusFile(torn)).durationMs));
    expect(tornRow.durationMs).toBeGreaterThan(0);

    expect(await get('closed')).toMatchObject({
      status: 'complete',
      durationMs: 1000,
      bytes: closedBytes,
    });
    expect(await get('partial')).toMatchObject({ status: 'partial', durationMs: 0, bytes: 0 });
    expect(Buffer.compare(await readFile(alreadyPartial), damaged)).toBe(0);
    expect(await get('missing')).toMatchObject({ status: 'partial', durationMs: 0, bytes: 0 });
    expect(await get('done')).toMatchObject({ status: 'complete', durationMs: 0 });
    expect(await get('skip')).toMatchObject({ status: 'recording' });
  });
});
