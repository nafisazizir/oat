import { describe, expect, it } from 'vitest';

import { measureLevel } from './level.ts';
import { downmixToMono, resampleInt16 } from './resample.ts';

function sine(freq: number, rate: number, seconds: number, amplitude = 0.5): Int16Array {
  const n = Math.round(rate * seconds);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++)
    out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * amplitude * 32767);
  return out;
}

/** Correlation-based amplitude of `freq` in the signal (ignoring the first/last 10 ms of edge effects). */
function toneAmplitude(pcm: Int16Array, rate: number, freq: number): number {
  const skip = Math.round(rate / 100);
  let re = 0;
  let im = 0;
  for (let i = skip; i < pcm.length - skip; i++) {
    const phase = (2 * Math.PI * freq * i) / rate;
    re += (pcm[i] as number) * Math.cos(phase);
    im += (pcm[i] as number) * Math.sin(phase);
  }
  return (2 * Math.hypot(re, im)) / (pcm.length - 2 * skip) / 32767;
}

describe('resampleInt16', () => {
  it('returns the input when rates match', () => {
    const pcm = sine(440, 16_000, 0.1);
    expect(resampleInt16(pcm, 16_000, 16_000)).toBe(pcm);
  });

  it.each([48_000, 44_100, 22_050, 8_000])(
    'converts %i Hz → 16 kHz keeping a 1 kHz tone',
    (rate) => {
      const out = resampleInt16(sine(1000, rate, 0.5), rate, 16_000);
      expect(out.length).toBe(8000);
      expect(toneAmplitude(out, 16_000, 1000)).toBeCloseTo(0.5, 2);
    },
  );

  it('removes content above the target Nyquist instead of aliasing it', () => {
    // 11 kHz at 48 kHz would alias to 5 kHz at 16 kHz without a low-pass filter.
    const out = resampleInt16(sine(11_000, 48_000, 0.5), 48_000, 16_000);
    expect(toneAmplitude(out, 16_000, 5000)).toBeLessThan(0.005);
    expect(measureLevel(out, 160, out.length - 160).rmsDb).toBeLessThan(-45);
  });

  it('preserves DC and sample-0 alignment', () => {
    const dc = new Int16Array(4800).fill(1000);
    const out = resampleInt16(dc, 48_000, 16_000);
    expect(out.length).toBe(1600);
    expect(out.every((s) => s === 1000)).toBe(true);
  });

  it('rejects invalid rates', () => {
    expect(() => resampleInt16(new Int16Array(4), 0, 16_000)).toThrow(RangeError);
  });
});

describe('downmixToMono', () => {
  it('averages channels and passes mono through', () => {
    const a = new Int16Array([100, -100, 32767]);
    const b = new Int16Array([300, 100, 32767]);
    expect([...downmixToMono([a, b])]).toEqual([200, 0, 32767]);
    expect(downmixToMono([a])).toBe(a);
  });
});
