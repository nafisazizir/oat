import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type AudioRecording,
  audioArchivePath,
  InMemoryAudioRecordingStore,
  OpusArchiveWriter,
} from '@oat/audio/node';
import { rms, toFrames, tone } from '@oat/audio/testing/signals';
import { playbackInfoSchema } from '@oat/core/bridge';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AudioPlayback,
  buildTimeline,
  CHUNK_SAMPLES,
  decodeSamples,
  MAX_WAV_SAMPLES,
  parsePlaybackUrl,
  parseRange,
  type PlaybackTrack,
  playbackRate,
  TOKEN_TTL_MS,
  WAV_HEADER_BYTES,
  wavHeader,
} from './audio-playback.ts';
import { AudioStorage } from './audio-storage.ts';

const RATE = 16_000;
const ms = (n: number) => Math.round((n * RATE) / 1000);

let dir: string;
let store: InMemoryAudioRecordingStore;
let user: string | null;
let active: string | null;
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oat-playback-'));
  store = new InMemoryAudioRecordingStore();
  user = 'u1';
  active = null;
  logs = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const log = {
  info: (m: string) => logs.push(m),
  warn: (m: string) => logs.push(m),
  error: (m: string) => logs.push(m),
};

function storage() {
  return new AudioStorage({
    baseDir: dir,
    store,
    settingsFile: join(dir, 'audio-retention.json'),
    currentUser: () => user,
    activeMeeting: () => active,
    meetingInfo: (id) =>
      id.startsWith('known') ? { title: id, recorded: true, owned: true } : null,
    reveal: () => undefined,
    log,
  });
}

function player(s = storage()) {
  return new AudioPlayback({ playable: (id) => s.playable(id), currentUser: () => user, log });
}

let ids = 0;
/** A real Ogg Opus part: `pcm` written from file time 0; one audio-index row. */
async function part(
  meetingId: string,
  source: 'mic' | 'system',
  partNo: number,
  offsetMs: number,
  pcm: Int16Array,
  extra: Partial<AudioRecording> = {},
): Promise<AudioRecording> {
  const path = audioArchivePath(dir, meetingId, source, partNo);
  mkdirSync(join(dir, 'audio', meetingId), { recursive: true });
  const writer = await OpusArchiveWriter.open({ path, originUs: 0, source });
  for (const frame of toFrames(pcm, { source })) await writer.write(frame);
  const stats = await writer.close();
  const row: AudioRecording = {
    id: `r${++ids}`,
    meetingId,
    source,
    part: partNo,
    offsetMs,
    path,
    codec: 'opus',
    sampleRate: RATE,
    startedAt: 1_000 + partNo,
    durationMs: stats.durationMs,
    bytes: stats.bytes,
    status: 'complete',
    userId: 'u1',
    ...extra,
  };
  await store.insert(row);
  return row;
}

/**
 * Two sessions (D-24): part 1 = 0–2 s (mic 440 Hz, system 1 kHz); part 2 starts at 3 s (a 1 s hole) with
 * mic only (660 Hz, 1.5 s) — its system file failed.
 */
async function twoParts(meetingId = 'known-m') {
  await part(meetingId, 'mic', 1, 0, tone(ms(2000), 440));
  await part(meetingId, 'system', 1, 0, tone(ms(2000), 1000));
  await part(meetingId, 'mic', 2, 3000, tone(ms(1500), 660));
  await store.insert({
    id: `r${++ids}`,
    meetingId,
    source: 'system',
    part: 2,
    offsetMs: 3000,
    path: join(dir, 'audio', meetingId, 'system.2.opus'),
    codec: 'opus',
    sampleRate: RATE,
    startedAt: 1_002,
    durationMs: 0,
    bytes: 0,
    status: 'failed',
    userId: 'u1',
  });
}

/** Reads a whole response body. */
async function body(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

function samplesOf(bytes: Uint8Array): Int16Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Int16Array.from({ length: Math.floor(bytes.length / 2) }, (_, i) =>
    view.getInt16(i * 2, true),
  );
}

