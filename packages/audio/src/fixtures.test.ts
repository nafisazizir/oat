/**
 * Checks the committed meeting fixtures (`fixtures/audio`) and their ground truth against the audio itself,
 * and that FileSource timestamps line up with the ground truth (what FakeSttProvider and evals rely on).
 */
import { readFile, stat } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { FileSource } from './file-source.ts';
import { measureLevel } from './level.ts';
import type { AudioEvent, AudioFrame, AudioSourceKind } from './types.ts';
import { decodeWav, wavDurationMs } from './wav.ts';

const DIR = new URL('../../../fixtures/audio/', import.meta.url);
const FIXTURES = [
  { name: 'standup-short', minS: 25, maxS: 40 },
  { name: 'one-on-one', minS: 40, maxS: 47 },
  { name: 'silence-gap', minS: 20, maxS: 35 },
] as const;
/** Generator trims TTS edges at |sample| ≤ 100; the noise floor never gets near that. */
const SPEECH_SAMPLE = 100;

interface Segment {
  source: AudioSourceKind;
  startMs: number;
  endMs: number;
  text: string;
}

async function load(name: string) {
  const bytes = await readFile(new URL(`${name}.wav`, DIR));
  const segments = JSON.parse(
    await readFile(new URL(`${name}.segments.json`, DIR), 'utf8'),
  ) as Segment[];
  const script = JSON.parse(await readFile(new URL(`${name}.json`, DIR), 'utf8')) as {
    speaker: string;
    text: string;
  }[];
  return { bytes, wav: decodeWav(bytes), segments, script };
}

const channelOf = (source: AudioSourceKind) => (source === 'mic' ? 0 : 1);
const ms = (v: number) => Math.round((v * 16_000) / 1000);

describe.each(FIXTURES)('fixture $name', ({ name, minS, maxS }) => {
  it('is a 2-channel 16 kHz 16-bit WAV under 3 MB of a sensible length', async () => {
    const { wav, bytes } = await load(name);
    expect(wav.channels).toHaveLength(2);
    expect(wav.sampleRate).toBe(16_000);
    expect(wav.sourceBitsPerSample).toBe(16);
    expect((await stat(new URL(`${name}.wav`, DIR))).size).toBe(bytes.length);
    expect(bytes.length).toBeLessThan(3_000_000);
    const seconds = wavDurationMs(wav) / 1000;
    expect(seconds).toBeGreaterThanOrEqual(minS);
    expect(seconds).toBeLessThanOrEqual(maxS);
  });

  it('ground truth matches the script and is ordered, in range, and non-overlapping per source', async () => {
    const { wav, segments, script } = await load(name);
    expect(segments.map((s) => s.text).sort()).toEqual(script.map((l) => l.text).sort());
    for (const line of script) {
      const segment = segments.find((s) => s.text === line.text)!;
      expect(segment.source).toBe(line.speaker === 'me' ? 'mic' : 'system');
    }
    const durationMs = wavDurationMs(wav);
    expect(segments.every((s, i) => i === 0 || s.startMs >= segments[i - 1]!.startMs)).toBe(true);
    for (const s of segments) {
      expect(s.startMs).toBeGreaterThanOrEqual(0);
      expect(s.endMs).toBeGreaterThan(s.startMs);
      expect(s.endMs).toBeLessThanOrEqual(durationMs);
    }
    for (const source of ['mic', 'system'] as const) {
      const own = segments.filter((s) => s.source === source);
      expect(own.length).toBeGreaterThan(0);
      for (let i = 1; i < own.length; i++)
        expect(own[i]!.startMs).toBeGreaterThanOrEqual(own[i - 1]!.endMs);
    }
  });

  it('speech is exactly where the ground truth says, on the right channel', async () => {
    const { wav, segments } = await load(name);
    for (const source of ['mic', 'system'] as const) {
      const pcm = wav.channels[channelOf(source)]!;
      const own = segments.filter((s) => s.source === source);
      for (const s of own) {
        // Voiced segment: loud overall, and voiced right at both edges.
        expect(measureLevel(pcm, ms(s.startMs), ms(s.endMs)).rmsDb).toBeGreaterThan(-35);
        expect(measureLevel(pcm, ms(s.startMs), ms(s.startMs) + 160).peak * 32768).toBeGreaterThan(
          SPEECH_SAMPLE,
        );
        expect(measureLevel(pcm, ms(s.endMs) - 160, ms(s.endMs)).peak * 32768).toBeGreaterThan(
          SPEECH_SAMPLE,
        );
      }
      // Everything outside this source's segments (±1 ms rounding) is the noise floor only.
      let cursor = 0;
      for (const s of [...own, { startMs: wavDurationMs(wav) + 1, endMs: 0 }]) {
        const quiet = measureLevel(pcm, ms(cursor + 1), ms(s.startMs - 1));
        expect(quiet.peak * 32768).toBeLessThanOrEqual(SPEECH_SAMPLE);
        cursor = s.endMs;
      }
    }
  });

  it('FileSource frame timestamps line up with the ground truth', async () => {
    const { segments } = await load(name);
    const source = new FileSource({
      input: { stereo: new URL(`${name}.wav`, DIR) },
      speed: 'fast',
    });
    const frames: Record<AudioSourceKind, AudioFrame[]> = { mic: [], system: [] };
    source.onFrame((f) => frames[f.source].push(f));
    await source.start();
    await source.whenStopped();

    for (const s of segments) {
      const list = frames[s.source];
      // The frame containing the segment's first sample is voiced; the frame before it is not.
      const index = list.findIndex(
        (f) => f.tUs <= s.startMs * 1000 && s.startMs * 1000 < f.tUs + 20_000,
      );
      expect(index).toBeGreaterThan(0);
      expect(measureLevel(list[index]!.pcm).peak * 32768).toBeGreaterThan(SPEECH_SAMPLE);
      expect(measureLevel(list[index - 1]!.pcm).peak * 32768).toBeLessThanOrEqual(SPEECH_SAMPLE);
    }
  });
});

describe('silence-gap fixture', () => {
  it('has ≥ 10 s where both sources are silent, visible in FileSource level events', async () => {
    const { segments } = await load('silence-gap');
    const gaps = segments
      .slice(1)
      .map((s, i) => s.startMs - Math.max(...segments.slice(0, i + 1).map((p) => p.endMs)));
    expect(Math.max(...gaps)).toBeGreaterThanOrEqual(10_000);

    const source = new FileSource({
      input: { stereo: new URL('silence-gap.wav', DIR) },
      speed: 'fast',
    });
    const levels: Extract<AudioEvent, { type: 'level' }>[] = [];
    source.onEvent((e) => {
      if (e.type === 'level') levels.push(e);
    });
    await source.start();
    await source.whenStopped();

    // Longest run of 250 ms windows where mic and system are both below −55 dBFS.
    const quiet = new Map<number, number>();
    for (const l of levels) if (l.rmsDb < -55) quiet.set(l.tUs, (quiet.get(l.tUs) ?? 0) + 1);
    let run = 0;
    let longest = 0;
    for (const tUs of [...new Set(levels.map((l) => l.tUs))].sort((a, b) => a - b)) {
      run = quiet.get(tUs) === 2 ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
    expect(longest * 250).toBeGreaterThanOrEqual(9_500);
  });
});
