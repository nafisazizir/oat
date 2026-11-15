import { type AddressInfo, createServer, type Socket } from 'node:net';

import { describe, expect, it } from 'vitest';

import { createMemoryRateLimiter, createRedisRateLimiter } from './rate-limit.ts';

describe('memory rate limiter', () => {
  it('allows `limit` hits per window, then refuses until the window resets', async () => {
    let t = 0;
    const limiter = createMemoryRateLimiter(() => t);
    const results = [];
    for (let i = 0; i < 4; i++) results.push((await limiter.hit('k', 3, 60)).allowed);
    expect(results).toEqual([true, true, true, false]);
    expect((await limiter.hit('other', 3, 60)).allowed).toBe(true);
    t += 30_000;
    expect(await limiter.hit('k', 3, 60)).toMatchObject({ allowed: false, retryAfter: 30 });
    t += 30_000;
    expect(await limiter.hit('k', 3, 60)).toMatchObject({ allowed: true, count: 1 });
  });
});

describe('redis rate limiter', () => {
  it('fails open, fast, and reports once when Redis is unreachable', async () => {
    const errors: unknown[] = [];
    // Nothing listens on port 1: every connect attempt is refused.
    const limiter = createRedisRateLimiter('redis://127.0.0.1:1', {
      timeoutMs: 300,
      onError: (e) => errors.push(e),
    });
    try {
      const started = Date.now();
      expect(await limiter.hit('k', 1, 60)).toMatchObject({ allowed: true });
      expect(await limiter.hit('k', 1, 60)).toMatchObject({ allowed: true });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(errors).toHaveLength(1);
    } finally {
      await limiter.close();
    }
  });

  it('fails open when Redis accepts but never answers (timeout)', async () => {
    // A local TCP server that accepts connections and stays silent.
    const sockets: Socket[] = [];
    const server = createServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const errors: unknown[] = [];
    const limiter = createRedisRateLimiter(`redis://127.0.0.1:${port}`, {
      timeoutMs: 300,
      onError: (e) => errors.push(e),
    });
    try {
      const started = Date.now();
      expect(await limiter.hit('k', 1, 60)).toMatchObject({ allowed: true });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      await limiter.close();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
