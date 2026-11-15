/**
 * Onboarding's test recording (9.2) with the real pipeline pieces: FileSource (fixture WAV) + FakeSttProvider
 * (ground truth). Nothing is written anywhere (the class has no store or folder to write to).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type AudioSource, FileSource } from '@oat/audio';
import type { TestRecordingSnapshot } from '@oat/core/bridge';
import { FakeSttProvider, parseGroundTruth, type SttProvider } from '@oat/stt';
import { describe, expect, it, vi } from 'vitest';

import type { Logger } from './ipc.ts';
import { TestRecording, TestRecordingError } from './test-recording.ts';

const FIXTURES = fileURLToPath(new URL('../../../../fixtures/audio/', import.meta.url));
const truth = parseGroundTruth(
  JSON.parse(readFileSync(join(FIXTURES, 'standup-short.segments.json'), 'utf8')),
);
const spec = { input: 'file', fixture: 'standup-short' } as const;

function harness({
  durationMs = 60_000,
  source = () =>
    new FileSource({ input: { stereo: join(FIXTURES, 'standup-short.wav') }, speed: 'fast' }),
  stt = () => Promise.resolve(new FakeSttProvider({ segments: truth })),
}: {
  durationMs?: number;
  source?: () => AudioSource;
  stt?: () => Promise<SttProvider>;
} = {}) {
  const states: TestRecordingSnapshot[] = [];
  const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const test = new TestRecording({
    createSource: source,
    createStt: stt,
    durationMs,
    throttleMs: 0,
    onState: (s) => states.push(s),
    log,
  });
  const settled = () =>
    vi.waitFor(
      () => {
        const last = states.at(-1);
        if (last?.status !== 'done' && last?.status !== 'error') throw new Error('still running');
        return last;
      },
      { timeout: 10_000 },
    );
  return { test, states, settled, log };
}

describe('TestRecording', () => {
  it('reports levels and a transcript line for both voices, then finishes', async () => {
    const { test, states, settled } = harness();
    const first = await test.start(spec);
    expect(['starting', 'running']).toContain(first.status);
    const done = await settled();
    expect(done.status).toBe('done');
    expect(done.heard).toEqual({ mic: true, system: true });
    expect(done.transcription).toBe('live');
    expect(done.line?.text.length).toBeGreaterThan(0);
    // Levels were shown for both voices while it ran, and cleared at the end.
    expect(states.some((s) => s.status === 'running' && s.levels.mic && s.levels.system)).toBe(
      true,
    );
    expect(done.levels).toEqual({ mic: null, system: null });
    // Lines from both voices came through.
    const sources = new Set(states.flatMap((s) => (s.line ? [s.line.source] : [])));
    expect(sources).toEqual(new Set(['mic', 'system']));
    // Sequence numbers only go up.
    expect(states.map((s) => s.seq)).toEqual([...states.map((s) => s.seq)].sort((a, b) => a - b));
    expect(test.busy).toBe(false);
  });

  it('stops after its duration', async () => {
    const { test, settled } = harness({
      durationMs: 300,
      source: () =>
        new FileSource({ input: { stereo: join(FIXTURES, 'standup-short.wav') }, speed: 1 }),
    });
    await test.start(spec);
    const done = await settled();
    expect(done.status).toBe('done');
    expect(done.elapsedMs).toBeGreaterThanOrEqual(250);
    expect(done.elapsedMs).toBeLessThanOrEqual(300);
  });

  it('refuses a second start while running; stop ends it early', async () => {
    const { test, settled } = harness({
      source: () =>
        new FileSource({ input: { stereo: join(FIXTURES, 'standup-short.wav') }, speed: 1 }),
    });
    await test.start(spec);
    expect(test.busy).toBe(true);
    await expect(test.start(spec)).rejects.toBeInstanceOf(TestRecordingError);
    const stopped = await test.stop();
    expect(stopped.status).toBe('done');
    expect((await settled()).status).toBe('done');
    // It can run again afterwards.
    await test.start(spec);
    await test.stop();
  });

  it('records without a transcript when transcription is unavailable', async () => {
    const { test, settled } = harness({ stt: () => Promise.reject(new Error('offline')) });
    await test.start(spec);
    const done = await settled();
    expect(done).toMatchObject({ status: 'done', transcription: 'unavailable', line: null });
    expect(done.heard.mic).toBe(true);
  });

  it('fails visibly when there is no audio source', async () => {
    const { test, settled } = harness({
      source: () => {
        throw new Error('oat-audio binary not found');
      },
    });
    await test.start(spec);
    const done = await settled();
    expect(done.status).toBe('error');
    expect(done.error).toMatch(/audio helper/);
    expect(test.busy).toBe(false);
  });

  it('fails visibly when the audio can’t start', async () => {
    const { test, settled } = harness({
      source: () =>
        new FileSource({ input: { stereo: join(FIXTURES, 'does-not-exist.wav') }, speed: 'fast' }),
    });
    await test.start(spec);
    const done = await settled();
    expect(done.status).toBe('error');
    expect(done.error).toMatch(/couldn’t start/);
  });
});
