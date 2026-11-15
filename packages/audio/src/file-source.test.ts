import { readFile } from 'node:fs/promises';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { framesOf } from './emitter.ts';
import { FileSource, type FileSourceOptions } from './file-source.ts';
import type { AudioEvent, AudioFrame, AudioSourceKind } from './types.ts';
import { decodeWav, encodeWav, wavDurationMs, type DecodedWav } from './wav.ts';

const STANDUP = new URL('../../../fixtures/audio/standup-short.wav', import.meta.url);

async function play(
  options: FileSourceOptions,
  hooks: { onFrame?: (f: AudioFrame, s: FileSource) => void } = {},
) {
  const source = new FileSource(options);
  const frames: AudioFrame[] = [];
  const events: AudioEvent[] = [];
  source.onFrame((frame) => {
    frames.push(frame);
    hooks.onFrame?.(frame, source);
  });
  source.onEvent((event) => events.push(event));
  const t0 = performance.now();
  await source.start();
  const stopped = await source.whenStopped();
  return { source, frames, events, stopped, elapsedMs: performance.now() - t0 };
}

function bySource(frames: AudioFrame[], source: AudioSourceKind): AudioFrame[] {
  return frames.filter((f) => f.source === source);
}

/** Every frame starts exactly where the previous one ended (sample-count clock). */
function expectContiguous(frames: AudioFrame[], firstUs = 0) {
  let expected = firstUs;
  for (const frame of frames) {
    expect(Math.abs(frame.tUs - expected)).toBeLessThanOrEqual(1);
    expected = frame.tUs + (frame.pcm.length * 1_000_000) / frame.sampleRate;
  }
}

function tone(rate: number, seconds: number, freq = 440, amplitude = 8000): Int16Array {
  return Int16Array.from({ length: Math.round(rate * seconds) }, (_, i) =>
    Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / rate)),
  );
}

function stereoWav(seconds: number, rate = 16_000): Uint8Array {
  return encodeWav({
    sampleRate: rate,
    channels: [tone(rate, seconds, 300), tone(rate, seconds, 700)],
  });
}

