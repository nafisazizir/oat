/** Level helpers for meters, silence detection and tests. dBFS relative to 16-bit full scale. */

/** Floor used for silence, same as the sidecar's `level` event. */
export const SILENCE_DB = -100;

export interface Level {
  /** Linear RMS, 0…1 of full scale. */
  rms: number;
  /** Linear absolute peak, 0…1 of full scale. */
  peak: number;
  rmsDb: number;
  peakDb: number;
}

export function toDbfs(linear: number): number {
  if (!(linear > 0)) return SILENCE_DB;
  return Math.max(SILENCE_DB, 20 * Math.log10(linear));
}

/** Level of `pcm[start, end)`. An empty range is silence. */
export function measureLevel(pcm: Int16Array, start = 0, end = pcm.length): Level {
  const lo = Math.max(0, start);
  const hi = Math.min(pcm.length, end);
  let sumSquares = 0;
  let peak = 0;
  for (let i = lo; i < hi; i++) {
    const s = pcm[i] as number;
    sumSquares += s * s;
    const a = s < 0 ? -s : s;
    if (a > peak) peak = a;
  }
  const n = hi - lo;
  const rms = n > 0 ? Math.sqrt(sumSquares / n) / 32768 : 0;
  const peakLinear = peak / 32768;
  return { rms, peak: peakLinear, rmsDb: toDbfs(rms), peakDb: toDbfs(peakLinear) };
}

/**
 * Accumulates samples and reports the level of each complete window (e.g. every 250 ms of audio, like the
 * sidecar). Call `push()` with each frame; it returns the levels of the windows completed by that frame.
 */
export class LevelMeter {
  readonly #window: number;
  #count = 0;
  #sumSquares = 0;
  #peak = 0;

  constructor(windowSamples: number) {
    if (!(windowSamples >= 1)) throw new RangeError('windowSamples must be ≥ 1');
    this.#window = Math.floor(windowSamples);
  }

  push(pcm: Int16Array): Level[] {
    const done: Level[] = [];
    for (let i = 0; i < pcm.length; i++) {
      const s = pcm[i] as number;
      this.#sumSquares += s * s;
      const a = s < 0 ? -s : s;
      if (a > this.#peak) this.#peak = a;
      if (++this.#count === this.#window) done.push(this.#take());
    }
    return done;
  }

  /** Level of the partial window so far (if any), then reset. */
  flush(): Level | undefined {
    return this.#count > 0 ? this.#take() : undefined;
  }

  #take(): Level {
    const rms = Math.sqrt(this.#sumSquares / this.#count) / 32768;
    const peak = this.#peak / 32768;
    this.#count = 0;
    this.#sumSquares = 0;
    this.#peak = 0;
    return { rms, peak, rmsDb: toDbfs(rms), peakDb: toDbfs(peak) };
  }
}
