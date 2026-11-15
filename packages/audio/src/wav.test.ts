import { describe, expect, it } from 'vitest';

import { decodeWav, encodeWav, floatToInt16, WavError, wavDurationMs } from './wav.ts';

function ramp(length: number, step: number, offset = 0): Int16Array {
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) out[i] = ((i * step + offset) % 65536) - 32768;
  return out;
}

/** Hand-built WAV with arbitrary fmt fields and extra chunks before/after `data`. */
function rawWav(opts: {
  format: number;
  channels: number;
  sampleRate: number;
  bits: number;
  data: Uint8Array;
  extensible?: boolean;
  junkBefore?: Uint8Array;
}): Uint8Array {
  const fmtSize = opts.extensible ? 40 : 16;
  const junk = opts.junkBefore;
  const junkSize = junk ? 8 + junk.length + (junk.length % 2) : 0;
  const total = 12 + 8 + fmtSize + junkSize + 8 + opts.data.length;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  const tag = (o: number, s: string) =>
    [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  tag(0, 'RIFF');
  v.setUint32(4, total - 8, true);
  tag(8, 'WAVE');
  let p = 12;
  if (junk) {
    tag(p, 'LIST');
    v.setUint32(p + 4, junk.length, true);
    out.set(junk, p + 8);
    p += junkSize;
  }
  tag(p, 'fmt ');
  v.setUint32(p + 4, fmtSize, true);
  const blockAlign = (opts.bits / 8) * opts.channels;
  v.setUint16(p + 8, opts.extensible ? 0xfffe : opts.format, true);
  v.setUint16(p + 10, opts.channels, true);
  v.setUint32(p + 12, opts.sampleRate, true);
  v.setUint32(p + 16, opts.sampleRate * blockAlign, true);
  v.setUint16(p + 20, blockAlign, true);
  v.setUint16(p + 22, opts.bits, true);
  if (opts.extensible) {
    v.setUint16(p + 24, 22, true);
    v.setUint16(p + 26, opts.bits, true);
    v.setUint16(p + 32, opts.format, true); // SubFormat GUID starts with the format tag
  }
  p += 8 + fmtSize;
  tag(p, 'data');
  v.setUint32(p + 4, opts.data.length, true);
  out.set(opts.data, p + 8);
  return out;
}

describe('WAV encode/decode', () => {
  it('round-trips 2-channel 16-bit PCM exactly', () => {
    const left = ramp(1601, 37);
    const right = ramp(1601, 91, 5);
    left[0] = -32768;
    left[1] = 32767;
    const bytes = encodeWav({ sampleRate: 16_000, channels: [left, right] });
    expect(bytes.length).toBe(44 + 1601 * 4);

    const decoded = decodeWav(bytes);
    expect(decoded.sampleRate).toBe(16_000);
    expect(decoded.sourceBitsPerSample).toBe(16);
    expect(decoded.sourceFormat).toBe('pcm');
    expect(decoded.channels).toHaveLength(2);
    expect(decoded.channels[0]).toEqual(left);
    expect(decoded.channels[1]).toEqual(right);
    expect(wavDurationMs(decoded)).toBeCloseTo(100.0625, 6);
  });

  it('round-trips mono and empty audio', () => {
    const mono = ramp(10, 1000);
    expect(decodeWav(encodeWav({ sampleRate: 8000, channels: [mono] })).channels[0]).toEqual(mono);
    const empty = decodeWav(encodeWav({ sampleRate: 16_000, channels: [new Int16Array(0)] }));
    expect(empty.channels[0]).toHaveLength(0);
  });

  it('reads a Uint8Array view at a non-zero offset', () => {
    const bytes = encodeWav({ sampleRate: 16_000, channels: [ramp(8, 4000)] });
    const padded = new Uint8Array(bytes.length + 3);
    padded.set(bytes, 3);
    expect(decodeWav(padded.subarray(3)).channels[0]).toEqual(ramp(8, 4000));
  });

  it('skips unknown chunks (odd-sized, word-aligned) before fmt', () => {
    const data = new Uint8Array(new Int16Array([1, -2, 3, -4]).buffer);
    const wav = rawWav({
      format: 1,
      channels: 1,
      sampleRate: 22_050,
      bits: 16,
      data,
      junkBefore: new Uint8Array([1, 2, 3]),
    });
    const decoded = decodeWav(wav);
    expect(decoded.sampleRate).toBe(22_050);
    expect([...(decoded.channels[0] ?? [])]).toEqual([1, -2, 3, -4]);
  });

  it('converts 8/24/32-bit PCM and 32/64-bit float to 16-bit', () => {
    const u8 = rawWav({
      format: 1,
      channels: 1,
      sampleRate: 8000,
      bits: 8,
      data: new Uint8Array([0, 128, 255]),
    });
    expect([...(decodeWav(u8).channels[0] ?? [])]).toEqual([-32768, 0, 32512]);

    // 24-bit little-endian: 0x7FFFFF, 0x800000, 0x000100 (256 → 1 after >> 8)
    const s24 = rawWav({
      format: 1,
      channels: 1,
      sampleRate: 48_000,
      bits: 24,
      data: new Uint8Array([0xff, 0xff, 0x7f, 0x00, 0x00, 0x80, 0x00, 0x01, 0x00]),
    });
    expect([...(decodeWav(s24).channels[0] ?? [])]).toEqual([32767, -32768, 1]);

    const s32 = rawWav({
      format: 1,
      channels: 1,
      sampleRate: 48_000,
      bits: 32,
      data: new Uint8Array(new Int32Array([0x7fffffff, -0x80000000, 0x10000]).buffer),
      extensible: true,
    });
    expect([...(decodeWav(s32).channels[0] ?? [])]).toEqual([32767, -32768, 1]);

    const f32 = rawWav({
      format: 3,
      channels: 2,
      sampleRate: 44_100,
      bits: 32,
      data: new Uint8Array(new Float32Array([0.5, -0.5, 1.5, -1.5]).buffer),
    });
    const decodedF32 = decodeWav(f32);
    expect(decodedF32.sourceFormat).toBe('float');
    expect([...(decodedF32.channels[0] ?? [])]).toEqual([16384, 32767]);
    expect([...(decodedF32.channels[1] ?? [])]).toEqual([-16384, -32768]);

    const f64 = rawWav({
      format: 3,
      channels: 1,
      sampleRate: 44_100,
      bits: 64,
      data: new Uint8Array(new Float64Array([0.25]).buffer),
    });
    expect([...(decodeWav(f64).channels[0] ?? [])]).toEqual([8192]);
  });

  it('clamps a data chunk size larger than the file (streaming writers)', () => {
    const bytes = encodeWav({ sampleRate: 16_000, channels: [ramp(4, 100)] });
    new DataView(bytes.buffer).setUint32(40, 0xffffffff, true);
    expect(decodeWav(bytes).channels[0]).toHaveLength(4);
  });

  it('does not walk into the samples of an open-ended data chunk placed before fmt', () => {
    // RIFF WAVE, `data` (size 0 = open-ended) whose samples happen to spell a valid-looking `fmt ` chunk.
    const enc = new TextEncoder();
    const bytes = new Uint8Array(12 + 8 + 24);
    bytes.set(enc.encode('RIFF'), 0);
    bytes.set(enc.encode('WAVE'), 8);
    bytes.set(enc.encode('data'), 12);
    bytes.set(enc.encode('fmt '), 20);
    new DataView(bytes.buffer).setUint32(24, 16, true);
    expect(() => decodeWav(bytes)).toThrow(/missing fmt/);
  });

  it('rejects malformed input with WavError', () => {
    expect(() => decodeWav(new Uint8Array(10))).toThrow(WavError);
    expect(() => decodeWav(new TextEncoder().encode('RIFF\0\0\0\0WAVEjunk\0\0\0\0'))).toThrow(
      /missing fmt/,
    );
    const alaw = rawWav({
      format: 6,
      channels: 1,
      sampleRate: 8000,
      bits: 8,
      data: new Uint8Array(2),
    });
    expect(() => decodeWav(alaw)).toThrow(/unsupported WAV format/);
    expect(() =>
      encodeWav({ sampleRate: 16_000, channels: [new Int16Array(2), new Int16Array(3)] }),
    ).toThrow(/same length/);
  });

  it('floatToInt16 clamps and maps NaN to 0', () => {
    expect(floatToInt16(0)).toBe(0);
    expect(Object.is(floatToInt16(-0), 0)).toBe(true);
    expect(floatToInt16(0.99999)).toBe(32767);
    expect(floatToInt16(-1)).toBe(-32768);
    expect(floatToInt16(Number.NaN)).toBe(0);
  });
});
