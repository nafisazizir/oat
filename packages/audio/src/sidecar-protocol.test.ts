import { describe, expect, it } from 'vitest';

import {
  decodePcm,
  encodeFrame,
  FrameParser,
  HEADER_SIZE,
  KIND,
  ProtocolError,
  SOURCE,
  toAudioEvent,
  toAudioFrame,
  validateFrames,
  type RawFrame,
} from './sidecar-protocol.ts';

/** The reference implementation (`check-frames.mjs`) is the contract; loaded untyped. */
const REFERENCE = new URL('../../../native/oat-audio/scripts/check-frames.mjs', import.meta.url);
interface Reference {
  HEADER_SIZE: number;
  KIND: Record<string, number>;
  SOURCE: Record<string, number>;
  FrameParser: new () => { push(chunk: Uint8Array): unknown[]; pending: number };
  validateFrames(frames: unknown[], opts?: object): { errors: string[]; summary: unknown };
}
const reference = async () => (await import(REFERENCE.href)) as Reference;

const ev = (tUs: number, payload: Record<string, unknown>, source: number = SOURCE.NONE) =>
  encodeFrame(KIND.EVENT, source, tUs, payload);
const audio = (source: number, tUs: number, samples = 800, value = 1000) =>
  encodeFrame(KIND.AUDIO, source, tUs, new Int16Array(samples).fill(value));
const started = (extra: Record<string, unknown> = {}) =>
  ev(0, {
    type: 'started',
    protocol: 1,
    version: '0.1.0',
    sample_rate: 16_000,
    frame_ms: 50,
    sources: ['mic', 'system'],
    synthetic: true,
    aec: false,
    ...extra,
  });
const stopped = (tUs: number, reason = 'command', mic = 1600, system = 1600) =>
  ev(tUs, { type: 'stopped', reason, samples: { mic, system } });

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** A valid 100 ms capture: started, 2 frames per source, a level, an overrun, stopped. */
function validStream(): Uint8Array {
  return concat([
    started(),
    audio(SOURCE.MIC, 1_000, 800, -1234),
    audio(SOURCE.SYSTEM, 1_100, 800, 2222),
    ev(1_200, { type: 'level', source: 'mic', rms_db: -20.5, peak_db: -6, extra: 'ignored' }, 0),
    audio(SOURCE.MIC, 51_000),
    ev(
      51_050,
      { type: 'overrun', source: 'system', stage: 'output', dropped_samples: 800, dropped_ms: 50 },
      1,
    ),
    audio(SOURCE.SYSTEM, 101_100),
    ev(120_000, { type: 'some_future_event', x: 1 }),
    stopped(130_000),
  ]);
}

function parseInChunks(bytes: Uint8Array, size: number): { frames: RawFrame[]; pending: number } {
  const parser = new FrameParser();
  const frames: RawFrame[] = [];
  for (let off = 0; off < bytes.length; off += size)
    frames.push(...parser.push(bytes.subarray(off, off + size)));
  return { frames, pending: parser.pending };
}