/** Dominant frequency estimate from zero crossings. */
function freq(pcm: Int16Array): number {
  let crossings = 0;
  for (let i = 1; i < pcm.length; i++) if (pcm[i - 1]! < 0 !== pcm[i]! < 0) crossings++;
  return (crossings / 2 / pcm.length) * RATE;
}

const req = (url: string, init: RequestInit = {}) => new Request(url, init);

describe('pure helpers', () => {
  it('WAV header describes 16-bit mono PCM of the meeting clock', () => {
    const h = wavHeader(32_000, RATE);
    const v = new DataView(h.buffer);
    expect(String.fromCharCode(...h.subarray(0, 4))).toBe('RIFF');
    expect(v.getUint32(4, true)).toBe(36 + 64_000);
    expect(String.fromCharCode(...h.subarray(8, 16))).toBe('WAVEfmt ');
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(RATE);
    expect(v.getUint32(28, true)).toBe(RATE * 2);
    expect(v.getUint16(34, true)).toBe(16);
    expect(String.fromCharCode(...h.subarray(36, 40))).toBe('data');
    expect(v.getUint32(40, true)).toBe(64_000);
  });

  it('ranges: open-ended, bounded, suffix, clamped, unsatisfiable, ignorable', () => {
    expect(parseRange(null, 100)).toBeUndefined();
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBeNull();
    expect(parseRange('bytes=20-10', 100)).toBeUndefined(); // invalid: ignored → 200, whole body
    expect(parseRange('bytes=-0', 100)).toBeNull();
    expect(parseRange('bytes=-', 100)).toBeNull();
    expect(parseRange('bytes=0-1,5-6', 100)).toBeUndefined();
    expect(parseRange('items=0-1', 100)).toBeUndefined();
  });

  it('playback URLs: a 128-bit token and one of three sources, nothing else', () => {
    const token = 'a'.repeat(32);
    expect(parsePlaybackUrl(`oat-audio://${token}/mix.wav`)).toEqual({ token, source: 'mix' });
    expect(parsePlaybackUrl(`oat-audio://${token}/mic.wav`)).toEqual({ token, source: 'mic' });
    expect(parsePlaybackUrl(`oat-audio://${token}/mic.wav?v=12345`)).toEqual({
      token,
      source: 'mic',
    });
    // Dot segments are normalised by the URL parser: still just one of the three virtual files.
    expect(parsePlaybackUrl(`oat-audio://${token}/../mic.wav`)).toEqual({ token, source: 'mic' });
    for (const bad of [
      `oat-audio://${token}/both.wav`,
      `oat-audio://${token}/mic.opus`,
      `oat-audio://${token}/x/mic.wav`,
      `oat-audio://${token}/mic.wav?path=/etc/passwd`,
      `oat-audio://${'a'.repeat(31)}/mic.wav`,
      `oat-audio://${'g'.repeat(32)}/mic.wav`,
      `oat-audio://user@${token}/mic.wav`,
      `app://${token}/mic.wav`,
      'not a url',
    ]) {
      expect(parsePlaybackUrl(bad), bad).toBeNull();
    }
  });

  it('rate: the parts’ rate when Opus can decode to it, else 16 kHz', () => {
    expect(playbackRate([{ sampleRate: 48_000 }])).toBe(48_000);
    expect(playbackRate([{ sampleRate: 44_100 }])).toBe(16_000);
    expect(playbackRate([])).toBe(16_000);
  });
});

