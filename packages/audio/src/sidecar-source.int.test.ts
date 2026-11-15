/**
 * SidecarSource against the real `oat-audio` binary in `--synthetic` mode (deterministic tones, no devices,
 * no permission prompts — never run capture without `--synthetic` here). Skipped unless on macOS with the
 * binary built (`pnpm --filter @oat/audio build:sidecar`) or `OAT_AUDIO_BIN` set.
 */
import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { RecordingController } from './recording-controller.ts';
import { FrameParser, validateFrames, type RawFrame } from './sidecar-protocol.ts';
import { locateSidecarBinary, SidecarSource, type SidecarSourceOptions } from './sidecar-source.ts';
import type { AudioEvent, AudioFrame, AudioSourceKind } from './types.ts';

function findBinary(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    return locateSidecarBinary();
  } catch {
    return undefined;
  }
}
const BINARY = findBinary();
const REFERENCE = new URL('../../../native/oat-audio/scripts/check-frames.mjs', import.meta.url);

const live: SidecarSource[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((s) => s.stop().catch(() => undefined)));
});

function synthetic(options: Omit<SidecarSourceOptions, 'synthetic' | 'binary'> = {}) {
  // `synthetic: true` is forced: real capture would trigger macOS permission prompts.
  const source = new SidecarSource({ ...options, binary: BINARY!, synthetic: true });
  live.push(source);
  const frames: AudioFrame[] = [];
  const events: AudioEvent[] = [];
  const log: (AudioFrame | AudioEvent)[] = [];
  source.onFrame((f) => {
    frames.push(f);
    log.push(f);
  });
  source.onEvent((e) => {
    events.push(e);
    log.push(e);
  });
  return { source, frames, events, log };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, timeoutMs = 5000) {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('timed out waiting for condition');
    await sleep(10);
  }
}
const bySource = (frames: AudioFrame[], s: AudioSourceKind) => frames.filter((f) => f.source === s);
const isEvent = (x: AudioFrame | AudioEvent): x is AudioEvent => 'type' in x;
const indexOfEvent = (log: (AudioFrame | AudioEvent)[], type: string) =>
  log.findIndex((x) => isEvent(x) && x.type === type);
function expectStrictlyIncreasing(frames: AudioFrame[]) {
  for (let i = 1; i < frames.length; i++)
    expect(frames[i]!.tUs).toBeGreaterThan(frames[i - 1]!.tUs);
}

