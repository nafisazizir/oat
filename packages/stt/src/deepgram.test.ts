import { describe, expect, it } from 'vitest';

import { DeepgramProvider } from './deepgram.ts';
import { record } from './test-utils.ts';

// Behaviour that needs no server. Everything that talks to a socket is in deepgram.int.test.ts.

const waitFor = async (check: () => boolean, ms = 2_000) => {
  const until = performance.now() + ms;
  while (!check()) {
    if (performance.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('DeepgramProvider (no network)', () => {
  it('retries a failing getToken with backoff, then gives up with a fatal error', async () => {
    let calls = 0;
    const provider = new DeepgramProvider({
      url: 'ws://127.0.0.1:9/never-dialled',
      getToken: () => {
        calls++;
        return Promise.reject(new Error('backend down'));
      },
      reconnect: { initialDelayMs: 1, maxDelayMs: 2, maxAttempts: 2 },
    });
    const rec = record(provider.openStream({ source: 'mic', sampleRate: 16_000 }));
    await waitFor(() => rec.stream.status === 'error');
    expect(calls).toBe(3);
    expect(rec.statuses).toEqual(['connecting', 'reconnecting', 'error']);
    expect(rec.errors.map((e) => [e.code, e.fatal])).toEqual([
      ['token', false],
      ['token', false],
      ['token', false],
      ['connection', true],
    ]);
    expect(rec.errors[0]!.message).toMatch(/backend down/);
    await rec.stream.finish(); // resolves on a terminated stream
  });

  it('close() while connecting cancels the attempt', async () => {
    let resolveToken!: (t: { token: string }) => void;
    const provider = new DeepgramProvider({
      url: 'ws://127.0.0.1:9/never-dialled',
      getToken: () => new Promise((r) => (resolveToken = r)),
    });
    const rec = record(provider.openStream({ source: 'system', sampleRate: 16_000 }));
    await waitFor(() => resolveToken !== undefined);
    rec.stream.close();
    resolveToken({ token: 't' });
    await new Promise((r) => setTimeout(r, 20));
    expect(rec.statuses).toEqual(['connecting', 'closed']);
    expect(rec.errors).toEqual([]);
  });
});
