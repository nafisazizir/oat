import type { TranscriptBatch, LiveSegment } from '@oat/core/bridge';
import { describe, expect, it } from 'vitest';

import { TranscriptStore } from '../shared/transcript.ts';
import { TranscriptBuffer } from './transcript-buffer.ts';

const seg = (id: string, text: string, isFinal: boolean, startMs = 0): LiveSegment => ({
  id,
  source: 'mic',
  startMs,
  endMs: startMs + 500,
  text,
  isFinal,
});

function setup() {
  const batches: TranscriptBatch[] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const buffer = new TranscriptBuffer({
    onBatch: (b) => batches.push(b),
    batchMs: 50,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => (t.cancelled = true);
    },
  });
  const tick = () => {
    for (const t of timers.splice(0)) if (!t.cancelled) t.fn();
  };
  return { buffer, batches, timers, tick };
}

describe('TranscriptBuffer', () => {
  it('batches segments within the window; repeated updates of an id collapse to the newest', () => {
    const { buffer, batches, timers, tick } = setup();
    buffer.reset('m1');
    buffer.push(seg('a', 'one', false));
    buffer.push(seg('a', 'one two', false));
    buffer.push(seg('b', 'other', false, 1000));
    buffer.push(seg('a', 'One two three.', true));
    expect(timers).toHaveLength(1); // one timer per batch
    expect(timers[0]!.ms).toBe(50);
    expect(batches).toEqual([]);
    tick();
    expect(batches).toEqual([
      {
        meetingId: 'm1',
        seq: 1,
        segments: [seg('b', 'other', false, 1000), seg('a', 'One two three.', true)],
      },
    ]);
  });

  it('seq lines up with snapshots: snapshot flushes first, the next batch is seq + 1', () => {
    const { buffer, batches, tick } = setup();
    buffer.reset('m1');
    buffer.push(seg('a', 'hi', true));
    tick();
    buffer.push(seg('b', 'pending', false, 600));
    const snap = buffer.snapshot();
    expect(snap).toEqual({
      meetingId: 'm1',
      seq: 2,
      segments: [seg('a', 'hi', true), seg('b', 'pending', false, 600)],
    });
    expect(batches.map((b) => b.seq)).toEqual([1, 2]);
    buffer.push(seg('b', '', true, 600)); // retraction
    tick();
    expect(batches.at(-1)!.seq).toBe(3);
    expect(buffer.segments).toEqual([seg('a', 'hi', true)]);

    // A window that loaded the snapshot and applies the later batches matches main.
    const view = new TranscriptStore();
    view.apply(snap.segments);
    for (const b of batches.filter((x) => x.seq > snap.seq)) view.apply(b.segments);
    expect(view.segments).toEqual(buffer.segments);
  });

  it('reset switches meetings: drops pending and stored segments, seq restarts', () => {
    const { buffer, batches, tick } = setup();
    buffer.reset('m1');
    buffer.push(seg('a', 'old', true));
    buffer.reset('m2');
    tick();
    expect(batches).toEqual([]);
    expect(buffer.snapshot()).toEqual({ meetingId: 'm2', seq: 0, segments: [] });
  });

  it('a final (pending or already sent) is never replaced by an interim with its id', () => {
    const { buffer, batches, tick } = setup();
    buffer.reset('m1');
    buffer.push(seg('a', 'Done.', true));
    buffer.push(seg('a', 'do', false)); // pending final wins
    tick();
    buffer.push(seg('a', 'do', false)); // sent final wins
    tick();
    expect(batches).toHaveLength(1);
    expect(buffer.segments).toEqual([seg('a', 'Done.', true)]);
  });

  it('ignores segments without a meeting', () => {
    const { buffer, batches, tick } = setup();
    buffer.push(seg('a', 'x', true));
    tick();
    buffer.flush();
    expect(batches).toEqual([]);
  });
});
