import { describe, expect, it, vi } from 'vitest';

import { FileSource } from './file-source.ts';
import {
  RecordingController,
  RecordingStateError,
  type RecordingError,
  type RecordingState,
} from './recording-controller.ts';
import type {
  AudioEvent,
  AudioEventOf,
  AudioFrame,
  AudioSource,
  AudioSourceState,
  AudioStopReason,
  Unsubscribe,
} from './types.ts';
import { encodeWav } from './wav.ts';

function stereoWav(seconds: number, rate = 16_000): Uint8Array {
  const tone = (freq: number) =>
    Int16Array.from({ length: Math.round(rate * seconds) }, (_, i) =>
      Math.round(8000 * Math.sin((2 * Math.PI * freq * i) / rate)),
    );
  return encodeWav({ sampleRate: rate, channels: [tone(300), tone(700)] });
}

/** Hand-driven AudioSource for the paths a file cannot produce (start failure, crash, errors). */
class StubSource implements AudioSource {
  readonly sampleRate = 16_000;
  state: AudioSourceState = 'idle';
  failStart: Error | undefined;
  readonly calls: string[] = [];
  #frames = new Set<(f: AudioFrame) => void>();
  #events = new Set<(e: AudioEvent) => void>();
  #resolve!: (e: AudioEventOf<'stopped'>) => void;
  readonly #stopped = new Promise<AudioEventOf<'stopped'>>((r) => (this.#resolve = r));

