import type { SyncEvent } from '@oat/core/sync';
import { describe, expect, it, vi } from 'vitest';

import { SseParser, SyncEventsClient } from './sync-events.ts';

describe('SseParser', () => {
  it('parses events across chunk boundaries, ignores comments, joins data lines', () => {
    const p = new SseParser();
    expect(p.push('retry: 2000\n\n: keep-alive\n\nid: 1.2\nevent: ch')).toEqual([]);
    expect(p.push('ange\ndata: {"a":1}\n\nevent: x\r\ndata: one\r\ndata: two\r\n\r\n')).toEqual([
      { id: '1.2', event: 'change', data: '{"a":1}' },
      { id: null, event: 'x', data: 'one\ntwo' },
    ]);
  });
});

/** A controllable SSE response body. */
function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
  const enc = new TextEncoder();
  return {
    response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    send: (text: string) => controller.enqueue(enc.encode(text)),
    end: () => controller.close(),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

describe('SyncEventsClient', () => {
  it('notifies on open and on each change, reconnects with Last-Event-ID', async () => {
    const connects: (string | null)[] = [];
    const streams: ReturnType<typeof stream>[] = [];
    const events: SyncEvent[] = [];
    const opened = vi.fn();
    const timers: (() => void)[] = [];
    const client = new SyncEventsClient({
      connect: async (lastEventId) => {
        connects.push(lastEventId);
        const s = stream();
        streams.push(s);
        return s.response;
      },
      onEvent: (e) => events.push(e),
      onOpen: opened,
      setTimer: (fn, ms) => {
        if (ms < 10_000) timers.push(fn); // retries, not the idle watchdog
        return () => {};
      },
      random: () => 0.5,
    });
    client.start();
    await flush();
    streams[0]!.send('retry: 2000\n\nid: 5.1\nevent: ready\ndata: {"seq":"5.1"}\n\n');
    await flush();
    expect(opened).toHaveBeenCalledTimes(1);
    expect(client.connected).toBe(true);
    streams[0]!.send(
      'id: 6.3\nevent: change\ndata: {"seq":"6.3","tables":["document"],"ids":["d1"]}\n\n',
    );
    streams[0]!.send('event: change\ndata: not json\n\n');
    await flush();
    expect(events).toEqual([{ seq: '6.3', tables: ['document'], ids: ['d1'] }]);
    streams[0]!.end();
    await flush();
    expect(client.connected).toBe(false);
    timers.shift()!();
    await flush();
    expect(connects).toEqual([null, '6.3']);
    client.stop();
  });

  it('backs off on failures and stops on 401', async () => {
    const delays: number[] = [];
    let calls = 0;
    let retry: (() => void) | null = null;
    const client = new SyncEventsClient({
      connect: async () => {
        calls += 1;
        if (calls < 4) throw Object.assign(new Error('down'), { status: 0 });
        throw Object.assign(new Error('nope'), { status: 401 });
      },
      onEvent: () => {},
      onOpen: () => {},
      setTimer: (fn, ms) => {
        if (ms < 10_000) {
          delays.push(ms);
          retry = fn;
        }
        return () => {};
      },
      random: () => 0.5,
    });
    client.start();
    for (let i = 0; i < 4; i++) {
      await flush();
      const r = retry as (() => void) | null;
      retry = null;
      r?.();
    }
    await flush();
    expect(delays).toEqual([1_000, 2_000, 4_000]);
    expect(calls).toBe(4);
    expect(client.connected).toBe(false);
  });

  it('drops a connection that goes quiet and reconnects', async () => {
    let idle: (() => void) | null = null;
    let retry: (() => void) | null = null;
    let calls = 0;
    const client = new SyncEventsClient({
      connect: async (_id, signal) => {
        calls += 1;
        const s = stream();
        signal.addEventListener('abort', () => s.end());
        return s.response;
      },
      onEvent: () => {},
      onOpen: () => {},
      idleTimeoutMs: 45_000,
      setTimer: (fn, ms) => {
        if (ms === 45_000) idle = fn;
        else retry = fn;
        return () => {};
      },
      random: () => 0.5,
    });
    client.start();
    await flush();
    expect(calls).toBe(1);
    (idle as unknown as () => void)();
    await flush();
    (retry as unknown as () => void)();
    await flush();
    expect(calls).toBe(2);
    client.stop();
  });
});