describe('FileSource — fast mode on standup-short.wav', () => {
  let fixture: DecodedWav;
  let fileMs: number;
  let run: Awaited<ReturnType<typeof play>>;
  beforeAll(async () => {
    fixture = decodeWav(await readFile(STANDUP));
    fileMs = wavDurationMs(fixture);
    run = await play({ input: { stereo: STANDUP }, speed: 'fast' });
  });

  it('emits both sources covering the whole file (within one frame)', () => {
    expect(run.source.durationMs).toBeCloseTo(fileMs, 6);
    for (const source of ['mic', 'system'] as const) {
      const frames = bySource(run.frames, source);
      const samples = frames.reduce((n, f) => n + f.pcm.length, 0);
      expect(Math.abs((samples / 16_000) * 1000 - fileMs)).toBeLessThanOrEqual(20);
      const last = frames.at(-1)!;
      expect(Math.abs(last.tUs / 1000 + last.pcm.length / 16 - fileMs)).toBeLessThanOrEqual(20);
    }
  });

  it('has the exact PCM of each channel, L = mic, R = system', () => {
    const join = (frames: AudioFrame[]) => Int16Array.from(frames.flatMap((f) => [...f.pcm]));
    expect(join(bySource(run.frames, 'mic'))).toEqual(fixture.channels[0]);
    expect(join(bySource(run.frames, 'system'))).toEqual(fixture.channels[1]);
  });

  it('emits 20 ms frames (320 samples) with only the last one allowed shorter', () => {
    for (const source of ['mic', 'system'] as const) {
      const frames = bySource(run.frames, source);
      expect(frames.slice(0, -1).every((f) => f.pcm.length === 320)).toBe(true);
      expect(frames.at(-1)!.pcm.length).toBeGreaterThan(0);
      expect(frames.at(-1)!.pcm.length).toBeLessThanOrEqual(320);
      expect(frames.every((f) => f.sampleRate === 16_000)).toBe(true);
    }
  });

  it('timestamps are strictly increasing and contiguous per source, on one shared clock', () => {
    const mic = bySource(run.frames, 'mic');
    const system = bySource(run.frames, 'system');
    expectContiguous(mic);
    expectContiguous(system);
    expect(mic.map((f) => f.tUs)).toEqual(system.map((f) => f.tUs));
    expect(mic.every((f, i) => i === 0 || f.tUs > mic[i - 1]!.tUs)).toBe(true);
  });

  it('frames never share buffers', () => {
    const buffers = new Set(run.frames.map((f) => f.pcm.buffer));
    expect(buffers.size).toBe(run.frames.length);
  });

  it('brackets the session with started/stopped and reports levels every 250 ms', () => {
    expect(run.events[0]).toEqual({
      type: 'started',
      tUs: 0,
      sampleRate: 16_000,
      frameMs: 20,
      sources: ['mic', 'system'],
    });
    const stopped = run.events.at(-1);
    expect(stopped).toEqual(run.stopped);
    expect(run.stopped.reason).toBe('end_of_input');
    expect(run.stopped.samples).toEqual({
      mic: fixture.channels[0]!.length,
      system: fixture.channels[1]!.length,
    });
    expect(run.source.state).toBe('stopped');

    const levels = run.events.filter((e) => e.type === 'level');
    const expected = Math.floor(fixture.channels[0]!.length / 4000);
    expect(levels.filter((e) => e.source === 'mic')).toHaveLength(expected);
    expect(levels.filter((e) => e.source === 'system')).toHaveLength(expected);
    expect(levels.every((e) => e.rmsDb <= e.peakDb && e.rmsDb >= -100)).toBe(true);
  });

  it('runs much faster than real time', () => {
    expect(run.elapsedMs).toBeLessThan(fileMs / 5);
  });
});

describe('FileSource — pacing', () => {
  it('realtime mode takes about real time (1 s slice) and starts the clock at the slice', async () => {
    const run = await play({
      input: { stereo: STANDUP },
      speed: 'realtime',
      startMs: 5000,
      durationMs: 1000,
    });
    expect(run.elapsedMs).toBeGreaterThanOrEqual(950);
    expect(run.elapsedMs).toBeLessThan(1300);
    const mic = bySource(run.frames, 'mic');
    expect(mic).toHaveLength(50);
    expectContiguous(mic, 5_000_000);
    expect(run.events[0]).toMatchObject({ type: 'started', tUs: 5_000_000 });
    expect(run.stopped).toMatchObject({ tUs: 6_000_000, samples: { mic: 16_000, system: 16_000 } });
  });

  it('delivers realtime frames when their last sample would have been captured', async () => {
    const source = new FileSource({ input: { stereo: stereoWav(0.4) }, speed: 'realtime' });
    const lateness: number[] = [];
    let t0 = 0;
    source.onFrame((f) => {
      if (f.source === 'mic') lateness.push(performance.now() - t0 - (f.tUs / 1000 + 20));
    });
    t0 = performance.now();
    await source.start();
    await source.whenStopped();
    expect(lateness).toHaveLength(20);
    expect(Math.min(...lateness)).toBeGreaterThan(-2);
    expect(Math.max(...lateness)).toBeLessThan(60);
  });

  it('a numeric speed is a multiple of real time', async () => {
    const run = await play({ input: { stereo: stereoWav(1) }, speed: 4 });
    expect(run.elapsedMs).toBeGreaterThanOrEqual(235);
    expect(run.elapsedMs).toBeLessThan(450);
    expect(run.stopped.samples.mic).toBe(16_000);
  });

  it('a very high numeric speed still yields, so an external pause()/stop() lands mid-file', async () => {
    const source = new FileSource({ input: { stereo: stereoWav(10) }, speed: 1e6 });
    await source.start();
    await new Promise((r) => setTimeout(r, 0));
    source.pause();
    expect(source.state).toBe('paused');
    await source.stop();
    const stopped = await source.whenStopped();
    expect(stopped.reason).toBe('command');
    expect(stopped.samples.mic).toBeLessThan(160_000);
  });

  it('validates options', () => {
    expect(() => new FileSource({ input: { stereo: STANDUP }, frameMs: 10 })).toThrow(RangeError);
    expect(() => new FileSource({ input: { stereo: STANDUP }, frameMs: 101 })).toThrow(RangeError);
    expect(() => new FileSource({ input: { stereo: STANDUP }, speed: 0 })).toThrow(RangeError);
    expect(() => new FileSource({ input: { stereo: STANDUP }, speed: Infinity })).toThrow(
      RangeError,
    );
  });
});

