/**
 * Builds two-channel meeting fixtures from JSON scripts with macOS text-to-speech, fully offline.
 *
 *   node packages/audio/scripts/make-fixtures.ts [name…]     regenerate (default: every script)
 *   node packages/audio/scripts/make-fixtures.ts --check      regenerate in memory, compare ground truth
 *
 * Input  `fixtures/audio/<name>.json`: `[{ "speaker": "me" | "them", "text": "…", "gapMs": 400 }, …]`.
 *        `gapMs` is the pause after the previous line ends (negative = talks over it; first line: lead-in).
 * Output `fixtures/audio/<name>.wav`: 16 kHz s16 stereo, L = mic ("me"), R = system ("them").
 *        `fixtures/audio/<name>.segments.json`: ground truth `[{ source, startMs, endMs, text }]` where the
 *        range is the voiced part of each line (TTS edge silence trimmed).
 *
 * Each line is rendered with `say` (fixed voice + rate) and converted with `afconvert`; timings come from the
 * rendered audio, so they are deterministic for a given macOS voice set. On other platforms it is a no-op —
 * the generated fixtures are committed.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeWav, encodeWav } from '../src/wav.ts';

const FIXTURES_DIR = fileURLToPath(new URL('../../../fixtures/audio/', import.meta.url));
const SAMPLE_RATE = 16_000;
/** Two clearly different built-in voices: US English female for "me", UK English male for "them". */
const VOICES = { me: 'Samantha', them: 'Daniel' } as const;
const WORDS_PER_MINUTE = '180';
const TAIL_MS = 800;
/** |sample| at or below this counts as TTS edge silence when trimming (≈ −50 dBFS). */
const TRIM_THRESHOLD = 100;
/** Background noise floor so "silence" is not digital zero (≈ −70 dBFS RMS), deterministic per fixture. */
const NOISE_RMS = 10;
const MAX_WAV_BYTES = 3_000_000;

interface ScriptLine {
  speaker: 'me' | 'them';
  text: string;
  gapMs: number;
}

export interface GroundTruthSegment {
  source: 'mic' | 'system';
  startMs: number;
  endMs: number;
  text: string;
}

