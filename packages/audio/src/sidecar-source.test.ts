/**
 * SidecarSource against a scriptable fake sidecar (`testing/fake-sidecar.ts`, run with this Node): the
 * crash / restart / stop-escalation paths, on any OS. The real Swift binary is covered by
 * `sidecar-source.int.test.ts`.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  captureArgs,
  locateSidecarBinary,
  SidecarError,
  SidecarSource,
  type SidecarSourceOptions,
} from './sidecar-source.ts';
import type { FakeConfig } from './testing/fake-sidecar.ts';
import type { AudioEvent, AudioFrame, AudioSourceKind } from './types.ts';

const FAKE = fileURLToPath(new URL('./testing/fake-sidecar.ts', import.meta.url));
const live: SidecarSource[] = [];

function fake(config: FakeConfig = {}, options: SidecarSourceOptions = {}) {
  const source = new SidecarSource({
    binary: { command: process.execPath, args: [FAKE] },
    env: { ...process.env, FAKE_SIDECAR: JSON.stringify(config) },
    synthetic: true,
    ...options,
  });
  live.push(source);
  const frames: AudioFrame[] = [];
  const events: AudioEvent[] = [];
  const log: (AudioEvent | AudioFrame)[] = [];
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

afterEach(async () => {
  await Promise.all(live.splice(0).map((s) => s.stop().catch(() => undefined)));
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, timeoutMs = 5000) {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('timed out waiting for condition');
    await sleep(10);
  }
}
const bySource = (frames: AudioFrame[], s: AudioSourceKind) => frames.filter((f) => f.source === s);
const types = (events: AudioEvent[]) => events.map((e) => e.type);
function expectStrictlyIncreasing(frames: AudioFrame[]) {
  for (let i = 1; i < frames.length; i++) {
    expect(frames[i]!.tUs).toBeGreaterThan(frames[i - 1]!.tUs);
  }
}
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('SidecarSource (fake sidecar)', () => {
  it('streams typed frames and events, then stops gracefully', async () => {
    const { source, frames, events, log } = fake();
    await source.start();
    expect(source.state).toBe('running');
    expect(source.startedEvent).toMatchObject({ type: 'started', sampleRate: 16_000, protocol: 1 });
    await until(() => frames.length >= 10);
    await source.stop();
    const stopped = await source.whenStopped();

    expect(log[0]).toMatchObject({ type: 'started' });
    expect(log.at(-1)).toMatchObject({ type: 'stopped', reason: 'command' });
    expect(types(events).filter((t) => t === 'started')).toHaveLength(1);
    for (const frame of frames) {
      expect(Object.keys(frame).sort()).toEqual(['pcm', 'sampleRate', 'source', 'tUs']);
      expect(frame.pcm).toBeInstanceOf(Int16Array);
      expect(frame.pcm).toHaveLength(800);
      expect(frame.sampleRate).toBe(16_000);
    }
    for (const s of ['mic', 'system'] as const) {
      const own = bySource(frames, s);
      own.forEach((f, i) => expect(f.tUs).toBe(i * 50_000));
      expect(stopped.samples[s]).toBe(own.length * 800);
    }
    expect(source.state).toBe('stopped');
    expect(source.pid).toBeUndefined();
  });

  it('pause / resume over stdin', async () => {
    const { source, frames, events, log } = fake();
    await source.start();
    await until(() => frames.length >= 4);
    source.pause();
    expect(source.state).toBe('paused');
    await until(() => types(events).includes('paused'));
    await sleep(200);
    source.resume();
    expect(source.state).toBe('running');
    await until(() => types(events).includes('resumed'));
    const resumedAt = log.findIndex((e) => 'type' in e && e.type === 'resumed');
    await until(() => log.length > resumedAt + 4);
    await source.stop();

    const pausedAt = log.findIndex((e) => 'type' in e && e.type === 'paused');
    expect(log.slice(pausedAt, resumedAt).filter((e) => 'pcm' in e)).toEqual([]);
    const mic = bySource(frames, 'mic');
    expectStrictlyIncreasing(mic);
    // The timeline jumps across the pause.
    const before = (
      log.slice(0, pausedAt).filter((e) => 'pcm' in e && e.source === 'mic') as AudioFrame[]
    ).at(-1)!;
    const after = log.slice(resumedAt).find((e) => 'pcm' in e && e.source === 'mic') as AudioFrame;
    expect(after.tUs - before.tUs).toBeGreaterThanOrEqual(150_000);
    // pause()/resume() are no-ops in the wrong state.
    source.resume();
    source.pause();
    expect(source.state).toBe('stopped');
  });

  it('ends with the sidecar’s own stop reason (duration)', async () => {
    const { source, frames } = fake({}, { durationSeconds: 0.3 });
    await source.start();
    const stopped = await source.whenStopped();
    expect(stopped.reason).toBe('duration');
    expect(bySource(frames, 'mic')).toHaveLength(6);
    expect(stopped.samples).toEqual({ mic: 6 * 800, system: 6 * 800 });
  });

  it('captures a single source', async () => {
    const { source, frames } = fake({}, { sources: ['system'], durationSeconds: 0.2 });
    await source.start();
    await source.whenStopped();
    expect(frames.length).toBeGreaterThan(0);
    expect(new Set(frames.map((f) => f.source))).toEqual(new Set(['system']));
  });

  it('a crash without restart policy is a fatal error with the exit status and stderr tail', async () => {
    const { source, events, log } = fake({ crashAfterMs: 200 });
    await source.start();
    const stopped = await source.whenStopped();
    expect(stopped.reason).toBe('error');
    const error = events.find((e) => e.type === 'error');
    expect(error).toMatchObject({ code: 'sidecar_exited', fatal: true });
    expect(error && 'message' in error && error.message).toMatch(
      /exited unexpectedly \(code 3\).*simulated crash/,
    );
    expect(log.at(-1)).toBe(events.at(-1));
    expect(types(events).slice(-2)).toEqual(['error', 'stopped']);
  });

  it('restarts after a crash and keeps the clock continuous and monotonic', async () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'oat-fake-')), 'crashed');
    const { source, frames, events } = fake(
      { crashAfterMs: 300, crashOnceFile: marker },
      { restart: { initialDelayMs: 20 } },
    );
    await source.start();
    const firstPid = source.pid;
    await until(() => source.restarts === 1 && source.pid !== undefined);
    expect(source.pid).not.toBe(firstPid);
    const atRestart = frames.length;
    await until(() => frames.length >= atRestart + 8);
    expect(source.state).toBe('running');
    await source.stop();
    const stopped = await source.whenStopped();

    const error = events.find((e) => e.type === 'error');
    expect(error).toMatchObject({ code: 'sidecar_exited', fatal: false });
    expect(error && 'message' in error && error.message).toMatch(
      /restarting in 20 ms \(attempt 1\/3\)/,
    );
    expect(types(events).filter((t) => t === 'started')).toHaveLength(1);
    expect(stopped.reason).toBe('command');
    for (const s of ['mic', 'system'] as const) {
      const own = bySource(frames, s);
      expectStrictlyIncreasing(own);
      expect(stopped.samples[s]).toBe(own.length * 800);
    }
    // The outage is a forward gap, roughly the wall time it took.
    const mic = bySource(frames, 'mic');
    const gaps = mic.slice(1).map((f, i) => f.tUs - mic[i]!.tUs);
    expect(Math.max(...gaps)).toBeGreaterThan(50_000);
  });

  it('re-applies a pause across a restart without a second `paused` event', async () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'oat-fake-')), 'crashed');
    const { source, events, log } = fake(
      { crashAfterMs: 300, crashOnceFile: marker },
      { restart: { initialDelayMs: 10 } },
    );
    await source.start();
    source.pause();
    await until(() => types(events).includes('paused'));
    await until(() => source.restarts === 1 && source.pid !== undefined);
    await sleep(250);
    const sinceRestart = log.slice(log.findIndex((e) => 'type' in e && e.type === 'error'));
    expect(sinceRestart.filter((e) => 'pcm' in e)).toEqual([]);
    expect(types(events).filter((t) => t === 'paused')).toHaveLength(1);
    const resumeFrom = log.length;
    source.resume();
    await until(
      () => types(events).includes('resumed') && log.slice(resumeFrom).some((e) => 'pcm' in e),
    );
    expect(types(events).filter((t) => t === 'resumed')).toHaveLength(1);
  });

  it('drops audio a sidecar respawned during a pause emits before confirming the pause', async () => {
    // Regression (review 2.4 #1): the fake writes an audio frame right after `started`, before it can read the
    // re-applied pause command — that audio was captured after the user paused and must not be delivered.
    const marker = join(mkdtempSync(join(tmpdir(), 'oat-fake-')), 'crashed');
    const { source, frames, events, log } = fake(
      { crashAfterMs: 300, crashOnceFile: marker, audioRightAfterStarted: true },
      { restart: { initialDelayMs: 10 } },
    );
    await source.start();
    source.pause();
    await until(() => types(events).includes('paused'));
    const pausedAt = log.findIndex((e) => 'type' in e && e.type === 'paused');
    await until(() => source.restarts === 1 && source.pid !== undefined);
    await sleep(200);
    expect(log.slice(pausedAt).filter((e) => 'pcm' in e)).toEqual([]);
    source.resume();
    await until(() => log.slice(-3).some((e) => 'pcm' in e));
    await source.stop();
    const stopped = await source.whenStopped();
    for (const s of ['mic', 'system'] as const) {
      expect(stopped.samples[s]).toBe(bySource(frames, s).length * 800);
    }
  });

  it('gives up after maxRestarts with a fatal error', async () => {
    const { source, events } = fake(
      { crashAfterMs: 50 },
      { restart: { maxRestarts: 2, initialDelayMs: 5 } },
    );
    await source.start();
    const stopped = await source.whenStopped();
    expect(stopped.reason).toBe('error');
    const errors = events.filter((e) => e.type === 'error');
    expect(errors.map((e) => e.fatal)).toEqual([false, false, true]);
    expect(errors.at(-1)).toMatchObject({
      message: expect.stringMatching(/giving up after 2 restarts/),
    });
    expect(source.restarts).toBe(2);
  });

  it('a protocol violation kills the process and is reported', async () => {
    const { source, events } = fake({ garbageAfterMs: 150 });
    await source.start();
    const stopped = await source.whenStopped();
    expect(stopped.reason).toBe('error');
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      code: 'sidecar_protocol_error',
      fatal: true,
      message: expect.stringMatching(/unknown frame kind 7/),
    });
  });

  it('stop escalates to SIGTERM when the sidecar ignores the stop command', async () => {
    const { source, events } = fake(
      { ignoreStop: true },
      { stopTimeoutMs: 150, killTimeoutMs: 2000 },
    );
    await source.start();
    const pid = source.pid!;
    const t0 = Date.now();
    await source.stop();
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(types(events).slice(-2)).toEqual(['error', 'stopped']);
    expect(events.at(-2)).toMatchObject({ code: 'sidecar_stop_timeout', fatal: false });
    expect((await source.whenStopped()).reason).toBe('command');
    expect(isAlive(pid)).toBe(false);
  });

  it('stop escalates to SIGKILL when SIGTERM is ignored too', async () => {
    const { source } = fake(
      { ignoreStop: true, ignoreTerm: true },
      { stopTimeoutMs: 100, killTimeoutMs: 100 },
    );
    await source.start();
    const pid = source.pid!;
    await source.stop();
    expect((await source.whenStopped()).reason).toBe('command');
    expect(isAlive(pid)).toBe(false);
  });

  it('rejects start for an incompatible protocol', async () => {
    const { source, events } = fake({ protocol: 2 });
    await expect(source.start()).rejects.toThrow(/speaks protocol 2/);
    expect(source.state).toBe('stopped');
    expect((await source.whenStopped()).reason).toBe('error');
    expect(events).toEqual([]);
  });

  it('rejects start when `started` reports another protocol (version check skipped)', async () => {
    const { source } = fake({ protocol: 2 }, { checkVersion: false });
    await expect(source.start()).rejects.toThrow(/unsupported protocol 2/);
  });

  it('rejects start when the sidecar exits first, with its stderr', async () => {
    const { source } = fake({ exitBeforeStart: true });
    await expect(source.start()).rejects.toThrow(
      /exited before starting \(code 2\).*refusing to start/,
    );
  });

  it('waits for a working device and delivers startup warnings after started', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oat-sidecar-'));
    const readyFile = join(dir, 'ready');
    let opening = false;
    const { source, events, frames } = fake(
      { captureReadyFile: readyFile },
      { onStderr: () => (opening = true) },
    );
    const starting = source.start();
    await until(() => opening);
    expect(source.state).toBe('idle');
    expect(events).toEqual([]);
    writeFileSync(readyFile, '');
    await starting;
    expect(source.state).toBe('running');
    expect(types(events).slice(0, 2)).toEqual(['started', 'error']);
    expect(events[1]).toMatchObject({ code: 'aec_unavailable', fatal: false });
    await until(() => frames.length > 0);
  });

  it('rejects startup with the native error when no device opens', async () => {
    const { source, events } = fake({ failToOpen: true });
    await expect(source.start()).rejects.toThrow(/mic_start_failed: simulated microphone/);
    expect(events).toEqual([]);
    expect((await source.whenStopped()).reason).toBe('error');
  });

  it('cancels startup after the protocol handshake while waiting for a device', async () => {
    let opening = false;
    const { source, events } = fake(
      { captureReadyFile: join(mkdtempSync(join(tmpdir(), 'oat-sidecar-')), 'ready') },
      { onStderr: () => (opening = true) },
    );
    const starting = source.start();
    await until(() => opening);
    await source.stop();
    await starting;
    expect(events).toEqual([]);
    expect((await source.whenStopped()).reason).toBe('command');
  });

  it('rejects start when no `started` frame arrives in time', async () => {
    const { source } = fake({ noStarted: true }, { startTimeoutMs: 200 });
    await expect(source.start()).rejects.toThrow(/no `started` frame within 200 ms/);
    expect(source.state).toBe('stopped');
  });

  it('rejects start when the binary does not exist', async () => {
    const source = new SidecarSource({ binary: '/nonexistent/oat-audio', checkVersion: false });
    await expect(source.start()).rejects.toThrow(/could not run oat-audio.*ENOENT/);
    expect((await source.whenStopped()).reason).toBe('error');
  });

  it('stop before start / twice is fine; start twice is not', async () => {
    const idle = new SidecarSource({ binary: '/nonexistent' });
    await idle.stop();
    await idle.stop();
    expect(idle.state).toBe('stopped');
    await expect(idle.start()).rejects.toThrow(/cannot start/);

    const { source } = fake();
    const starting = source.start();
    await expect(source.start()).rejects.toThrow(/cannot start/);
    await starting;
    await source.stop();
    await source.stop();
  });

  it('stop() right after start() never spawns; start resolves', async () => {
    const { source, events } = fake();
    const starting = source.start();
    const stopping = source.stop();
    await starting;
    await stopping;
    expect(events).toEqual([]);
    expect((await source.whenStopped()).reason).toBe('command');
  });

  it('stop() while the sidecar is still starting terminates it without waiting for the start timeout', async () => {
    const { source, events } = fake({ noStarted: true }, { startTimeoutMs: 10_000 });
    const starting = source.start();
    await until(() => source.pid !== undefined);
    const pid = source.pid!;
    const t0 = Date.now();
    await Promise.all([source.stop(), source.stop()]); // concurrent stops share one
    await starting; // resolves: stopping is not a start failure
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(events).toEqual([]);
    expect((await source.whenStopped()).reason).toBe('command');
    expect(isAlive(pid)).toBe(false);
  });

  it('concurrent stop() calls escalate once', async () => {
    const { source, events } = fake({ ignoreStop: true }, { stopTimeoutMs: 100 });
    await source.start();
    await Promise.all([source.stop(), source.stop(), source.stop()]);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'stopped', reason: 'command' });
  });

  it('with durationSeconds, a restarted sidecar only captures the remainder', async () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'oat-fake-')), 'crashed');
    const { source, frames } = fake(
      { crashAfterMs: 300, crashOnceFile: marker },
      { restart: { initialDelayMs: 10 }, durationSeconds: 0.6 },
    );
    await source.start();
    const stopped = await source.whenStopped();
    expect(stopped.reason).toBe('duration');
    expect(source.restarts).toBe(1);
    const micS = bySource(frames, 'mic').length * 0.05;
    expect(micS).toBeGreaterThanOrEqual(0.55);
    expect(micS).toBeLessThanOrEqual(0.65);
  });

  it('a throwing listener does not break the session', async () => {
    const errors: unknown[] = [];
    const { source, events } = fake({}, { onListenerError: (e) => errors.push(e) });
    source.onFrame(() => {
      throw new Error('bad consumer');
    });
    await source.start();
    await until(() => events.some((e) => e.type === 'error'));
    await source.stop();
    expect(errors.length).toBeGreaterThan(0);
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      code: 'listener_error',
      fatal: false,
    });
    expect(events.at(-1)?.type).toBe('stopped');
  });

  it('forwards stderr lines', async () => {
    const lines: string[] = [];
    const { source } = fake({ crashAfterMs: 100 }, { onStderr: (l) => lines.push(l) });
    await source.start();
    await source.whenStopped();
    expect(lines).toContain('fake-sidecar: simulated crash');
  });
});

describe('locateSidecarBinary / captureArgs', () => {
  it('prefers OAT_AUDIO_BIN and refuses a missing one', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'oat-bin-')), 'oat-audio');
    writeFileSync(file, '');
    expect(locateSidecarBinary({ env: { OAT_AUDIO_BIN: file } })).toBe(file);
    expect(() => locateSidecarBinary({ env: { OAT_AUDIO_BIN: `${file}-missing` } })).toThrow(
      SidecarError,
    );
  });

  it('falls back to a packaged resources dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oat-res-'));
    writeFileSync(join(dir, 'oat-audio'), '');
    expect(locateSidecarBinary({ env: {}, resourcesPath: dir })).toBe(join(dir, 'oat-audio'));
  });

  it('builds capture arguments', () => {
    expect(captureArgs({})).toEqual(['capture', '--sample-rate', '16000']);
    expect(
      captureArgs({
        sources: ['mic'],
        sampleRate: 24_000,
        frameMs: 20,
        synthetic: true,
        aec: false,
        durationSeconds: 2,
        excludePids: [42, 43],
      }),
    ).toEqual([
      'capture',
      '--mic',
      '--sample-rate',
      '24000',
      '--frame-ms',
      '20',
      '--synthetic',
      '--no-aec',
      '--duration',
      '2',
      '--exclude-pid',
      '42',
      '--exclude-pid',
      '43',
    ]);
    expect(() => captureArgs({ sources: [] })).toThrow(RangeError);
  });
});