describe('FileSource — pause / resume / stop', () => {
  it('fast mode: no frames while paused, then continues seamlessly', async () => {
    const source = new FileSource({ input: { stereo: stereoWav(2) }, speed: 'fast' });
    const frames: AudioFrame[] = [];
    const events: AudioEvent[] = [];
    source.onEvent((e) => events.push(e));
    let paused = false;
    source.onFrame((f) => {
      frames.push(f);
      if (!paused && f.source === 'system' && frames.length === 20) {
        paused = true;
        source.pause();
      }
    });
    await source.start();
    await new Promise((r) => setTimeout(r, 80));
    expect(source.state).toBe('paused');
    expect(frames).toHaveLength(20);
    source.resume();
    const stopped = await source.whenStopped();

    expect(stopped.reason).toBe('end_of_input');
    expectContiguous(bySource(frames, 'mic'));
    expectContiguous(bySource(frames, 'system'));
    expect(stopped.samples).toEqual({ mic: 32_000, system: 32_000 });
    const types = events.map((e) => e.type).filter((t) => t !== 'level');
    expect(types).toEqual(['started', 'paused', 'resumed', 'stopped']);
    // File clock: no jump across the pause; both events at the pause point (10 frames × 20 ms).
    expect(events.find((e) => e.type === 'paused')?.tUs).toBe(200_000);
    expect(events.find((e) => e.type === 'resumed')?.tUs).toBe(200_000);
  });

  it('realtime mode: the paused time is added to wall time, not to the audio', async () => {
    const source = new FileSource({ input: { stereo: stereoWav(0.6) }, speed: 'realtime' });
    let count = 0;
    let duringPause = 0;
    source.onFrame((f) => {
      if (f.source === 'mic') count++;
      if (source.state === 'paused') duringPause++;
    });
    const t0 = performance.now();
    await source.start();
    await new Promise((r) => setTimeout(r, 200));
    source.pause();
    const atPause = count;
    source.pause(); // no-op
    await new Promise((r) => setTimeout(r, 300));
    expect(count).toBe(atPause);
    source.resume();
    source.resume(); // no-op
    const stopped = await source.whenStopped();
    const elapsed = performance.now() - t0;
    expect(duringPause).toBe(0);
    expect(count).toBe(30);
    expect(stopped.samples.mic).toBe(9600);
    expect(elapsed).toBeGreaterThanOrEqual(880);
    expect(elapsed).toBeLessThan(1250);
  });

  it('stop() mid-stream ends with reason "command" and nothing after `stopped`', async () => {
    const source = new FileSource({ input: { stereo: stereoWav(5) }, speed: 'realtime' });
    const log: string[] = [];
    source.onFrame(() => log.push('frame'));
    source.onEvent((e) => log.push(e.type));
    await source.start();
    await new Promise((r) => setTimeout(r, 100));
    await source.stop();
    await source.stop(); // idempotent
    const stopped = await source.whenStopped();
    expect(stopped.reason).toBe('command');
    expect(log.at(-1)).toBe('stopped');
    expect(log.filter((l) => l === 'frame').length).toBeLessThan(20);
    expect(stopped.samples.mic).toBe(stopped.samples.system);
    await new Promise((r) => setTimeout(r, 50));
    expect(log.at(-1)).toBe('stopped');
  });

  it('stop() from inside a frame listener in fast mode', async () => {
    const run = await play(
      { input: { stereo: stereoWav(2) }, speed: 'fast' },
      {
        onFrame: (f, s) => {
          if (f.tUs === 100_000 && f.source === 'system') void s.stop();
        },
      },
    );
    expect(run.stopped.reason).toBe('command');
    expect(run.stopped.samples).toEqual({ mic: 1920, system: 1920 });
  });

  it('stop() works while paused, and stop() before start() emits nothing', async () => {
    const source = new FileSource({ input: { stereo: stereoWav(1) }, speed: 'realtime' });
    await source.start();
    source.pause();
    await source.stop();
    expect((await source.whenStopped()).reason).toBe('command');

    const idle = new FileSource({ input: { stereo: stereoWav(1) } });
    const events: AudioEvent[] = [];
    idle.onEvent((e) => events.push(e));
    await idle.stop();
    expect(idle.state).toBe('stopped');
    expect((await idle.whenStopped()).reason).toBe('command');
    expect(events).toEqual([]);
    await expect(idle.start()).rejects.toThrow(/cannot start/);
  });

  it('cannot be started twice', async () => {
    const source = new FileSource({ input: { stereo: stereoWav(0.1) }, speed: 'fast' });
    const first = source.start();
    await expect(source.start()).rejects.toThrow(/cannot start/);
    await first;
    await source.whenStopped();
  });
});