function main(): number {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const names = args.filter((a) => !a.startsWith('--'));

  if (process.platform !== 'darwin' || !hasTool('say') || !hasTool('afconvert')) {
    console.log(
      'make-fixtures: needs macOS `say` + `afconvert`; skipping (fixtures are committed).',
    );
    return 0;
  }

  const all = readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.segments.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
  const targets = names.length > 0 ? names : all;
  let failed = false;

  for (const name of targets) {
    const script = parseScript(name, readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf8'));
    const { wav, segments } = build(name, script);
    const segmentsJson = formatSegments(segments);
    const durationS = (wav.length - 44) / 4 / SAMPLE_RATE;
    const summary = `${name}: ${durationS.toFixed(1)} s, ${segments.length} segments, ${(wav.length / 1024).toFixed(0)} KiB`;

    if (wav.length > MAX_WAV_BYTES) {
      console.error(`${summary} — exceeds the 3 MB fixture budget, shorten the script`);
      failed = true;
      continue;
    }
    if (check) {
      const segPath = join(FIXTURES_DIR, `${name}.segments.json`);
      const committed = readFileSync(segPath, 'utf8');
      const sameWav = Buffer.compare(readFileSync(join(FIXTURES_DIR, `${name}.wav`)), wav) === 0;
      if (committed === segmentsJson) {
        console.log(
          `${summary} — ground truth identical; wav bytes ${sameWav ? 'identical' : 'differ'}`,
        );
      } else {
        console.error(`${summary} — ground truth DIFFERS from ${segPath}`);
        failed = true;
      }
      continue;
    }
    writeFileSync(join(FIXTURES_DIR, `${name}.wav`), wav);
    writeFileSync(join(FIXTURES_DIR, `${name}.segments.json`), segmentsJson);
    console.log(`${summary} — written`);
  }
  return failed ? 1 : 0;
}

function build(
  name: string,
  script: ScriptLine[],
): { wav: Uint8Array; segments: GroundTruthSegment[] } {
  const tmp = mkdtempSync(join(tmpdir(), 'oat-fixture-'));
  try {
    const placed: { line: ScriptLine; start: number; pcm: Int16Array }[] = [];
    let end = 0;
    script.forEach((line, i) => {
      const pcm = trim(synthesize(line, join(tmp, `line-${i}`)));
      const start = Math.max(0, end + msToSamples(line.gapMs));
      placed.push({ line, start, pcm });
      end = Math.max(end, start + pcm.length);
    });

    const total = end + msToSamples(TAIL_MS);
    const random = mulberry32(hash(name));
    const channels = [noise(total, random), noise(total, random)];
    for (const { line, start, pcm } of placed) {
      const channel = channels[line.speaker === 'me' ? 0 : 1] as Int16Array;
      for (let i = 0; i < pcm.length; i++) {
        const v = (channel[start + i] as number) + (pcm[i] as number);
        channel[start + i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
      }
    }

    const segments = placed
      .map(({ line, start, pcm }) => ({
        source: line.speaker === 'me' ? ('mic' as const) : ('system' as const),
        startMs: samplesToMs(start),
        endMs: samplesToMs(start + pcm.length),
        text: line.text,
      }))
      .sort((a, b) => a.startMs - b.startMs);
    return { wav: encodeWav({ sampleRate: SAMPLE_RATE, channels }), segments };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function synthesize(line: ScriptLine, base: string): Int16Array {
  const aiff = `${base}.aiff`;
  const wav = `${base}.wav`;
  execFileSync('say', ['-v', VOICES[line.speaker], '-r', WORDS_PER_MINUTE, '-o', aiff, line.text]);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', `LEI16@${SAMPLE_RATE}`, '-c', '1', aiff, wav]);
  const decoded = decodeWav(readFileSync(wav));
  if (decoded.sampleRate !== SAMPLE_RATE || decoded.channels.length !== 1) {
    throw new Error(`afconvert produced ${decoded.sampleRate} Hz × ${decoded.channels.length} ch`);
  }
  return decoded.channels[0] as Int16Array;
}

function trim(pcm: Int16Array): Int16Array {
  let a = 0;
  let b = pcm.length;
  while (a < b && Math.abs(pcm[a] as number) <= TRIM_THRESHOLD) a++;
  while (b > a && Math.abs(pcm[b - 1] as number) <= TRIM_THRESHOLD) b--;
  if (a === b) throw new Error('TTS produced silence');
  return pcm.slice(a, b);
}

function noise(length: number, random: () => number): Int16Array {
  const out = new Int16Array(length);
  // Sum of 3 uniforms ≈ Gaussian; variance of each is 1/12 → scale so RMS ≈ NOISE_RMS.
  const scale = NOISE_RMS / Math.sqrt(3 / 12);
  for (let i = 0; i < length; i++) {
    out[i] = Math.round((random() + random() + random() - 1.5) * scale);
  }
  return out;
}

function parseScript(name: string, text: string): ScriptLine[] {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data) || data.length === 0)
    throw new Error(`${name}.json: expected a non-empty array`);
  return data.map((raw: unknown, i) => {
    const line = raw as Partial<ScriptLine>;
    if (
      (line.speaker !== 'me' && line.speaker !== 'them') ||
      typeof line.text !== 'string' ||
      line.text.trim() === '' ||
      typeof line.gapMs !== 'number' ||
      !Number.isFinite(line.gapMs)
    ) {
      throw new Error(`${name}.json[${i}]: expected { speaker: "me"|"them", text, gapMs }`);
    }
    return { speaker: line.speaker, text: line.text, gapMs: line.gapMs };
  });
}

/** Same layout Prettier produces for this shape, so `format:check` passes on regenerated files. */
function formatSegments(segments: GroundTruthSegment[]): string {
  return `${JSON.stringify(segments, null, 2)}\n`;
}

function hasTool(tool: string): boolean {
  try {
    execFileSync('/usr/bin/which', [tool], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function msToSamples(ms: number): number {
  return Math.round((ms * SAMPLE_RATE) / 1000);
}

function samplesToMs(samples: number): number {
  return Math.round((samples * 1000) / SAMPLE_RATE);
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

process.exitCode = main();