describe.skipIf(!BINARY)('SidecarSource ↔ oat-audio --synthetic', () => {
  it('raw stdout passes both the TS validator and check-frames.mjs identically', async () => {
    const child = spawn(BINARY!, ['capture', '--synthetic', '--duration', '1'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    for await (const chunk of child.stdout) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);
    const ours = new FrameParser();
    const frames: RawFrame[] = [];
    // Feed in odd-sized chunks to exercise boundaries on real data.
    for (let off = 0; off < bytes.length; off += 997)
      frames.push(...ours.push(bytes.subarray(off, off + 997)));
    const result = validateFrames(frames, { expectSeconds: 1, trailingBytes: ours.pending });
    expect(result.errors).toEqual([]);

    const ref = (await import(REFERENCE.href)) as {
      FrameParser: new () => { push(c: Buffer): unknown[]; pending: number };
      validateFrames(f: unknown[], o: object): unknown;
    };
    const refParser = new ref.FrameParser();
    const refFrames = refParser.push(bytes);
    expect(result).toEqual(
      ref.validateFrames(refFrames, { expectSeconds: 1, trailingBytes: refParser.pending }),
    );
  });

  it('2 s capture: frames match FileSource’s shape, counts and timestamps line up', async () => {
    const { source, frames, events, log } = synthetic({ durationSeconds: 2 });
    await source.start();
    const stopped = await source.whenStopped();

    expect(log[0]).toMatchObject({
      type: 'started',
      sampleRate: 16_000,
      frameMs: 50,
      sources: ['mic', 'system'],
      protocol: 1,
      synthetic: true,
    });
    expect(log.at(-1)).toBe(stopped);
    expect(stopped.reason).toBe('duration');
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(events.filter((e) => e.type === 'level').length).toBeGreaterThanOrEqual(14);

    for (const s of ['mic', 'system'] as const) {
      const own = bySource(frames, s);
      const samples = own.reduce((n, f) => n + f.pcm.length, 0);
      expect(Math.abs(samples - 32_000)).toBeLessThanOrEqual(800);
      expect(stopped.samples[s]).toBe(samples);
      expectStrictlyIncreasing(own);
      // Sample-count clock: consecutive frames are exactly one frame (50 ms) apart.
      for (let i = 1; i < own.length; i++) {
        const prev = own[i - 1]!;
        expect(own[i]!.tUs - prev.tUs).toBe((prev.pcm.length * 1_000_000) / 16_000);
      }
      expect(own.some((f) => f.pcm.some((v) => v !== 0))).toBe(true);
    }
    for (const frame of frames) {
      // Same shape as FileSource frames.
      expect(Object.keys(frame).sort()).toEqual(['pcm', 'sampleRate', 'source', 'tUs']);
      expect(frame.pcm).toBeInstanceOf(Int16Array);
      expect(frame.sampleRate).toBe(16_000);
      expect(frame.pcm.length).toBeLessThanOrEqual(800);
    }
    // Mic and system share one clock.
    const firstMic = bySource(frames, 'mic')[0]!.tUs;
    const firstSys = bySource(frames, 'system')[0]!.tUs;
    expect(Math.abs(firstMic - firstSys)).toBeLessThan(100_000);
  });

  it('pause / resume: no audio while paused, timeline jumps forward', async () => {
    const { source, frames, events, log } = synthetic();
    await source.start();
    await sleep(500);
    source.pause();
    await until(() => indexOfEvent(log, 'paused') >= 0);
    await sleep(500);
    source.resume();
    await until(() => indexOfEvent(log, 'resumed') >= 0);
    await sleep(500);
    await source.stop();

    const paused = indexOfEvent(log, 'paused');
    const resumed = indexOfEvent(log, 'resumed');
    expect(log.slice(paused, resumed).filter((x) => !isEvent(x))).toEqual([]);
    for (const s of ['mic', 'system'] as const) {
      const own = bySource(frames, s);
      expectStrictlyIncreasing(own);
      const before = log
        .slice(0, paused)
        .filter((x): x is AudioFrame => !isEvent(x) && x.source === s);
      const after = log
        .slice(resumed)
        .filter((x): x is AudioFrame => !isEvent(x) && x.source === s);
      expect(before.length).toBeGreaterThan(3);
      expect(after.length).toBeGreaterThan(3);
      const last = before.at(-1)!;
      expect(after[0]!.tUs - (last.tUs + (last.pcm.length * 1e6) / 16_000)).toBeGreaterThan(
        300_000,
      );
    }
    expect(events.at(-1)).toMatchObject({ type: 'stopped', reason: 'command' });
  });

  it('stop() is graceful: `stopped` with reason command, process gone', async () => {
    const { source, events } = synthetic();
    await source.start();
    const pid = source.pid!;
    await sleep(300);
    const t0 = Date.now();
    await source.stop();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(events.at(-1)).toMatchObject({ type: 'stopped', reason: 'command' });
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('killing the sidecar without a restart policy surfaces a fatal error', async () => {
    const { source, events } = synthetic();
    await source.start();
    await sleep(300);
    process.kill(source.pid!, 'SIGKILL');
    const stopped = await source.whenStopped();
    expect(stopped.reason).toBe('error');
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      code: 'sidecar_exited',
      fatal: true,
      message: expect.stringContaining('signal SIGKILL'),
    });
  });

  it('RecordingController drives the sidecar end to end', async () => {
    const controller = new RecordingController({
      createSource: () => synthetic({ restart: true }).source,
    });
    const states: string[] = [];
    controller.onStateChange((c) => states.push(c.to));
    const got: AudioFrame[] = [];
    const sub = controller.subscribe((f) => void got.push(f));
    await controller.start();
    await sleep(300);
    controller.pause();
    await sleep(200);
    controller.resume();
    await sleep(300);
    const stopped = await controller.stop();
    await sub.drained();
    expect(states).toEqual(['starting', 'recording', 'paused', 'recording', 'stopping', 'idle']);
    expect(stopped?.reason).toBe('command');
    const delivered = got.reduce((n, f) => n + f.pcm.length, 0);
    expect(delivered).toBe(stopped!.samples.mic + stopped!.samples.system);
    expect(sub.stats.dropped).toBe(0);
  });

  it('killing the sidecar with a restart policy recovers with a continuous clock', async () => {
    const { source, frames, events } = synthetic({ restart: { initialDelayMs: 50 } });
    await source.start();
    await sleep(400);
    const firstPid = source.pid!;
    process.kill(firstPid, 'SIGKILL');
    await until(() => source.restarts === 1 && source.pid !== undefined);
    const atRestart = frames.length;
    await until(() => frames.length >= atRestart + 10);
    expect(source.state).toBe('running');
    await source.stop();
    const stopped = await source.whenStopped();

    expect(source.pid).toBeUndefined();
    expect(events.filter((e) => e.type === 'started')).toHaveLength(1);
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      code: 'sidecar_exited',
      fatal: false,
    });
    expect(stopped.reason).toBe('command');
    for (const s of ['mic', 'system'] as const) {
      const own = bySource(frames, s);
      expectStrictlyIncreasing(own);
      expect(stopped.samples[s]).toBe(own.reduce((n, f) => n + f.pcm.length, 0));
    }
  });
});
