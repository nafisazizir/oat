import { afterEach, describe, expect, it } from 'vitest';
import type { LoggedRequest } from './request-log.ts';
import { startMocks, type RunningMocks } from './server.ts';

// In-process server on a random loopback port: no containers needed, so these are unit tests.

let running: RunningMocks | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error(`websocket ${url} failed`));
  });
}

const nextMessage = (ws: WebSocket) =>
  new Promise<unknown>((resolve) => {
    ws.onmessage = (event) => resolve(event.data);
  });

describe('startMocks', () => {
  it('listens on a random port and serves HTTP', async () => {
    running = await startMocks();
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(running.port).toBeGreaterThan(0);
    const res = await fetch(`${running.url}/health`);
    expect(await res.json()).toMatchObject({ status: 'ok' });
  });

  it('gives each instance its own state', async () => {
    const a = await startMocks();
    const b = await startMocks();
    try {
      expect(a.port).not.toBe(b.port);
      await fetch(`${a.url}/example/counter`, { method: 'POST' });
      expect(await (await fetch(`${b.url}/example/counter`)).json()).toEqual({ count: 0 });
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  it('routes provider websockets, echoing text and binary frames, and logs the upgrade', async () => {
    running = await startMocks();
    const ws = await openSocket(`${running.url.replace('http', 'ws')}/example/ws?model=x`);

    const text = nextMessage(ws);
    ws.send('hello');
    expect(await text).toBe('hello');

    const binary = nextMessage(ws);
    ws.send(new Uint8Array([1, 2, 3]));
    expect(new Uint8Array((await binary) as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
    ws.close();

    const { requests } = (await (await fetch(`${running.url}/_requests`)).json()) as {
      requests: LoggedRequest[];
    };
    expect(requests).toEqual([
      expect.objectContaining({ path: '/example/ws', query: { model: 'x' }, status: 101 }),
    ]);
  });

  it('rejects websocket upgrades for unknown paths', async () => {
    running = await startMocks();
    await expect(openSocket(`${running.url.replace('http', 'ws')}/example/nope`)).rejects.toThrow();
    expect(running.log.list().map((r) => [r.path, r.status])).toEqual([['/example/nope', 404]]);
  });

  it('close() terminates open websockets', async () => {
    running = await startMocks();
    const ws = await openSocket(`${running.url.replace('http', 'ws')}/example/ws`);
    const closed = new Promise((resolve) => (ws.onclose = resolve));
    await running.close();
    running = undefined;
    await closed;
  });
});
