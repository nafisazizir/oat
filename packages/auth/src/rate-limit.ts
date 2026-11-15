/**
 * Fixed-window counters for abuse limits that must hold across server instances (the per-email
 * magic-link limit). Redis-backed (`REDIS_URL`: the compose Redis in dev, Upstash/managed Redis in prod)
 * through the official `redis` client, with an in-memory fallback for tests and a missing `REDIS_URL`.
 */
import { createHash } from 'node:crypto';

import { createClient } from 'redis';

export interface RateLimitResult {
  allowed: boolean;
  /** Hits in the current window, including this one. */
  count: number;
  /** Seconds until the window resets. */
  retryAfter: number;
}

export interface RateLimiter {
  /** Counts one hit on `key`; `allowed` is false once more than `limit` hits land in `windowSec`. */
  hit(key: string, limit: number, windowSec: number): Promise<RateLimitResult>;
  /** Releases connections (tests, shutdown). */
  close(): Promise<void>;
}

/** Per-process counters. Fine for tests and single-instance dev; not shared between instances. */
export function createMemoryRateLimiter(now: () => number = Date.now): RateLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    async hit(key, limit, windowSec) {
      const t = now();
      let w = windows.get(key);
      if (!w || w.resetAt <= t) {
        w = { count: 0, resetAt: t + windowSec * 1000 };
        windows.set(key, w);
      }
      w.count += 1;
      if (windows.size > 10_000) {
        for (const [k, v] of windows) if (v.resetAt <= t) windows.delete(k);
      }
      return {
        allowed: w.count <= limit,
        count: w.count,
        retryAfter: Math.max(1, Math.ceil((w.resetAt - t) / 1000)),
      };
    },
    async close() {},
  };
}

/** INCR + set the window's expiry on the first hit, atomically; returns [count, ttl seconds]. */
const HIT_SCRIPT = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) ttl = tonumber(ARGV[1]) end
return {n, ttl}`;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`redis ${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Redis-backed limiter over one lazily connected client. Keys are hashed (no email addresses in Redis)
 * and prefixed `oat:rl:`. Fails open: if Redis is down, slow or unreachable the hit is allowed and
 * `onError` is told (once per outage), because sign-in must not depend on Redis and Better Auth's per-IP
 * limit still applies. Every wait (connect, command) is bounded by `timeoutMs`; the offline queue is
 * off, so commands fail fast while the client reconnects in the background.
 */
export function createRedisRateLimiter(
  redisUrl: string,
  options: { timeoutMs?: number; onError?: (error: unknown) => void; namespace?: string } = {},
): RateLimiter {
  const {
    timeoutMs = 1000,
    onError = (e) => console.warn('rate limit: redis unavailable', e),
    // Isolates counters of parallel test servers that share one dev Redis (e.g. per-IP limits on 127.0.0.1).
    namespace = process.env.OAT_RATE_LIMIT_NAMESPACE,
  } = options;
  const prefix = namespace ? `oat:rl:${namespace}:` : 'oat:rl:';
  let client: ReturnType<typeof createClient> | undefined;
  let connecting: Promise<unknown> | undefined;
  let reportedDown = false;
  const report = (error: unknown) => {
    if (!reportedDown) onError(error);
    reportedDown = true;
  };

  function ensureClient() {
    if (!client) {
      client = createClient({
        url: redisUrl,
        disableOfflineQueue: true,
        socket: {
          connectTimeout: timeoutMs,
          reconnectStrategy: (retries) => Math.min(100 * 2 ** retries, 10_000),
        },
      });
      // node-redis throws on connection errors unless someone listens.
      client.on('error', report);
      client.on('ready', () => {
        reportedDown = false;
      });
      connecting = client.connect();
      connecting.catch(() => {});
    }
    return client;
  }

  return {
    async hit(key, limit, windowSec) {
      const hashed = createHash('sha256').update(key).digest('base64url');
      try {
        const c = ensureClient();
        if (!c.isReady) await withTimeout(connecting!, timeoutMs, 'connect');
        const reply = await withTimeout(
          c.eval(HIT_SCRIPT, { keys: [`${prefix}${hashed}`], arguments: [String(windowSec)] }),
          timeoutMs,
          'EVAL',
        );
        const [count, ttl] = reply as unknown as [number, number];
        return { allowed: count <= limit, count, retryAfter: Math.max(1, ttl) };
      } catch (error) {
        report(error);
        return { allowed: true, count: 0, retryAfter: 0 };
      }
    },
    async close() {
      const c = client;
      client = undefined;
      c?.destroy();
    },
  };
}

/** Redis when `redisUrl` is set, else in-memory. */
export function createRateLimiter(redisUrl: string | undefined): RateLimiter {
  return redisUrl ? createRedisRateLimiter(redisUrl) : createMemoryRateLimiter();
}