describe('timeline + decoding across parts and gaps', () => {
  async function tracks(): Promise<PlaybackTrack[]> {
    await twoParts();
    const p = player();
    // Through the public path: probe via a request, then reuse the module's own helpers.
    const info = await p.open('known-m');
    expect(info.status).toBe('available');
    const { inspectOggOpus } = await import('@oat/audio/node');
    const { readFileSync } = await import('node:fs');
    const rows = (await store.list({ meetingId: 'known-m' })).filter((r) => r.status !== 'failed');
    return rows.map((r) => ({
      source: r.source,
      part: r.part,
      offsetMs: r.offsetMs,
      stream: inspectOggOpus(readFileSync(r.path)),
      partial: false,
    }));
  }

  it('merges sources per part, keeps the hole, ends at the last part', async () => {
    const t = buildTimeline(await tracks(), RATE);
    expect(t.parts).toHaveLength(2);
    expect(t.parts[0]).toMatchObject({ part: 1, startMs: 0, sources: ['mic', 'system'] });
    expect(t.parts[0]!.endMs).toBeCloseTo(2000, -1);
    expect(t.parts[1]).toMatchObject({ part: 2, startMs: 3000, sources: ['mic'] });
    expect(t.parts[1]!.endMs).toBeCloseTo(4500, -1);
    expect(t.durationMs).toBeCloseTo(4500, -1);
    expect(t.samples).toBe(Math.round((t.durationMs * RATE) / 1000));
  });

  it('caps the WAV at what its 32-bit sizes can hold', () => {
    const huge = {
      source: 'mic' as const,
      part: 1,
      offsetMs: 40 * 3_600_000,
      partial: false,
      stream: { durationMs: 1000 } as PlaybackTrack['stream'],
    };
    const t = buildTimeline([huge], RATE);
    expect(t.samples).toBe(MAX_WAV_SAMPLES);
    expect(t.parts).toEqual([]); // starts after the cap: not playable, not drawn
  });

  it('places each part at its offset: tones where parts are, silence in the hole, mix = both', async () => {
    const all = await tracks();
    const mic = await decodeSamples(all, 'mic', 0, ms(4500), RATE);
    const system = await decodeSamples(all, 'system', 0, ms(4500), RATE);
    const mix = await decodeSamples(all, 'mix', 0, ms(4500), RATE);
    expect(mic).toHaveLength(ms(4500));
    // Part 1 (0–2 s): mic 440 Hz, system 1 kHz.
    expect(freq(mic.subarray(ms(200), ms(1800)))).toBeCloseTo(440, -1);
    expect(freq(system.subarray(ms(200), ms(1800)))).toBeCloseTo(1000, -1);
    // The hole (2–3 s) is silence for every source.
    expect(rms(mic, ms(2100), ms(2900))).toBeLessThan(50);
    expect(rms(mix, ms(2100), ms(2900))).toBeLessThan(50);
    // Part 2 (3–4.5 s): mic 660 Hz; its system file failed, so "them" is silent there.
    expect(freq(mic.subarray(ms(3200), ms(4300)))).toBeCloseTo(660, -1);
    expect(rms(system, ms(3200), ms(4300))).toBeLessThan(50);
    // Mix carries both sources in part 1.
    expect(rms(mix, ms(200), ms(1800))).toBeGreaterThan(rms(mic, ms(200), ms(1800)));
  });

  it('a range decoded on its own matches the same samples of a full decode (seek)', async () => {
    const all = await tracks();
    const full = await decodeSamples(all, 'mic', 0, ms(4500), RATE);
    const from = ms(3500); // inside part 2: meetingSeek → part 2, file time 500 ms
    const slice = await decodeSamples(all, 'mic', from, from + ms(500), RATE);
    let diff = 0;
    for (let i = 0; i < slice.length; i++) diff += Math.abs(slice[i]! - full[from + i]!);
    expect(diff / slice.length).toBeLessThan(200); // Opus pre-roll converges to the same signal
    expect(freq(slice)).toBeCloseTo(660, -1);
  });
});

