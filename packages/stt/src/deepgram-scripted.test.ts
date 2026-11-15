/**
 * DeepgramProvider against a scripted loopback websocket server (no containers, no mocks service): exact
 * control over what the "provider" says, for identity/retraction, auth refresh and pause behaviour.
 */
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';

import { DeepgramProvider, type DeepgramProviderOptions } from './deepgram.ts';
import { grantTokenSource } from './deepgram-config.ts';
import { uuidv7 } from './ids.ts';
import { record } from './test-utils.ts';

interface Scripted {
  url: string;
  /** Text messages the client sent, per connection. */
  texts: string[][];
  sockets: WebSocket[];
  close(): Promise<void>;
}

let server: Scripted | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function startServer(
  onConnection: (ws: WebSocket, index: number) => void,
  verify?: (req: IncomingMessage) => number | undefined,
): Promise<Scripted> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: verify
        ? (info, cb) => {
            const status = verify(info.req);
            if (status === undefined) cb(true);
            else cb(false, status);
          }
        : undefined,
    });
    const texts: string[][] = [];
    const sockets: WebSocket[] = [];
    wss.on('connection', (ws) => {
      const index = texts.push([]) - 1;
      sockets.push(ws);
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        const text = data.toString();
        texts[index]!.push(text);
        if (JSON.parse(text).type === 'CloseStream') ws.close(1000);
      });
      onConnection(ws, index);
    });
    wss.on('listening', () => {
      const { port } = wss.address() as AddressInfo;
      server = {
        url: `ws://127.0.0.1:${port}/v1/listen`,
        texts,
        sockets,
        close: () =>
          new Promise<void>((done) => {
            for (const c of wss.clients) c.terminate();
            wss.close(() => done());
          }),
      };
      resolve(server);
    });
  });
}

const results = (start: number, duration: number, transcript: string, isFinal: boolean) =>
  JSON.stringify({
    type: 'Results',
    start,
    duration,
    is_final: isFinal,
    speech_final: isFinal,
    channel: {
      alternatives: [
        {
          transcript,
          words: transcript
            ? transcript.split(' ').map((w, i) => ({
                word: w,
                start: start + i * 0.2,
                end: start + i * 0.2 + 0.15,
              }))
            : [],
        },
      ],
    },
  });

const provider = (url: string, options: Partial<DeepgramProviderOptions> = {}) =>
  new DeepgramProvider({
    url,
    getToken: () => Promise.resolve({ token: 't' }),
    reconnect: { initialDelayMs: 5, maxDelayMs: 10 },
    ...options,
  });

const pcm = new Int16Array(320);
const frame = (ms: number) => ({ source: 'mic' as const, tUs: ms * 1000, pcm, sampleRate: 16_000 });

