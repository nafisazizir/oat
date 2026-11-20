import type { SyncPushEntry } from '@oat/core/sync';
import { describe, expect, it, vi } from 'vitest';

import { PcmConverter } from './recording-pcm';
import { RecordingQueue } from './recording-queue';

describe('browser PCM conversion', () => {
  it('downmixes, clips and resamples continuously across arbitrary worklet boundaries', () => {
    const converter = new PcmConverter(48000);
    expect([...converter.push([new Float32Array([1, 1]), new Float32Array([-1, -1])])]).toEqual([]);
    expect([...converter.push([new Float32Array([0]), new Float32Array([0])])]).toEqual([0]);
    const samples = new PcmConverter(16000).push([new Float32Array([-2, -1, 0, 1, 2])]);
    expect([...samples]).toEqual([-32768, -32768, 0, 32767, 32767]);
    const fractional = new PcmConverter(44100);
    let length = 0;
    for (let i = 0; i < 441; i++)
      length += fractional.push([new Float32Array(100).fill(0.5)]).length;
    expect(length).toBe(16000);
  });
  it('accepts empty input and rejects an invalid sample rate', () => {
    expect(new PcmConverter(48000).push([]).length).toBe(0);
    expect(() => new PcmConverter(0)).toThrow(RangeError);
  });
});

describe('recording sync queue', () => {
  const entry = { op: 'delete' as const, table: 'transcript_segment' as const, id: 'segment' };
  it('does not push empty batches, retains failed writes, and serializes retries with concurrent additions', async () => {
    let release!: (value: { results: { version: number; status: 'ok' }[] }) => void;
    const push = vi
      .fn<(entries: SyncPushEntry[]) => Promise<{ results: { version: number; status: 'ok' }[] }>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockImplementation(async (entries) => ({
        results: entries.map((e) => ({ version: e.version, status: 'ok' })),
      }));
    const changed = vi.fn();
    const queue = new RecordingQueue(push, changed);
    await queue.flush();
    expect(push).not.toHaveBeenCalled();
    queue.enqueue(entry);
    await queue.flush();
    expect(queue.pending).toBe(1);
    expect(changed).toHaveBeenLastCalledWith(1, 'offline');
    const retry = queue.flush();
    expect(queue.flush()).toBe(retry);
    queue.enqueue({ ...entry, id: 'another' });
    release({ results: [{ version: 1, status: 'ok' }] });
    await retry;
    expect(queue.pending).toBe(0);
    expect(push.mock.calls[1]![0]).toEqual([{ ...entry, version: 1 }]);
    expect(push.mock.calls[2]![0]).toEqual([{ ...entry, id: 'another', version: 2 }]);
  });
  it('keeps rejected entries visible instead of pretending they synced', async () => {
    const changed = vi.fn();
    const queue = new RecordingQueue(
      async () => ({
        results: [{ version: 1, status: 'rejected', code: 'forbidden', message: 'No edit access' }],
      }),
      changed,
    );
    queue.enqueue(entry);
    await queue.flush();
    expect(queue.pending).toBe(1);
    expect(changed).toHaveBeenLastCalledWith(1, 'No edit access');
  });
});