  async start() {
    this.calls.push('start');
    if (this.failStart) {
      this.finish('error', false);
      throw this.failStart;
    }
    this.state = 'running';
    this.emit({
      type: 'started',
      tUs: 0,
      sampleRate: 16_000,
      frameMs: 50,
      sources: ['mic', 'system'],
    });
  }
  async stop() {
    this.calls.push('stop');
    this.finish('command');
  }
  pause() {
    this.calls.push('pause');
    this.state = 'paused';
  }
  resume() {
    this.calls.push('resume');
    this.state = 'running';
  }
  onFrame(l: (f: AudioFrame) => void): Unsubscribe {
    this.#frames.add(l);
    return () => this.#frames.delete(l);
  }
  onEvent(l: (e: AudioEvent) => void): Unsubscribe {
    this.#events.add(l);
    return () => this.#events.delete(l);
  }
  whenStopped() {
    return this.#stopped;
  }
  emit(e: AudioEvent) {
    for (const l of this.#events) l(e);
  }
  frame(tUs: number, source: 'mic' | 'system' = 'mic') {
    const f: AudioFrame = { source, tUs, pcm: new Int16Array(800), sampleRate: 16_000 };
    for (const l of this.#frames) l(f);
  }
  finish(reason: AudioStopReason, emit = true) {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    const e: AudioEventOf<'stopped'> = {
      type: 'stopped',
      tUs: 1,
      reason,
      samples: { mic: 0, system: 0 },
    };
    if (emit) this.emit(e);
    this.#resolve(e);
  }
}

function withStub(now?: () => number) {
  const sources: StubSource[] = [];
  const controller = new RecordingController({
    createSource: () => {
      const s = new StubSource();
      sources.push(s);
      return s;
    },
    ...(now ? { now } : {}),
  });
  const states: RecordingState[] = [];
  const errors: RecordingError[] = [];
  controller.onStateChange((c) => states.push(c.to));
  controller.onError((e) => errors.push(e));
  return { controller, sources, states, errors, current: () => sources.at(-1)! };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('RecordingController — state machine', () => {
  it('idle → starting → recording ⇄ paused → stopping → idle', async () => {
    const { controller, states, current } = withStub();
    expect(controller.state).toBe('idle');
    await controller.start();
    expect(controller.state).toBe('recording');
    controller.pause();
    controller.resume();
    controller.pause();
    const stopped = await controller.stop();
    expect(stopped?.reason).toBe('command');
    expect(states).toEqual([
      'starting',
      'recording',
      'paused',
      'recording',
      'paused',
      'stopping',
      'idle',
    ]);
    expect(current().calls).toEqual(['start', 'pause', 'resume', 'pause', 'stop']);
    expect(controller.lastStop).toBe(stopped);
  });

  it.each<[string, (c: RecordingController) => unknown, RecordingState]>([
    ['pause while idle', (c) => c.pause(), 'idle'],
    ['resume while idle', (c) => c.resume(), 'idle'],
    ['stop while idle', (c) => c.stop(), 'idle'],
  ])('rejects %s', async (_name, command, state) => {
    const { controller, states } = withStub();
    await expect(async () => command(controller)).rejects.toThrow(RecordingStateError);
    expect(controller.state).toBe(state);
    expect(states).toEqual([]);
  });

  it('guards transitions while recording / paused', async () => {
    const { controller } = withStub();
    await controller.start();
    await expect(controller.start()).rejects.toThrow('cannot start while recording');
    expect(() => controller.resume()).toThrow('cannot resume while recording');
    controller.pause();
    expect(() => controller.pause()).toThrow('cannot pause while paused');
    await expect(controller.start()).rejects.toThrow(RecordingStateError);
    expect(controller.state).toBe('paused');
  });

  it('a start failure enters `error`; start() can retry with a fresh source; stop() acknowledges', async () => {
    const { controller, sources, states, errors } = withStub();
    const failing = new StubSource();
    failing.failStart = new Error('no binary');
    const c2 = new RecordingController({ createSource: () => failing });
    const c2States: RecordingState[] = [];
    c2.onStateChange((c) => c2States.push(c.to));
    await expect(c2.start()).rejects.toThrow('no binary');
    expect(c2.state).toBe('error');
    expect(c2.lastError).toMatchObject({ code: 'start_failed', fatal: true });
    expect(c2States).toEqual(['starting', 'error']);
    expect(await c2.stop()).toBeUndefined();
    expect(c2.state).toBe('idle');

    // Retry from error with a fresh source.
    await controller.start();
    sources[0]!.finish('error');
    await tick();
    expect(controller.state).toBe('error');
    await controller.start();
    expect(sources).toHaveLength(2);
    expect(controller.state).toBe('recording');
    expect(states).toEqual(['starting', 'recording', 'error', 'starting', 'recording']);
    expect(errors[0]).toMatchObject({ code: 'unexpected_stop', fatal: true });
  });

  it.each<[AudioStopReason, RecordingState]>([
    ['error', 'error'],
    ['signal', 'error'],
    ['output_closed', 'error'],
    ['duration', 'idle'],
    ['end_of_input', 'idle'],
  ])('source stopping by itself with %s → %s', async (reason, expected) => {
    const { controller, current, errors } = withStub();
    await controller.start();
    current().finish(reason);
    await tick();
    expect(controller.state).toBe(expected);
    expect(errors.length > 0).toBe(expected === 'error');
    if (expected === 'error') expect(controller.lastError?.message).toContain(reason);
  });

  it('surfaces non-fatal source errors without leaving `recording`; forwards levels and events', async () => {
    const { controller, current, errors } = withStub();
    const levels: AudioEvent[] = [];
    const events: AudioEvent[] = [];
    controller.onLevel((l) => levels.push(l));
    controller.onEvent((e) => events.push(e));
    await controller.start();
    current().emit({
      type: 'error',
      tUs: 5,
      code: 'sidecar_exited',
      message: 'restarting',
      fatal: false,
    });
    current().emit({
      type: 'error',
      tUs: 6,
      source: 'system',
      code: 'device_lost',
      message: 'gone',
      fatal: true,
    });
    current().emit({ type: 'level', tUs: 7, source: 'mic', rmsDb: -20, peakDb: -3 });
    expect(controller.state).toBe('recording');
    expect(errors).toEqual([
      { code: 'sidecar_exited', message: 'restarting', fatal: false, tUs: 5 },
      { code: 'device_lost', message: 'gone', fatal: true, tUs: 6, source: 'system' },
    ]);
    expect(levels).toEqual([{ type: 'level', tUs: 7, source: 'mic', rmsDb: -20, peakDb: -3 }]);
    expect(events.map((e) => e.type)).toEqual(['started', 'error', 'error', 'level']);
  });

  it('tracks elapsed recording time, excluding pauses', async () => {
    let t = 1000;
    const { controller } = withStub(() => t);
    expect(controller.elapsedMs).toBe(0);
    await controller.start();
    t += 500;
    expect(controller.elapsedMs).toBe(500);
    controller.pause();
    t += 10_000;
    expect(controller.elapsedMs).toBe(500);
    controller.resume();
    t += 250;
    expect(controller.elapsedMs).toBe(750);
    await controller.stop();
    t += 99;
    expect(controller.elapsedMs).toBe(750);
    await controller.start();
    expect(controller.elapsedMs).toBe(0);
  });

  it('ignores events from a previous recording’s source', async () => {
    const { controller, sources, errors } = withStub();
    await controller.start();
    await controller.stop();
    await controller.start();
    sources[0]!.emit({ type: 'error', tUs: 1, code: 'x', message: 'stale', fatal: true });
    expect(errors).toEqual([]);
  });
});

describe('RecordingController — frame fan-out', () => {
  it('delivers every frame to each subscriber in order (FileSource)', async () => {
    const controller = new RecordingController({
      createSource: () =>
        new FileSource({ input: { stereo: stereoWav(1) }, speed: 'fast', frameMs: 20 }),
    });
    const a: AudioFrame[] = [];
    const micOnly: AudioFrame[] = [];
    const subA = controller.subscribe((f) => void a.push(f));
    const subMic = controller.subscribe((f) => void micOnly.push(f), { sources: ['mic'] });
    await controller.start();
    await (controller.source as FileSource).whenStopped();
    await Promise.all([subA.drained(), subMic.drained()]);
    expect(controller.state).toBe('idle'); // end_of_input
    expect(a).toHaveLength(100);
    expect(micOnly).toHaveLength(50);
    expect(micOnly.every((f) => f.source === 'mic')).toBe(true);
    expect(subA.stats).toMatchObject({ delivered: 100, dropped: 0, queued: 0 });
  });

  it('a slow subscriber drops its own oldest frames and never delays the others', async () => {
    const controller = new RecordingController({
      createSource: () =>
        new FileSource({ input: { stereo: stereoWav(2) }, speed: 'fast', frameMs: 20 }),
    });
    const fast: { frame: AudioFrame; at: number }[] = [];
    const slowSeen: AudioFrame[] = [];
    const overruns: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = controller.subscribe(
      async (f) => {
        slowSeen.push(f);
        await gate; // stuck until the recording is over
      },
      { maxQueuedFrames: 10, onOverrun: (o) => overruns.push(o.droppedSamples), name: 'archive' },
    );
    const quick = controller.subscribe((f) => void fast.push({ frame: f, at: performance.now() }));

    await controller.start();
    await (controller.source as FileSource).whenStopped();
    await quick.drained();
    // The fast subscriber got every frame, in order, while the slow one was stuck.
    expect(fast).toHaveLength(200);
    expect(fast.map((x) => x.frame.tUs)).toEqual(
      [...fast.map((x) => x.frame.tUs)].sort((x, y) => x - y),
    );
    expect(slowSeen).toHaveLength(1);
    expect(slow.stats.queued).toBe(10);
    expect(slow.stats.dropped).toBe(200 - 1 - 10);
    expect(slow.stats.droppedSamples.mic + slow.stats.droppedSamples.system).toBe(189 * 320);
    expect(overruns).toHaveLength(189);

    release();
    await slow.drained();
    expect(slow.stats).toMatchObject({ delivered: 11, queued: 0 });
    // What the slow subscriber did get is the first frame and the newest 10.
    expect(slowSeen.slice(1).map((f) => f.tUs)).toEqual(fast.slice(-10).map((x) => x.frame.tUs));
  });

  it('a throwing subscriber is reported and keeps receiving', async () => {
    const { controller, current, errors } = withStub();
    let calls = 0;
    controller.subscribe(
      () => {
        calls++;
        throw new Error('disk full');
      },
      { name: 'archive' },
    );
    const ok: number[] = [];
    const okSub = controller.subscribe((f) => void ok.push(f.tUs));
    await controller.start();
    current().frame(0);
    current().frame(50_000);
    await okSub.drained();
    await tick();
    expect(calls).toBe(2);
    expect(ok).toEqual([0, 50_000]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({
      code: 'subscriber_error',
      fatal: false,
      message: 'frame subscriber "archive" threw: disk full',
    });
    expect(controller.state).toBe('recording');
  });

  it('unsubscribe stops delivery and clears the queue', async () => {
    const { controller, current } = withStub();
    const got: number[] = [];
    const sub = controller.subscribe((f) => void got.push(f.tUs));
    await controller.start();
    current().frame(1);
    sub.unsubscribe();
    current().frame(2);
    await tick();
    expect(got).toEqual([]);
    expect(sub.stats.queued).toBe(0);
  });

  it('validates maxQueuedFrames', () => {
    const { controller } = withStub();
    expect(() => controller.subscribe(vi.fn(), { maxQueuedFrames: 0 })).toThrow(RangeError);
  });
});