describe('AudioPlayback (the oat-audio:// protocol)', () => {
  it('open: timeline + a capability URL for the signed-in account’s meeting', async () => {
    await twoParts();
    const info = await player().open('known-m');
    expect(playbackInfoSchema.parse(info)).toEqual(info);
    expect(info.status).toBe('available');
    expect(info.url).toMatch(/^oat-audio:\/\/[0-9a-f]{32}\/$/);
    expect(info.parts.map((p) => p.part)).toEqual([1, 2]);
    expect(JSON.stringify(info)).not.toContain(dir); // no path crosses the bridge
  });

  it('open: states without audio, and signed out', async () => {
    const p = player();
    expect(await p.open('known-x')).toMatchObject({ status: 'other-device', url: null });
    expect(await p.open('stranger')).toMatchObject({ status: 'none', url: null });
    await twoParts('known-rec');
    active = 'known-rec';
    expect(await p.open('known-rec')).toMatchObject({ status: 'recording', url: null });
    user = null;
    await expect(p.open('known-m')).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('serves a WAV of the meeting clock with byte ranges (seek lands on the right part)', async () => {
    await twoParts();
    const p = player();
    const info = await p.open('known-m');
    const url = `${info.url}mic.wav`;
    const total = WAV_HEADER_BYTES + Math.round((info.durationMs * RATE) / 1000) * 2;

    const head = await p.handle(req(url, { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(total));
    expect(head.headers.get('accept-ranges')).toBe('bytes');
    expect(head.headers.get('content-type')).toBe('audio/wav');

    const first = await p.handle(req(url, { headers: { range: 'bytes=0-' } }));
    expect(first.status).toBe(206);
    expect(first.headers.get('content-range')).toBe(`bytes 0-${total - 1}/${total}`);
    const all = await body(first);
    expect(all.length).toBe(total);
    expect(String.fromCharCode(...all.subarray(0, 4))).toBe('RIFF');

    // Seek to 3.5 s on the meeting clock (part 2): an odd byte offset, across a chunk boundary.
    const at = WAV_HEADER_BYTES + ms(3500) * 2 + 1;
    const ranged = await p.handle(req(url, { headers: { range: `bytes=${at}-${at + 9999}` } }));
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-length')).toBe('10000');
    const piece = await body(ranged);
    expect(piece).toHaveLength(10_000);
    expect(Buffer.from(piece).equals(Buffer.from(all.subarray(at, at + 10_000)))).toBe(true);
    expect(freq(samplesOf(piece.subarray(1)))).toBeCloseTo(660, -1);

    const unsatisfiable = await p.handle(req(url, { headers: { range: `bytes=${total}-` } }));
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get('content-length')).toBe('0');
    expect(unsatisfiable.headers.get('content-range')).toBe(`bytes */${total}`);
    const invalid = await p.handle(req(url, { method: 'HEAD', headers: { range: 'bytes=10-5' } }));
    expect(invalid.status).toBe(200);
    expect((await p.handle(req(url, { method: 'POST' }))).status).toBe(405);
  });

  it('streams long meetings in chunks without decoding everything up front', async () => {
    await part('known-long', 'mic', 1, 0, tone(ms(9000), 300));
    const p = player();
    const info = await p.open('known-long');
    const res = await p.handle(req(`${info.url}mix.wav`));
    const reader = res.body!.getReader();
    const header = await reader.read();
    expect(header.value).toHaveLength(WAV_HEADER_BYTES);
    const chunk = await reader.read();
    expect(chunk.value).toHaveLength(CHUNK_SAMPLES * 2);
    await reader.cancel();
  });

  it('refuses unknown tokens, another account, signed out, and deleted audio', async () => {
    await twoParts();
    const s = storage();
    const p = player(s);
    const info = await p.open('known-m');
    const url = `${info.url}mix.wav`;
    expect((await p.handle(req(url, { method: 'HEAD' }))).status).toBe(200);
    expect((await p.handle(req(`oat-audio://${'0'.repeat(32)}/mix.wav`))).status).toBe(404);
    expect((await p.handle(req(`${info.url}..%2Fmic.opus`))).status).toBe(404);

    user = 'u2'; // another account signed in: the old URL is dead (D-30)
    expect((await p.handle(req(url))).status).toBe(404);
    user = null;
    expect((await p.handle(req(url))).status).toBe(404);
    user = 'u1';
    expect((await p.handle(req(url, { method: 'HEAD' }))).status).toBe(200);

    await s.deleteAudio('known-m'); // deleted while the player is open
    expect((await p.handle(req(url))).status).toBe(410);
    expect(await p.open('known-m')).toMatchObject({ status: 'deleted', url: null });

    p.revokeAll();
    expect((await p.handle(req(url))).status).toBe(404);
  });

  it('tokens slide: reopening or using a URL keeps it alive; an idle one expires after 12 h', async () => {
    await twoParts();
    let now = 1_000_000;
    const s = storage();
    const p = new AudioPlayback({
      playable: (id) => s.playable(id),
      currentUser: () => user,
      log,
      now: () => now,
    });
    const first = await p.open('known-m');
    now += TOKEN_TTL_MS - 60_000; // 1 min before the first expiry: reopen the note
    const again = await p.open('known-m');
    expect(again.url).toBe(first.url); // same token, renewed
    now += 2 * 60 * 60_000; // past the original expiry: still serves
    expect((await p.handle(req(`${again.url}mix.wav`, { method: 'HEAD' }))).status).toBe(200);
    now += TOKEN_TTL_MS - 1000; // in use 1 s before expiry: renewed by the request
    expect((await p.handle(req(`${again.url}mix.wav`, { method: 'HEAD' }))).status).toBe(200);
    now += TOKEN_TTL_MS - 1000;
    expect((await p.handle(req(`${again.url}mix.wav`, { method: 'HEAD' }))).status).toBe(200);
    now += TOKEN_TTL_MS; // left idle for 12 h
    expect((await p.handle(req(`${again.url}mix.wav`, { method: 'HEAD' }))).status).toBe(404);
    const fresh = await p.open('known-m');
    expect(fresh.url).not.toBe(again.url);
    expect((await p.handle(req(`${fresh.url}mix.wav`, { method: 'HEAD' }))).status).toBe(200);
  });

  it('keeps every part of a many-part meeting cached (no re-reads while seeking)', async () => {
    for (let i = 1; i <= 6; i++) {
      await part('known-many', 'mic', i, (i - 1) * 500, tone(ms(500), 440));
      await part('known-many', 'system', i, (i - 1) * 500, tone(ms(500), 880));
    }
    const s = storage();
    const p = player(s);
    const info = await p.open('known-many');
    expect(info.parts).toHaveLength(6);
    for (let k = 0; k < 3; k++) {
      const res = await p.handle(
        req(`${info.url}mix.wav`, { headers: { range: 'bytes=44-1043' } }),
      );
      expect(res.status).toBe(206);
      await res.arrayBuffer();
    }
    // 6 parts × 2 sources stay parsed (the old 8-entry cache thrashed: every request re-read them all).
    expect(p.cachedFiles).toBe(12);
    p.revokeAll();
    expect(p.cachedFiles).toBe(0);
  });

  it('never serves another account’s recording of the same meeting', async () => {
    await part('known-o', 'mic', 1, 0, tone(ms(1000), 440), { userId: 'u2' });
    const info = await player().open('known-o');
    expect(info).toMatchObject({ url: null });
    expect(info.status).not.toBe('available');
  });

  it('skips a symlinked file and a row pointing outside the meeting folder', async () => {
    const mic = await part('known-s', 'mic', 1, 0, tone(ms(1000), 440));
    const secret = join(dir, 'secret.opus');
    writeFileSync(secret, 'not audio');
    symlinkSync(secret, join(dir, 'audio', 'known-s', 'system.opus'));
    await store.insert({
      id: 'sym',
      meetingId: 'known-s',
      source: 'system',
      part: 1,
      offsetMs: 0,
      path: join(dir, 'audio', 'known-s', 'system.opus'),
      codec: 'opus',
      sampleRate: RATE,
      startedAt: 1,
      durationMs: 1000,
      bytes: 9,
      status: 'complete',
      userId: 'u1',
    });
    await store.insert({
      id: 'outside',
      meetingId: 'known-s',
      source: 'system',
      part: 2,
      offsetMs: 1000,
      path: secret,
      codec: 'opus',
      sampleRate: RATE,
      startedAt: 2,
      durationMs: 1000,
      bytes: 9,
      status: 'complete',
      userId: 'u1',
    });
    const s = storage();
    const playable = await s.playable('known-s');
    expect(playable.recordings.map((r) => r.id)).toEqual([mic.id]);
    const info = await player(s).open('known-s');
    expect(info.parts).toEqual([expect.objectContaining({ part: 1, sources: ['mic'] })]);
  });

  it('marks parts repaired after a crash as partial', async () => {
    await part('known-p', 'mic', 1, 0, tone(ms(1000), 440));
    await part('known-p', 'mic', 2, 1000, tone(ms(1000), 440), { status: 'partial' });
    const info = await player().open('known-p');
    expect(info.parts.map((p) => p.partial)).toEqual([false, true]);
  });
});