describe('FrameParser', () => {
  it('parses a stream identically for any chunking', () => {
    const bytes = validStream();
    const whole = parseInChunks(bytes, bytes.length);
    expect(whole.frames).toHaveLength(9);
    expect(whole.pending).toBe(0);
    for (const size of [1, 2, 3, 7, 13, 14, 15, 100, 1613, 4096]) {
      const chunked = parseInChunks(bytes, size);
      expect(chunked.pending).toBe(0);
      expect(chunked.frames).toEqual(whole.frames);
    }
  });

  it('handles a split at every byte position', () => {
    const bytes = concat([started(), audio(SOURCE.MIC, 1, 3), stopped(2)]);
    const whole = parseInChunks(bytes, bytes.length).frames;
    for (let cut = 1; cut < bytes.length; cut++) {
      const parser = new FrameParser();
      const frames = [...parser.push(bytes.subarray(0, cut)), ...parser.push(bytes.subarray(cut))];
      expect(frames).toEqual(whole);
    }
  });

  it('decodes header fields and payloads', () => {
    const [s, mic, sys, level] = parseInChunks(validStream(), 64).frames;
    expect(s).toMatchObject({ kind: 2, source: 255, sourceName: 'none', tUs: 0n });
    expect(s?.event).toMatchObject({ type: 'started', protocol: 1 });
    expect(mic).toMatchObject({ kind: 1, source: 0, sourceName: 'mic', tUs: 1000n });
    expect(mic?.payload).toHaveLength(1600);
    expect(decodePcm(mic!.payload)[0]).toBe(-1234);
    expect(sys?.sourceName).toBe('system');
    expect(level?.event).toMatchObject({ type: 'level', rms_db: -20.5 });
  });

  it('frames never alias the input chunk (Node Buffer pools)', () => {
    const bytes = Buffer.from(concat([started(), audio(SOURCE.MIC, 5, 4, 7)]));
    const frames = new FrameParser().push(bytes);
    bytes.fill(0);
    expect(decodePcm(frames[1]!.payload)).toEqual(new Int16Array([7, 7, 7, 7]));
  });

  it.each([3, 10, 14, 20, 21])(
    'a pending tail never aliases the caller’s buffer (reused after %i bytes)',
    (cut) => {
      // The caller reuses one buffer for every read, like a stream with a fixed read buffer.
      const stream = concat([audio(SOURCE.MIC, 5, 4, 7), stopped(9)]);
      const reused = new Uint8Array(stream.length);
      const parser = new FrameParser();
      reused.set(stream.subarray(0, cut));
      const first = parser.push(reused.subarray(0, cut));
      reused.fill(0xee); // overwritten before the next push
      reused.set(stream.subarray(cut));
      const rest = parser.push(reused.subarray(0, stream.length - cut));
      const frames = [...first, ...rest];
      expect(frames.map((f) => f.kind)).toEqual([KIND.AUDIO, KIND.EVENT]);
      expect(decodePcm(frames[0]!.payload)).toEqual(new Int16Array([7, 7, 7, 7]));
      expect(parser.pending).toBe(0);
    },
  );

  it('a pending tail survives the caller overwriting each chunk across several pushes', () => {
    const stream = concat([started(), audio(SOURCE.SYSTEM, 5, 2000, -3)]);
    const parser = new FrameParser();
    const scratch = new Uint8Array(37);
    const frames: RawFrame[] = [];
    for (let off = 0; off < stream.length; off += scratch.length) {
      const n = Math.min(scratch.length, stream.length - off);
      scratch.set(stream.subarray(off, off + n));
      frames.push(...parser.push(scratch.subarray(0, n)));
      scratch.fill(0xff);
    }
    expect(frames).toEqual(parseInChunks(stream, stream.length).frames);
  });

  it('a large payload in many small chunks is assembled once (no quadratic copying)', () => {
    const big = audio(SOURCE.MIC, 5, 1 << 20, 11); // 2 MiB payload
    const parser = new FrameParser();
    const t0 = performance.now();
    const frames: RawFrame[] = [];
    for (let off = 0; off < big.length; off += 1024)
      frames.push(...parser.push(big.subarray(off, off + 1024)));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload.length).toBe(2 << 20);
    expect(decodePcm(frames[0]!.payload)[123_456]).toBe(11);
    // Quadratic joining would copy ~2 GiB here (seconds); linear is a few ms.
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('keeps a truncated frame pending', () => {
    const bytes = concat([started(), audio(SOURCE.MIC, 5)]);
    const parser = new FrameParser();
    expect(parser.push(bytes.subarray(0, bytes.length - 1))).toHaveLength(1);
    expect(parser.pending).toBe(HEADER_SIZE + 1600 - 1);
    const truncatedHeader = new FrameParser();
    expect(truncatedHeader.push(audio(SOURCE.MIC, 5).subarray(0, 10))).toEqual([]);
    expect(truncatedHeader.pending).toBe(10);
  });

  it.each([
    [
      'bad kind',
      encodeFrame(9 as 1, SOURCE.NONE, 0, new Uint8Array()),
      /unknown frame kind 9 at byte \d+/,
    ],
    ['bad source', encodeFrame(KIND.AUDIO, 7, 0, new Uint8Array(2)), /unknown source 7/],
    [
      'non-JSON event',
      encodeFrame(KIND.EVENT, SOURCE.NONE, 0, new TextEncoder().encode('{nope')),
      /not JSON/,
    ],
  ])('rejects %s', (_name, frame, message) => {
    const parser = new FrameParser();
    expect(() => parser.push(concat([started(), frame]))).toThrow(message);
    // A failed parser stays failed: the stream position is lost.
    expect(() => parser.push(started())).toThrow(ProtocolError);
  });

  it('rejects an oversized payload from the header alone', () => {
    const header = encodeFrame(KIND.AUDIO, SOURCE.MIC, 0, new Uint8Array()).slice(0, HEADER_SIZE);
    new DataView(header.buffer).setUint32(10, 16 * 1024 * 1024 + 1, true);
    expect(() => new FrameParser().push(header)).toThrow(/payload too large/);
  });

  it('reports the absolute byte offset of a bad frame across chunks', () => {
    const good = started();
    const parser = new FrameParser();
    parser.push(good);
    expect(() => parser.push(encodeFrame(3 as 1, 0, 0, new Uint8Array()))).toThrow(
      `unknown frame kind 3 at byte ${good.length}`,
    );
  });
});

describe('typed mapping', () => {
  const frames = parseInChunks(validStream(), 1 << 20).frames;

  it('maps audio frames to AudioFrame (with a clock offset)', () => {
    const frame = toAudioFrame(frames[1]!, 16_000, 5_000_000);
    expect(frame).toEqual({
      source: 'mic',
      tUs: 5_001_000,
      pcm: expect.any(Int16Array),
      sampleRate: 16_000,
    });
    expect(frame.pcm).toHaveLength(800);
    expect(frame.pcm[799]).toBe(-1234);
    expect(() => toAudioFrame(frames[0]!, 16_000)).toThrow(ProtocolError);
    const odd = new FrameParser().push(
      encodeFrame(KIND.AUDIO, SOURCE.MIC, 0, new Uint8Array(3)),
    )[0]!;
    expect(() => toAudioFrame(odd, 16_000)).toThrow(/odd audio payload/);
  });

  it('maps every protocol event to the camelCase AudioEvent', () => {
    expect(toAudioEvent(frames[0]!)).toEqual({
      type: 'started',
      tUs: 0,
      sampleRate: 16_000,
      frameMs: 50,
      sources: ['mic', 'system'],
      protocol: 1,
      version: '0.1.0',
      synthetic: true,
      aec: false,
    });
    expect(toAudioEvent(frames[3]!, 10)).toEqual({
      type: 'level',
      tUs: 1_210,
      source: 'mic',
      rmsDb: -20.5,
      peakDb: -6,
    });
    expect(toAudioEvent(frames[5]!)).toEqual({
      type: 'overrun',
      tUs: 51_050,
      source: 'system',
      stage: 'output',
      droppedSamples: 800,
      droppedMs: 50,
    });
    expect(toAudioEvent(frames[7]!)).toBeUndefined(); // unknown type: ignored
    expect(toAudioEvent(frames[8]!)).toEqual({
      type: 'stopped',
      tUs: 130_000,
      reason: 'command',
      samples: { mic: 1600, system: 1600 },
    });
    const one = (bytes: Uint8Array) => toAudioEvent(new FrameParser().push(bytes)[0]!);
    expect(one(ev(1, { type: 'paused' }))).toEqual({ type: 'paused', tUs: 1 });
    expect(one(ev(2, { type: 'resumed' }))).toEqual({ type: 'resumed', tUs: 2 });
    expect(
      one(
        ev(
          3,
          { type: 'error', code: 'device_lost', message: 'gone', fatal: true, source: 'mic' },
          0,
        ),
      ),
    ).toEqual({
      type: 'error',
      tUs: 3,
      source: 'mic',
      code: 'device_lost',
      message: 'gone',
      fatal: true,
    });
    expect(
      one(ev(4, { type: 'error', code: 'invalid_command', message: 'bad', fatal: false })),
    ).toEqual({
      type: 'error',
      tUs: 4,
      code: 'invalid_command',
      message: 'bad',
      fatal: false,
    });
    expect(one(ev(5, { type: 'device_changed', source: 'system', device: 'AirPods' }, 1))).toEqual({
      type: 'device_changed',
      tUs: 5,
      source: 'system',
      device: 'AirPods',
    });
    expect(
      one(
        ev(
          6,
          {
            type: 'format_changed',
            source: 'mic',
            device_sample_rate: 16_000,
            previous_device_sample_rate: 48_000,
            channels: 1,
          },
          0,
        ),
      ),
    ).toEqual({
      type: 'format_changed',
      tUs: 6,
      source: 'mic',
      deviceSampleRate: 16_000,
      previousDeviceSampleRate: 48_000,
      channels: 1,
    });
    // A per-source event without any source is not understood → ignored.
    expect(one(ev(7, { type: 'level', rms_db: 0, peak_db: 0 }))).toBeUndefined();
  });
});

describe('validateFrames ↔ check-frames.mjs (the contract)', () => {
  it('uses the same wire constants', async () => {
    const ref = await reference();
    expect(ref.HEADER_SIZE).toBe(HEADER_SIZE);
    expect({ ...ref.KIND }).toEqual({ ...KIND });
    expect({ ...ref.SOURCE }).toEqual({ ...SOURCE });
  });

  const cases: [string, Uint8Array, object][] = [
    ['valid capture', validStream(), {}],
    ['valid capture with expectations', validStream(), { expectSeconds: 0.1, maxSeconds: 0.1 }],
    ['short audio vs expectSeconds', validStream(), { expectSeconds: 1 }],
    ['missing stopped', concat([started(), audio(SOURCE.MIC, 1)]), {}],
    ['not starting with started', concat([audio(SOURCE.MIC, 1), started(), stopped(9)]), {}],
    [
      'non-monotonic, odd, oversized, unexpected source, bad protocol',
      concat([
        started({ protocol: 2, sources: ['mic'] }),
        audio(SOURCE.MIC, 50),
        audio(SOURCE.MIC, 50),
        encodeFrame(KIND.AUDIO, SOURCE.MIC, 60, new Uint8Array(3)),
        audio(SOURCE.MIC, 70, 900),
        audio(SOURCE.SYSTEM, 80),
        encodeFrame(KIND.AUDIO, SOURCE.NONE, 90, new Uint8Array(2)),
        ev(91, { type: 'overrun', stage: 'weird' }),
        ev(92, { type: 'format_changed' }),
        ev(93, { nottype: true }),
        stopped(100),
        stopped(101),
      ]),
      {},
    ],
  ];

  it.each(cases)('%s: same errors and summary', async (_name, bytes, opts) => {
    const ref = await reference();
    const refParser = new ref.FrameParser();
    const refFrames = refParser.push(bytes);
    const ours = new FrameParser();
    const ourFrames = ours.push(bytes);
    expect(ours.pending).toBe(refParser.pending);
    const expected = ref.validateFrames(refFrames, { ...opts, trailingBytes: refParser.pending });
    const actual = validateFrames(ourFrames, { ...opts, trailingBytes: ours.pending });
    expect(actual).toEqual(expected);
  });

  it('valid capture has no errors', () => {
    const { errors, summary } = validateFrames(parseInChunks(validStream(), 99).frames);
    expect(errors).toEqual([]);
    expect(summary.sources.system?.droppedSamples).toBe(800);
    expect(summary.stopReason).toBe('command');
  });

  it('reports trailing bytes like the reference', async () => {
    const ref = await reference();
    const bytes = concat([validStream(), audio(SOURCE.MIC, 200_000).subarray(0, 20)]);
    const refParser = new ref.FrameParser();
    const refFrames = refParser.push(bytes);
    const ours = new FrameParser();
    const ourFrames = ours.push(bytes);
    expect(validateFrames(ourFrames, { trailingBytes: ours.pending })).toEqual(
      ref.validateFrames(refFrames, { trailingBytes: refParser.pending }),
    );
    expect(ours.pending).toBe(20);
  });

  it('throws the same messages as the reference for malformed streams', async () => {
    const ref = await reference();
    for (const bad of [
      concat([started(), encodeFrame(5 as 1, SOURCE.NONE, 0, new Uint8Array())]),
      concat([started(), encodeFrame(KIND.AUDIO, 9, 0, new Uint8Array())]),
    ]) {
      let refMessage = '';
      try {
        new ref.FrameParser().push(Buffer.from(bad));
      } catch (e) {
        refMessage = (e as Error).message;
      }
      expect(refMessage).not.toBe('');
      expect(() => new FrameParser().push(bad)).toThrow(refMessage);
    }
  });
});
