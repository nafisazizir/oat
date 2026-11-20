import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserSttStream, type BrowserSocket } from './browser.ts';
import type { SttSegment } from './types.ts';

class Socket implements BrowserSocket {
  readyState = 0;
  bufferedAmount = 0;
  onopen: BrowserSocket['onopen'] = null;
  onmessage: BrowserSocket['onmessage'] = null;
  onerror: BrowserSocket['onerror'] = null;
  onclose: BrowserSocket['onclose'] = null;
  sent: (string | Uint8Array)[] = [];
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  result(text: string, final: boolean, duration = 0.02) {
    this.onmessage?.({
      data: JSON.stringify({
        type: 'Results',
        start: 0,
        duration,
        is_final: final,
        channel: { alternatives: [{ transcript: text }] },
      }),
    });
  }
}
const frame = (tUs = 0) => ({
  source: 'mic' as const,
  tUs,
  sampleRate: 16000,
  pcm: new Int16Array(320).fill(42),
});
afterEach(() => vi.useRealTimers());

describe('browser STT', () => {
  it('reuses one id across interim updates and their final, allocating a new id only after finalization', async () => {
    vi.useFakeTimers();
    const socket = new Socket();
    const stream = new BrowserSttStream({
      source: 'mic',
      sampleRate: 16000,
      socket: () => socket,
      getToken: async () => ({
        listenUrl: 'ws://localhost/listen',
        accessToken: 'token',
        keyterms: [],
      }),
    });
    const segments: SttSegment[] = [];
    stream.on('segment', (segment) => segments.push(segment));
    await vi.advanceTimersByTimeAsync(0);
    socket.open();
    stream.write(frame());
    socket.result('the', false, 0.01);
    socket.result('the project', false, 0.02);
    socket.result('the project', true, 0.02);
    expect(new Set(segments.map((s) => s.id)).size).toBe(1);
    stream.write(frame(20000));
    socket.result('Next utterance', false, 0.04);
    expect(segments.at(-1)!.id).not.toBe(segments[0]!.id);
    stream.close();
  });
  it('detects a stalled socket even when backpressure prevents sending captured frames', async () => {
    vi.useFakeTimers();
    const first = new Socket();
    first.bufferedAmount = 600000;
    const getToken = vi.fn(async () => ({
      listenUrl: 'ws://localhost/listen',
      accessToken: 'token',
      keyterms: [],
    }));
    const socket = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockImplementation(() => new Socket());
    const stream = new BrowserSttStream({ source: 'mic', sampleRate: 16000, getToken, socket });
    const errors: string[] = [];
    stream.on('error', (error) => errors.push(error.message));
    await vi.advanceTimersByTimeAsync(0);
    first.open();
    for (let i = 0; i < 35; i++) {
      stream.write(frame(i * 20000));
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(errors).toContain('STT stopped responding; reconnecting with buffered audio.');
    expect(getToken.mock.calls.length).toBeGreaterThan(1);
    stream.close();
  });

  it('paces a long replay under socket backpressure before sending CloseStream', async () => {
    vi.useFakeTimers();
    const socket = new Socket();
    socket.bufferedAmount = 600000;
    const stream = new BrowserSttStream({
      source: 'mic',
      sampleRate: 16000,
      socket: () => socket,
      getToken: async () => ({
        listenUrl: 'ws://localhost/listen',
        accessToken: 'token',
        keyterms: [],
      }),
    });
    for (let i = 0; i < 1000; i++) stream.write(frame(i * 20000));
    await vi.advanceTimersByTimeAsync(0);
    socket.open();
    const finish = stream.finish();
    expect(socket.sent).toHaveLength(0);
    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(250);
    expect(socket.sent.filter((s) => s instanceof Uint8Array)).toHaveLength(1000);
    expect(socket.sent.at(-1)).toBe('{"type":"CloseStream"}');
    socket.result('All buffered speech', true, 20);
    socket.onclose?.();
    await finish;
    expect(stream.status).toBe('closed');
  });

  it('uses fresh bearer grants, replays uncommitted audio after a drop, and maps the original clock', async () => {
    vi.useFakeTimers();
    const sockets: Socket[] = [];
    const connect = vi.fn<(url: string, protocols: string[]) => Socket>(() => {
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    });
    const getToken = vi.fn(async () => ({
      listenUrl: 'ws://localhost/stt/v1/listen',
      accessToken: `grant-${sockets.length}`,
      keyterms: ['Oat'],
    }));
    const stream = new BrowserSttStream({
      source: 'mic',
      sampleRate: 16000,
      getToken,
      socket: connect,
    });
    const segments: SttSegment[] = [];
    stream.on('segment', (s) => segments.push(s));
    stream.write(frame(2000000));
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.open();
    expect(connect.mock.calls[0]).toEqual([
      expect.stringContaining('encoding=linear16'),
      ['bearer', 'grant-0'],
    ]);
    expect(new URL(String(connect.mock.calls[0]?.[0])).searchParams.get('keyterm')).toBe('Oat');
    sockets[0]!.result('draft', false);
    sockets[0]!.onclose?.();
    stream.write(frame(2020000));
    await vi.advanceTimersByTimeAsync(1000);
    expect(getToken).toHaveBeenCalledTimes(2);
    sockets[1]!.open();
    expect(sockets[1]!.sent.filter((s) => s instanceof Uint8Array)).toHaveLength(2);
    sockets[1]!.result('Final words', true, 0.04);
    expect(segments.at(-1)).toMatchObject({
      id: segments[0]!.id,
      startMs: 2000,
      endMs: 2040,
      text: 'Final words',
      isFinal: true,
    });
    const finish = stream.finish();
    expect(sockets[1]!.sent.at(-1)).toBe('{"type":"CloseStream"}');
    sockets[1]!.onclose?.();
    await finish;
    expect(stream.status).toBe('closed');
  });

  it('retracts empty finals and retries a failed token without losing queued frames', async () => {
    vi.useFakeTimers();
    const socket = new Socket();
    const getToken = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ listenUrl: 'ws://localhost/listen', accessToken: 'new', keyterms: [] });
    const stream = new BrowserSttStream({
      source: 'mic',
      sampleRate: 16000,
      getToken,
      socket: () => socket,
    });
    const errors: string[] = [];
    const segments: SttSegment[] = [];
    stream.on('error', (e) => errors.push(e.code));
    stream.on('segment', (s) => segments.push(s));
    stream.write(frame());
    await vi.advanceTimersByTimeAsync(1000);
    expect(errors).toContain('connection');
    socket.open();
    expect(socket.sent).toHaveLength(1);
    socket.result('uncertain', false);
    socket.result('', true);
    expect(segments.at(-1)).toMatchObject({ id: segments[0]!.id, text: '', isFinal: true });
    stream.close();
    await vi.advanceTimersByTimeAsync(20000);
    expect(getToken).toHaveBeenCalledTimes(2);
  });
});