const until = async (check: () => boolean, ms = 3_000) => {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('segment identity', () => {
  it('interims share the id of their final; the next segment gets a new id', async () => {
    const s = await startServer(() => undefined);
    const rec = record(provider(s.url).openStream({ source: 'mic', sampleRate: 16_000 }));
    await until(() => s.sockets.length === 1 && rec.stream.status === 'open');
    rec.stream.write(frame(0));
    const ws = s.sockets[0]!;
    ws.send(results(0, 0.5, 'hello', false));
    ws.send(results(0, 1, 'hello there', false));
    ws.send(results(0, 1.2, 'hello there', true));
    ws.send(results(1.2, 0.5, 'next', false));
    await until(() => rec.segments.length === 4);
    const [a, b, c, d] = rec.segments;
    expect(a!.id).toBe(b!.id);
    expect(c).toMatchObject({ id: a!.id, isFinal: true, text: 'hello there' });
    expect(d!.id).not.toBe(a!.id);
    await rec.stream.finish();
    // finish() leaves nothing provisional: the open interim "next" is retracted.
    expect(rec.segments.at(-1)).toMatchObject({ id: d!.id, isFinal: true, text: '' });
  });

  it('an empty final after an interim retracts it (same id, empty text)', async () => {
    const s = await startServer(() => undefined);
    const rec = record(provider(s.url).openStream({ source: 'mic', sampleRate: 16_000 }));
    await until(() => s.sockets.length === 1 && rec.stream.status === 'open');
    rec.stream.write(frame(0));
    s.sockets[0]!.send(results(0, 0.5, 'uh', false));
    s.sockets[0]!.send(results(0, 1, '', true));
    s.sockets[0]!.send(results(1, 1, '', true)); // nothing open: no retraction
    await until(() => rec.segments.length === 2);
    await new Promise((r) => setTimeout(r, 30));
    expect(rec.segments).toHaveLength(2);
    expect(rec.segments[1]).toMatchObject({
      id: rec.segments[0]!.id,
      isFinal: true,
      text: '',
      speechFinal: false,
    });
    expect(rec.segments[1]).not.toHaveProperty('words');
    rec.stream.close();
  });
});

describe('auth refresh', () => {
  it('after a 401 the retry asks getToken for a fresh token (cache bypassed)', async () => {
    const seen: string[] = [];
    const s = await startServer(
      () => undefined,
      (req) => {
        seen.push(req.headers.authorization ?? '');
        return req.headers.authorization === 'Bearer t1' ? 401 : undefined;
      },
    );
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: 't1', expires_in: 600 }))
      .mockResolvedValueOnce(Response.json({ access_token: 't2', expires_in: 600 }));
    const getToken = vi.fn(grantTokenSource({ grantUrl: 'http://grant.test/g', fetch }));
    const rec = record(
      provider(s.url, { getToken }).openStream({ source: 'mic', sampleRate: 16_000 }),
    );
    await until(() => rec.stream.status === 'open');
    expect(getToken.mock.calls).toEqual([[undefined], [{ refresh: true }]]);
    expect(seen).toEqual(['Bearer t1', 'Bearer t2']);
    expect(rec.errors).toMatchObject([{ code: 'auth', fatal: false, status: 401 }]);
    rec.stream.close();
  });
});

describe('pause', () => {
  it('sends Finalize once when audio stops and never reports a stall while paused', async () => {
    // A provider that never answers: only a pause can explain the silence, so no stall may fire.
    const s = await startServer(() => undefined);
    const rec = record(
      provider(s.url, { pauseFinalizeMs: 100, stallTimeoutMs: 150, keepAliveMs: 5_000 }).openStream(
        {
          source: 'mic',
          sampleRate: 16_000,
        },
      ),
    );
    await until(() => rec.stream.status === 'open');
    for (let i = 0; i < 5; i++) rec.stream.write(frame(i * 20));
    await new Promise((r) => setTimeout(r, 600)); // paused ≫ stallTimeoutMs
    expect(s.texts[0]!.map((t) => JSON.parse(t).type)).toEqual(['Finalize']);
    expect(rec.errors).toEqual([]);
    expect(rec.statuses).toEqual(['connecting', 'open']);

    // Audio resumes and keeps flowing unanswered → that *is* a stall.
    const writer = setInterval(() => rec.stream.write(frame(200 + performance.now())), 20);
    try {
      await until(() => rec.errors.some((e) => e.code === 'stall'));
    } finally {
      clearInterval(writer);
    }
    rec.stream.close();
  });
});

describe('quota', () => {
  it('402 is fatal; 429 retries rateLimitRetries times, then fatal', async () => {
    const s402 = await startServer(
      () => undefined,
      () => 402,
    );
    const r402 = record(provider(s402.url).openStream({ source: 'mic', sampleRate: 16_000 }));
    await until(() => r402.stream.status === 'error');
    expect(r402.errors).toMatchObject([{ code: 'quota', fatal: true, status: 402 }]);
    await s402.close();

    const s429 = await startServer(
      () => undefined,
      () => 429,
    );
    const r429 = record(
      provider(s429.url, { rateLimitRetries: 2 }).openStream({ source: 'mic', sampleRate: 16_000 }),
    );
    await until(() => r429.stream.status === 'error');
    expect(r429.errors.map((e) => [e.code, e.fatal, e.status])).toEqual([
      ['quota', false, 429],
      ['quota', false, 429],
      ['quota', true, 429],
    ]);
  });
});

describe('uuidv7', () => {
  it('is a time-ordered RFC 9562 v7 UUID', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a.slice(0, 13)).toBe('018bcfe5-6800');
    expect(a < b).toBe(true);
    expect(uuidv7()).not.toBe(uuidv7());
  });
});
