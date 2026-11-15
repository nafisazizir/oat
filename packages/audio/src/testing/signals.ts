/** Test helpers for archive tests: synthetic signals, framing and comparison metrics. */
import type { AudioFrame, AudioSourceKind } from '../types.ts';

/** Deterministic PRNG (mulberry32) so "random" cuts and noise are reproducible. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A sine sweep-ish "voice-like" signal: two partials with slow amplitude modulation. */
export function voiceLike(samples: number, rate = 16_000, seed = 1): Int16Array {
  const rnd = prng(seed);
  const f1 = 180 + rnd() * 120;
  const f2 = 900 + rnd() * 600;
  return Int16Array.from({ length: samples }, (_, i) => {
    const t = i / rate;
    const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * 3 * t);
    return Math.round(
      env * (7000 * Math.sin(2 * Math.PI * f1 * t) + 2500 * Math.sin(2 * Math.PI * f2 * t)),
    );
  });
}

export function tone(samples: number, freq: number, rate = 16_000, amplitude = 8000): Int16Array {
  return Int16Array.from({ length: samples }, (_, i) =>
    Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / rate)),
  );
}

export function whiteNoise(samples: number, seed = 7, amplitude = 12_000): Int16Array {
  const rnd = prng(seed);
  return Int16Array.from({ length: samples }, () => Math.round((rnd() * 2 - 1) * amplitude));
}

/** Splits `pcm` into frames starting at `startUs`, contiguous on a sample-count clock. */
export function toFrames(
  pcm: Int16Array,
  options: {
    startUs?: number;
    frameSamples?: number;
    rate?: number;
    source?: AudioSourceKind;
  } = {},
): AudioFrame[] {
  const rate = options.rate ?? 16_000;
  const size = options.frameSamples ?? 320;
  const start = options.startUs ?? 0;
  const frames: AudioFrame[] = [];
  for (let i = 0; i < pcm.length; i += size) {
    frames.push({
      source: options.source ?? 'mic',
      tUs: start + Math.round((i * 1_000_000) / rate),
      pcm: pcm.slice(i, i + size),
      sampleRate: rate,
    });
  }
  return frames;
}

/** Normalised cross-correlation of `a` and `b` (b shifted by `lag`) over `[from, to)` of `a`. */
export function correlation(
  a: Int16Array,
  b: Int16Array,
  lag = 0,
  from = 0,
  to = a.length,
): number {
  let xy = 0;
  let xx = 0;
  let yy = 0;
  for (let i = Math.max(from, -lag); i < Math.min(to, b.length - lag); i++) {
    const x = a[i] as number;
    const y = b[i + lag] as number;
    xy += x * y;
    xx += x * x;
    yy += y * y;
  }
  return xx === 0 || yy === 0 ? 0 : xy / Math.sqrt(xx * yy);
}

/** Lag in [-maxLag, maxLag] with the highest correlation, and that correlation. */
export function bestLag(a: Int16Array, b: Int16Array, maxLag: number, from = 0, to = a.length) {
  let best = { lag: 0, value: -Infinity };
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const value = correlation(a, b, lag, from, to);
    if (value > best.value) best = { lag, value };
  }
  return best;
}

export function rms(pcm: Int16Array, from = 0, to = pcm.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += (pcm[i] as number) ** 2;
  return to > from ? Math.sqrt(sum / (to - from)) : 0;
}

/** First index ≥ `from` where |sample| exceeds `threshold`. */
export function onset(pcm: Int16Array, from = 0, threshold = 1000): number {
  for (let i = from; i < pcm.length; i++) if (Math.abs(pcm[i] as number) > threshold) return i;
  return -1;
}
