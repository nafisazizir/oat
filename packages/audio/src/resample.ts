/**
 * Offline sample-rate conversion for whole buffers (fixtures, file input). Band-limited windowed-sinc
 * interpolation (Blackman window, 16 zero crossings per side) so downsampling 44.1/48 kHz → 16 kHz does not
 * alias into the speech band. Not intended for streaming.
 */

const ZERO_CROSSINGS = 16;
const TABLE_RESOLUTION = 512; // kernel samples per zero crossing (linearly interpolated)

let kernelTable: Float64Array | undefined;

function kernel(): Float64Array {
  if (kernelTable) return kernelTable;
  const n = ZERO_CROSSINGS * TABLE_RESOLUTION;
  const table = new Float64Array(n + 2);
  for (let k = 0; k <= n; k++) {
    const x = k / TABLE_RESOLUTION;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const w = 0.5 + 0.5 * (k / n); // 0.5 … 1 → Blackman over the right half
    const blackman = 0.42 - 0.5 * Math.cos(2 * Math.PI * w) + 0.08 * Math.cos(4 * Math.PI * w);
    table[k] = sinc * blackman;
  }
  kernelTable = table;
  return table;
}

function h(table: Float64Array, x: number): number {
  const ax = Math.abs(x) * TABLE_RESOLUTION;
  const i = Math.floor(ax);
  if (i >= ZERO_CROSSINGS * TABLE_RESOLUTION) return 0;
  const frac = ax - i;
  return (table[i] as number) * (1 - frac) + (table[i + 1] as number) * frac;
}

/**
 * Resample mono 16-bit PCM. Returns `input` itself when the rates match. Output length is
 * `round(input.length * toRate / fromRate)` and sample 0 stays aligned with input sample 0.
 */
export function resampleInt16(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (!(fromRate > 0) || !(toRate > 0)) throw new RangeError('sample rates must be positive');
  if (fromRate === toRate) return input;
  const table = kernel();
  const ratio = toRate / fromRate;
  // Cut off slightly below the lower Nyquist so the transition band stays out of the passband edge.
  const scale = Math.min(1, ratio) * 0.95;
  const reach = ZERO_CROSSINGS / scale; // in input samples
  const outLength = Math.round(input.length * ratio);
  const out = new Int16Array(outLength);
  const last = input.length - 1;
  for (let n = 0; n < outLength; n++) {
    const t = n / ratio;
    const lo = Math.max(0, Math.ceil(t - reach));
    const hi = Math.min(last, Math.floor(t + reach));
    let acc = 0;
    let norm = 0;
    for (let i = lo; i <= hi; i++) {
      const w = h(table, (i - t) * scale);
      acc += w * (input[i] as number);
      norm += w;
    }
    const v = norm > 0 ? Math.round(acc / norm) : 0;
    out[n] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return out;
}

/** Average all channels into one. Returns the only channel itself for mono input. */
export function downmixToMono(channels: readonly Int16Array[]): Int16Array {
  if (channels.length === 0) throw new RangeError('need at least one channel');
  if (channels.length === 1) return channels[0] as Int16Array;
  const length = Math.min(...channels.map((c) => c.length));
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const ch of channels) sum += ch[i] as number;
    out[i] = Math.round(sum / channels.length);
  }
  return out;
}
