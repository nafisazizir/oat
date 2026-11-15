/**
 * Archive files play in standard tools (task 2.8 acceptance): ffprobe/ffmpeg and macOS `afinfo` read and
 * decode what `OpusArchiveWriter` produced, including a crash-repaired file. Each check is skipped when the
 * tool is not installed.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { repairOpusFile } from './archive-recovery.ts';
import { OpusArchiveWriter } from './opus-archive.ts';
import { toFrames } from './testing/signals.ts';
import { decodeWav } from './wav.ts';

const FIXTURE = new URL('../../../fixtures/audio/standup-short.wav', import.meta.url);
const has = (tool: string) => spawnSync(tool, ['-h'], { stdio: 'ignore' }).error === undefined;
const FFPROBE = has('ffprobe');
const FFMPEG = has('ffmpeg');
const AFINFO = process.platform === 'darwin' && has('afinfo');

let dir: string;
let complete: string;
let repaired: string;
let samples: number;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oat-archive-int-'));
  const wav = decodeWav(await readFile(FIXTURE));
  const mic = wav.channels[0] as Int16Array;
  samples = mic.length;
  complete = join(dir, 'mic.opus');
  const writer = await OpusArchiveWriter.open({ path: complete, originUs: 0, source: 'mic' });
  for (const frame of toFrames(mic)) await writer.write(frame);
  await writer.close();
  // A crash leftover: unclosed writer, file torn in the middle of a page, then repaired.
  repaired = join(dir, 'torn.opus');
  const torn = await OpusArchiveWriter.open({ path: repaired, originUs: 0, pageMs: 500 });
  for (const frame of toFrames(mic)) await torn.write(frame);
  await torn.abandon();
  const bytes = await readFile(repaired);
  await writeFile(repaired, bytes.subarray(0, Math.floor(bytes.length * 0.6)));
  await repairOpusFile(repaired);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('archive files in standard tools', () => {
  it.skipIf(!FFPROBE)('ffprobe identifies Ogg Opus, mono', () => {
    for (const path of [complete, repaired]) {
      const out = execFileSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_entries',
          'stream=codec_name,channels:format=format_name',
          '-of',
          'json',
          path,
        ],
        { encoding: 'utf8' },
      );
      console.info(`ffprobe ${path.split('/').at(-1)}: ${out.replace(/\s+/g, ' ')}`);
      const json = JSON.parse(out) as {
        streams: { codec_name: string; channels: number }[];
        format: { format_name: string };
      };
      expect(json.format.format_name).toBe('ogg');
      expect(json.streams[0]).toMatchObject({ codec_name: 'opus', channels: 1 });
    }
  });

  it.skipIf(!FFMPEG)(
    'ffmpeg decodes the whole file to the exact sample count without errors',
    () => {
      const pcm = execFileSync(
        'ffmpeg',
        ['-v', 'error', '-i', complete, '-f', 's16le', '-ar', '16000', '-'],
        {
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      expect(pcm.length / 2).toBe(samples);
      const torn = execFileSync(
        'ffmpeg',
        ['-v', 'error', '-i', repaired, '-f', 's16le', '-ar', '16000', '-'],
        {
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      expect(torn.length).toBeGreaterThan(0);
    },
  );

  it.skipIf(!AFINFO)('afinfo (Core Audio) reads it, with the encoder delay as priming', () => {
    for (const path of [complete, repaired]) {
      const out = execFileSync('afinfo', [path], { encoding: 'utf8' });
      console.info(`afinfo ${path.split('/').at(-1)}:\n${out}`);
      expect(out).toMatch(/File type ID:\s+Oggf/);
      expect(out).toMatch(/1 ch,\s+48000 Hz, opus/);
      if (path === complete) {
        // "<valid> valid frames + 312 priming + …": valid frames at 48 kHz = our sample count × 3.
        expect(out).toContain(`${samples * 3} valid frames + 312 priming`);
      }
    }
  });
});
