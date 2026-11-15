import type { AudioFrame } from '@oat/audio';
import { describe, expect, it } from 'vitest';

import { ReplayBuffer, SocketTimeline } from './replay.ts';

/** 20 ms frame at 16 kHz starting at `ms`. */
const frame = (ms: number, samples = 320): AudioFrame => ({
  source: 'mic',
  tUs: ms * 1000,
  pcm: new Int16Array(samples),
  sampleRate: 16_000,
});

describe('ReplayBuffer', () => {
  it('keeps at least capacityMs of the most recent audio', () => {
    const buf = new ReplayBuffer(100);
    for (let ms = 0; ms < 1000; ms += 20) buf.push(frame(ms));
    expect(buf.heldMs).toBe(100);
    expect(buf.firstUs).toBe(900_000);
    expect(buf.size).toBe(5);
  });

  it('holds 120 s by default sizing without unbounded growth', () => {
    const buf = new ReplayBuffer(120_000);
    for (let ms = 0; ms < 300_000; ms += 20) buf.push(frame(ms));
    expect(buf.heldMs).toBe(120_000);
    expect(buf.firstUs).toBe(180_000_000);
  });

  it('from(t) returns the frame containing t and everything after', () => {
    const buf = new ReplayBuffer(10_000);
    for (let ms = 0; ms < 200; ms += 20) buf.push(frame(ms));
    expect(buf.from(45_000).map((f) => f.tUs / 1000)).toEqual([
      40, 60, 80, 100, 120, 140, 160, 180,
    ]);
    expect(buf.from(40_000)[0]!.tUs).toBe(40_000);
    expect(buf.from(-Infinity)).toHaveLength(10);
    expect(buf.from(200_000)).toEqual([]);
  });

  it('works across gaps and after eviction', () => {
    const buf = new ReplayBuffer(40);
    buf.push(frame(0));
    buf.push(frame(20));
    buf.push(frame(500)); // gap (pause)
    buf.push(frame(520));
    expect(buf.firstUs).toBe(500_000);
    // What was evicted ends at 40 ms: the gap up to 500 ms is a pause, not lost audio.
    expect(buf.evictedEndUs).toBe(40_000);
    expect(buf.from(0).map((f) => f.tUs)).toEqual([500_000, 520_000]);
    buf.clear();
    expect(buf.size).toBe(0);
    expect(buf.firstUs).toBeUndefined();
  });

  it('rejects a non-positive capacity', () => {
    expect(() => new ReplayBuffer(0)).toThrow(RangeError);
  });
});

describe('SocketTimeline', () => {
  it('maps socket seconds to the recording clock from the first frame sent', () => {
    const t = new SocketTimeline(16_000);
    for (let ms = 8_000; ms < 9_000; ms += 20) t.append(frame(ms));
    expect(t.originUs).toBe(8_000_000);
    expect(t.toRecordingMs(0)).toBe(8_000);
    expect(t.toRecordingMs(0.5)).toBe(8_500);
  });

  it('adds an anchor at each discontinuity (pause/dropped audio)', () => {
    const t = new SocketTimeline(16_000);
    t.append(frame(0));
    t.append(frame(20));
    t.append(frame(1_000)); // socket 0.04 s = recording 1000 ms
    t.append(frame(1_020));
    expect(t.toRecordingMs(0.03)).toBe(30);
    expect(t.toRecordingMs(0.04)).toBe(1_000);
    expect(t.toRecordingMs(0.07)).toBe(1_030);
  });

  it('is the identity before any frame', () => {
    expect(new SocketTimeline(16_000).toRecordingMs(1.5)).toBe(1_500);
  });
});