describe('FileSource — inputs', () => {
  it('two mono WAVs with different rates and lengths, resampled to 16 kHz', async () => {
    const mic = encodeWav({ sampleRate: 48_000, channels: [tone(48_000, 0.5)] });
    const system = encodeWav({
      sampleRate: 16_000,
      channels: [tone(16_000, 0.3), tone(16_000, 0.3)],
    });
    const run = await play({ input: { mic, system }, speed: 'fast' });
    expect(run.events[0]).toMatchObject({ type: 'started', sources: ['mic', 'system'] });
    expect(run.stopped.samples).toEqual({ mic: 8000, system: 4800 });
    expect(bySource(run.frames, 'system').at(-1)!.tUs).toBe(280_000);
    expect(bySource(run.frames, 'mic').at(-1)!.tUs).toBe(480_000);
    expect(run.frames.every((f) => f.sampleRate === 16_000)).toBe(true);
  });

  it('a single source is fine', async () => {
    const run = await play({
      input: { system: encodeWav({ sampleRate: 16_000, channels: [tone(16_000, 0.1)] }) },
      speed: 'fast',
    });
    expect(run.events[0]).toMatchObject({ sources: ['system'] });
    expect(run.frames.every((f) => f.source === 'system')).toBe(true);
  });

  it('honours frameMs', async () => {
    const run = await play({ input: { stereo: stereoWav(0.5) }, speed: 'fast', frameMs: 50 });
    expect(bySource(run.frames, 'mic').map((f) => f.pcm.length)).toEqual(Array(10).fill(800));
    expect(run.events[0]).toMatchObject({ frameMs: 50 });
  });

  it('rejects a stereo input that is not 2-channel, resolving whenStopped with "error"', async () => {
    const source = new FileSource({
      input: { stereo: encodeWav({ sampleRate: 16_000, channels: [tone(16_000, 0.1)] }) },
    });
    const events: AudioEvent[] = [];
    source.onEvent((e) => events.push(e));
    await expect(source.start()).rejects.toThrow(/2 channels/);
    expect((await source.whenStopped()).reason).toBe('error');
    expect(source.state).toBe('stopped');
    expect(events).toEqual([]);
  });

  it('rejects an empty input and a missing file', async () => {
    await expect(new FileSource({ input: {} }).start()).rejects.toThrow(/mic and\/or system/);
    await expect(
      new FileSource({
        input: { stereo: new URL('./does-not-exist.wav', import.meta.url) },
      }).start(),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe('FileSource — listener errors', () => {
  it('a throwing frame listener is announced as a non-fatal error; the session still completes', async () => {
    const reported: unknown[] = [];
    const source = new FileSource({
      input: { stereo: STANDUP },
      speed: 'fast',
      onListenerError: (e) => reported.push(e),
    });
    const healthy: AudioFrame[] = [];
    const events: AudioEvent[] = [];
    let count = 0;
    source.onFrame(() => {
      if (++count >= 10) throw new Error('meter bug');
    });
    source.onFrame((f) => healthy.push(f));
    source.onEvent((e) => events.push(e));
    await source.start();
    const stopped = await source.whenStopped();

    expect(stopped.reason).toBe('end_of_input');
    const fixture = decodeWav(await readFile(STANDUP));
    expect(healthy.filter((f) => f.source === 'mic').reduce((n, f) => n + f.pcm.length, 0)).toBe(
      fixture.channels[0]!.length,
    );
    expect(reported.length).toBe(healthy.length - 9);
    const announced = events.filter((e) => e.type === 'error');
    // Fast mode plays the whole file well within the 1 s throttle window → exactly one announcement.
    expect(announced).toEqual([
      {
        type: 'error',
        tUs: 100_000,
        source: 'system',
        code: 'listener_error',
        message: 'a frame listener (system) threw: meter bug',
        fatal: false,
      },
    ]);
    expect(events.at(-1)).toEqual(stopped);
  });

  it('a throwing event listener does not recurse or break the session', async () => {
    const reported: unknown[] = [];
    const source = new FileSource({
      input: { stereo: stereoWav(0.5) },
      speed: 'fast',
      onListenerError: (e) => reported.push(e),
    });
    const events: AudioEvent[] = [];
    source.onEvent(() => {
      throw new Error('always');
    });
    source.onEvent((e) => events.push(e));
    await source.start();
    const stopped = await source.whenStopped();
    expect(stopped.reason).toBe('end_of_input');
    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'listener_error', fatal: false });
    expect(errors[0]).not.toHaveProperty('source');
    // started, the listener_error announcement itself, levels, stopped — all reported, none fatal.
    expect(reported.length).toBe(events.length);
    expect(events[0]?.type).toBe('started');
    expect(events.at(-1)).toEqual(stopped);
  });

  it('defaults to console.error', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const source = new FileSource({ input: { stereo: stereoWav(0.1) }, speed: 'fast' });
      source.onFrame(() => {
        throw new Error('x');
      });
      await source.start();
      await source.whenStopped();
      expect(consoleError).toHaveBeenCalledTimes(10);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('FileSource — fan-out', () => {
  it('every subscriber gets the same frames; unsubscribing affects only that subscriber', async () => {
    const source = new FileSource({ input: { stereo: stereoWav(1) }, speed: 'fast' });
    const a: AudioFrame[] = [];
    const b: AudioFrame[] = [];
    source.onFrame((f) => a.push(f));
    const offB = source.onFrame((f) => {
      b.push(f);
      if (b.length === 10) offB();
    });
    const iterated: AudioFrame[] = [];
    const reading = (async () => {
      for await (const f of framesOf(source, { sources: ['mic'] })) {
        iterated.push(f);
        await new Promise((r) => setTimeout(r, 0)); // slow consumer must not slow the source
      }
    })();
    await source.start();
    await source.whenStopped();
    await reading;
    expect(a).toHaveLength(100);
    expect(b).toEqual(a.slice(0, 10));
    expect(iterated).toEqual(a.filter((f) => f.source === 'mic'));
  });
});
