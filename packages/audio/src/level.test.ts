import { describe, expect, it } from 'vitest';

import { LevelMeter, measureLevel, SILENCE_DB, toDbfs } from './level.ts';

describe('levels', () => {
  it('reports silence as −100 dBFS', () => {
    expect(measureLevel(new Int16Array(100))).toMatchObject({
      rms: 0,
      rmsDb: SILENCE_DB,
      peakDb: SILENCE_DB,
    });
    expect(measureLevel(new Int16Array(0)).rmsDb).toBe(SILENCE_DB);
    expect(toDbfs(1e-9)).toBe(SILENCE_DB);
  });

  it('measures a full-scale square wave as 0 dBFS and a half-scale sine as ≈ −9 dBFS', () => {
    const square = Int16Array.from({ length: 160 }, (_, i) => (i % 2 ? 32767 : -32768));
    expect(measureLevel(square).rmsDb).toBeCloseTo(0, 3);
    expect(measureLevel(square).peakDb).toBeCloseTo(0, 3);

    const sine = Int16Array.from({ length: 16_000 }, (_, i) =>
      Math.round(16384 * Math.sin((2 * Math.PI * 440 * i) / 16_000)),
    );
    const level = measureLevel(sine);
    expect(level.rmsDb).toBeCloseTo(-6.02 - 3.01, 1);
    expect(level.peakDb).toBeCloseTo(-6.02, 1);
  });

  it('measures a sub-range', () => {
    const pcm = new Int16Array(200);
    pcm.fill(16384, 100);
    expect(measureLevel(pcm, 0, 100).rmsDb).toBe(SILENCE_DB);
    expect(measureLevel(pcm, 100).rmsDb).toBeCloseTo(-6.02, 1);
  });

  it('LevelMeter reports once per complete window across frame boundaries', () => {
    const meter = new LevelMeter(4000);
    const frame = new Int16Array(320).fill(16384);
    const levels = Array.from({ length: 25 }, () => meter.push(frame)).flat(); // 8000 samples
    expect(levels).toHaveLength(2);
    expect(levels[0]?.rmsDb).toBeCloseTo(-6.02, 1);
    expect(meter.flush()).toBeUndefined();
    meter.push(new Int16Array(10));
    expect(meter.flush()?.rmsDb).toBe(SILENCE_DB);
  });
});
