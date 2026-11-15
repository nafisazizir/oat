/**
 * The index queue: a minimal Redis job queue specialised for "re-index this thing soon" jobs (6.1).
 *
 * Why not BullMQ: what we need is *debounced, deduplicated* jobs keyed by document — the latest change wins and
 * a burst of edits becomes one run — plus retries and crash recovery. That is one sorted set keyed by job id
 * (score = due time) and four short Lua scripts on the `redis` client the app already uses (`@oat/auth`), with
 * no blocking connections (fine on Upstash, D-11) and no second Redis client (ioredis). BullMQ would add both
 * and still need its deduplication/delay options bent into a debounce.
 *
 * Keys (all under `prefix`, default `oat:idx`):
 * - `pending`  ZSET job → due time (ms). `enqueue` debounces: due = min(now + debounce, first + maxWait), so a
 *   steady stream of edits still runs at least every `maxWaitMs`.
 * - `first`    HASH job → time of the first enqueue since the job last ran (the maxWait anchor).
 * - `active`   ZSET job → lease deadline, extended by the running worker (heartbeat). A job whose lease expires
 *   (worker died or hung) goes back to `pending`, or to `failed` if that was its last attempt.
 *   A job that is active is never claimed twice; if it's re-enqueued meanwhile it runs again afterwards.
 * - `owner`    HASH job → token of the current claim; `complete`/`fail`/`extend` only act for that token, so a
 *   worker whose lease expired can't release a job someone else re-claimed.
 * - `attempts` HASH job → claims since the last success. Failure → retry after
 *   `backoffMs · 2^(attempts-1)` (capped); after `maxAttempts` → `failed` (HASH job → last error).
 * - `cursor`   the change-log cursor of the follower (`worker.ts`), `lock:<name>` short-lived locks.
 *
 * Jobs: `document:<id>` (notes + transcript of a document): one key per document, so its work is single-flight.
 */
import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';

/** A connected `redis` (node-redis) client with default modules and RESP version. */
export type Redis = Awaited<ReturnType<typeof connectRedis>>;

/**
 * Connects a client for the worker/CLIs: reconnects with backoff forever, and logs connection errors once per
 * outage instead of crashing on them (node-redis throws on `error` events nobody listens to).
 */
export async function connectRedis(url: string, log: (message: string) => void = console.error) {
  const client = createClient({
    url,
    socket: { reconnectStrategy: (retries) => Math.min(100 * 2 ** retries, 10_000) },
  });
  let reported = false;
  client.on('error', (error) => {
    if (!reported) log(`redis error: ${error instanceof Error ? error.message : String(error)}`);
    reported = true;
  });
  client.on('ready', () => {
    reported = false;
  });
  await client.connect();
  return client;
}

/**
 * `document:<id>` is the only job the follower enqueues (notes + transcript of one document), so all work on
 * a document is single-flight. `meeting:<id>` is still understood (resolved to its document) for keys queued
 * before that rule.
 */
export type IndexJob = { kind: 'document'; id: string } | { kind: 'meeting'; id: string };

export const jobKey = (job: IndexJob) => `${job.kind}:${job.id}`;

export function parseJobKey(key: string): IndexJob {
  const at = key.indexOf(':');
  const kind = key.slice(0, at);
  const id = key.slice(at + 1);
  if ((kind !== 'document' && kind !== 'meeting') || !id) throw new Error(`bad index job "${key}"`);
  return { kind, id };
}

export interface ClaimedJob {
  job: IndexJob;
  key: string;
  /** 1 on the first try. */
  attempt: number;
  /** Proves ownership of this claim: `complete`/`fail`/`extend` are no-ops once someone else holds the job. */
  token: string;
}

export interface QueueStats {
  pending: number;
  active: number;
  failed: number;
}

export interface IndexQueueOptions {
  /** Key prefix; tests use a unique one per run. Default `oat:idx`. */
  prefix?: string;
  /** Wait this long after the last change before running. Default 1500 ms. */
  debounceMs?: number;
  /** …but never longer than this after the first change. Default 10 s. */
  maxWaitMs?: number;
  /** A claimed job not completed (or extended) within this goes back to pending. Default 2 min. */
  leaseMs?: number;
  /** Claims before giving up (failures and expired leases both count). Default 5. */
  maxAttempts?: number;
  /** First retry delay; doubles per attempt. Default 1 s. */
  backoffMs?: number;
  /** Default 5 min. */
  maxBackoffMs?: number;
  /** Clock (tests). */
  now?: () => number;
}

const ENQUEUE = `
local now = tonumber(ARGV[1])
local delay = tonumber(ARGV[2])
local maxWait = tonumber(ARGV[3])
for i = 4, #ARGV do
  local m = ARGV[i]
  local first = tonumber(redis.call('HGET', KEYS[2], m))
  if not first then
    first = now
    redis.call('HSET', KEYS[2], m, now)
  end
  redis.call('ZADD', KEYS[1], math.min(now + delay, first + maxWait), m)
end
return #ARGV - 3`;

/**
 * KEYS: pending, first, active, attempts, failed, owner · ARGV: now, n, lease, maxAttempts, token prefix.
 * Expired leases first: back to pending, or to `failed` when that was the last attempt (a job that kills its
 * worker must not loop forever).
 */
const CLAIM = `
local now = tonumber(ARGV[1])
local n = tonumber(ARGV[2])
local lease = tonumber(ARGV[3])
local maxAttempts = tonumber(ARGV[4])
local expired = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', now)
for _, m in ipairs(expired) do
  redis.call('ZREM', KEYS[3], m)
  redis.call('HDEL', KEYS[6], m)
  local attempts = tonumber(redis.call('HGET', KEYS[4], m)) or 0
  if attempts >= maxAttempts then
    redis.call('HDEL', KEYS[4], m)
    redis.call('HSET', KEYS[5], m, 'lease expired (worker died or hung) on the last attempt')
  else
    redis.call('ZADD', KEYS[1], 'LT', now, m)
  end
end
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, n * 4 + 16)
local out = {}
for i, m in ipairs(due) do
  if #out >= 3 * n then break end
  if not redis.call('ZSCORE', KEYS[3], m) then
    redis.call('ZREM', KEYS[1], m)
    redis.call('HDEL', KEYS[2], m)
    redis.call('ZADD', KEYS[3], now + lease, m)
    local attempt = redis.call('HINCRBY', KEYS[4], m, 1)
    local token = ARGV[5] .. ':' .. i
    redis.call('HSET', KEYS[6], m, token)
    table.insert(out, m)
    table.insert(out, attempt)
    table.insert(out, token)
  end
end
return out`;

/** KEYS: active, attempts, failed, owner · ARGV: job, token. */
const COMPLETE = `
if redis.call('HGET', KEYS[4], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('HDEL', KEYS[3], ARGV[1])
redis.call('HDEL', KEYS[4], ARGV[1])
return 1`;

/** KEYS: pending, active, attempts, failed, owner · ARGV: now, job, maxAttempts, base, cap, error, token. */
const FAIL = `
local now = tonumber(ARGV[1])
local m = ARGV[2]
if redis.call('HGET', KEYS[5], m) ~= ARGV[7] then return -2 end
local maxAttempts = tonumber(ARGV[3])
local base = tonumber(ARGV[4])
local cap = tonumber(ARGV[5])
redis.call('ZREM', KEYS[2], m)
redis.call('HDEL', KEYS[5], m)
local attempts = tonumber(redis.call('HGET', KEYS[3], m)) or 1
if attempts >= maxAttempts then
  redis.call('HDEL', KEYS[3], m)
  redis.call('HSET', KEYS[4], m, ARGV[6])
  return -1
end
local due = now + math.min(base * 2 ^ (attempts - 1), cap)
redis.call('ZADD', KEYS[1], 'LT', due, m)
return due`;

/** KEYS: active, owner · ARGV: job, token, deadline. */
const EXTEND = `
if redis.call('HGET', KEYS[2], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('ZADD', KEYS[1], 'XX', ARGV[3], ARGV[1])
return 1`;

/** Compare-and-extend / compare-and-delete for `acquireLock` tokens. */
const RENEW = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return 0`;
const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

export interface Lock {
  /** Extends the lock; false if it was lost (expired and taken by someone else). */
  renew(): Promise<boolean>;
  release(): Promise<void>;
}

/** Result of `fail`: retry at a time, gave up, or the claim was no longer ours (nothing changed). */
export type FailOutcome = { retryAt: number } | { gaveUp: true } | { stale: true };

export interface IndexQueue {
  readonly prefix: string;
  readonly leaseMs: number;
  enqueue(...jobs: IndexJob[]): Promise<void>;
  /** Due jobs, marked active under a lease with a fresh owner token. At most `n`. */
  claim(n: number): Promise<ClaimedJob[]>;
  /** Finishes a claim. False (and nothing changes) when the claim is no longer ours. */
  complete(job: Pick<ClaimedJob, 'key' | 'token'>): Promise<boolean>;
  /** Schedules a retry, or moves the job to `failed`. A no-op on a claim that is no longer ours. */
  fail(job: Pick<ClaimedJob, 'key' | 'token'>, error: unknown): Promise<FailOutcome>;
  /** Pushes the lease deadline out by `leaseMs` (heartbeat). False when the claim is no longer ours. */
  extend(job: Pick<ClaimedJob, 'key' | 'token'>): Promise<boolean>;
  stats(): Promise<QueueStats>;
  /** Last failure per job that ran out of attempts. */
  failures(): Promise<Record<string, string>>;
  getCursor(): Promise<string | null>;
  setCursor(cursor: string | null): Promise<void>;
  /** A `SET NX PX` lock; null when someone else holds it. */
  acquireLock(name: string, ttlMs: number): Promise<Lock | null>;
  /** Deletes every key of this queue (tests, `--reset`). */
  clear(): Promise<void>;
}

export function createIndexQueue(redis: Redis, options: IndexQueueOptions = {}): IndexQueue {
  const prefix = options.prefix ?? 'oat:idx';
  const debounceMs = options.debounceMs ?? 1500;
  const maxWaitMs = options.maxWaitMs ?? 10_000;
  const leaseMs = options.leaseMs ?? 2 * 60_000;
  const maxAttempts = options.maxAttempts ?? 5;
  const backoffMs = options.backoffMs ?? 1000;
  const maxBackoffMs = options.maxBackoffMs ?? 5 * 60_000;
  const now = options.now ?? Date.now;
  const k = {
    pending: `${prefix}:pending`,
    first: `${prefix}:first`,
    active: `${prefix}:active`,
    attempts: `${prefix}:attempts`,
    failed: `${prefix}:failed`,
    owner: `${prefix}:owner`,
    cursor: `${prefix}:cursor`,
    lock: (name: string) => `${prefix}:lock:${name}`,
  };

  return {
    prefix,
    leaseMs,
    async enqueue(...jobs) {
      if (jobs.length === 0) return;
      const keys = [...new Set(jobs.map(jobKey))];
      await redis.eval(ENQUEUE, {
        keys: [k.pending, k.first],
        arguments: [String(now()), String(debounceMs), String(maxWaitMs), ...keys],
      });
    },
    async claim(n) {
      if (n <= 0) return [];
      const reply = (await redis.eval(CLAIM, {
        keys: [k.pending, k.first, k.active, k.attempts, k.failed, k.owner],
        arguments: [String(now()), String(n), String(leaseMs), String(maxAttempts), randomUUID()],
      })) as unknown as (string | number)[];
      const out: ClaimedJob[] = [];
      for (let i = 0; i < reply.length; i += 3) {
        const key = String(reply[i]);
        out.push({
          key,
          job: parseJobKey(key),
          attempt: Number(reply[i + 1]),
          token: String(reply[i + 2]),
        });
      }
      return out;
    },
    async complete({ key, token }) {
      const r = await redis.eval(COMPLETE, {
        keys: [k.active, k.attempts, k.failed, k.owner],
        arguments: [key, token],
      });
      return Number(r) === 1;
    },
    async fail({ key, token }, error) {
      const message = error instanceof Error ? error.message : String(error);
      const due = Number(
        await redis.eval(FAIL, {
          keys: [k.pending, k.active, k.attempts, k.failed, k.owner],
          arguments: [
            String(now()),
            key,
            String(maxAttempts),
            String(backoffMs),
            String(maxBackoffMs),
            message.slice(0, 2000),
            token,
          ],
        }),
      );
      if (due === -2) return { stale: true };
      if (due === -1) return { gaveUp: true };
      return { retryAt: due };
    },
    async extend({ key, token }) {
      const r = await redis.eval(EXTEND, {
        keys: [k.active, k.owner],
        arguments: [key, token, String(now() + leaseMs)],
      });
      return Number(r) === 1;
    },
    async stats() {
      const [pending, active, failed] = await Promise.all([
        redis.zCard(k.pending),
        redis.zCard(k.active),
        redis.hLen(k.failed),
      ]);
      return { pending, active, failed };
    },
    async failures() {
      return redis.hGetAll(k.failed);
    },
    async getCursor() {
      return (await redis.get(k.cursor)) ?? null;
    },
    async setCursor(cursor) {
      if (cursor === null) await redis.del(k.cursor);
      else await redis.set(k.cursor, cursor);
    },
    async acquireLock(name, ttlMs) {
      const token = randomUUID();
      const key = k.lock(name);
      const ok = await redis.set(key, token, {
        condition: 'NX',
        expiration: { type: 'PX', value: ttlMs },
      });
      if (ok !== 'OK') return null;
      return {
        async renew() {
          const r = await redis.eval(RENEW, { keys: [key], arguments: [token, String(ttlMs)] });
          return Number(r) === 1;
        },
        async release() {
          await redis.eval(RELEASE, { keys: [key], arguments: [token] });
        },
      };
    },
    async clear() {
      const keys: string[] = [];
      for await (const batch of redis.scanIterator({ MATCH: `${prefix}:*`, COUNT: 200 })) {
        keys.push(...(Array.isArray(batch) ? batch : [batch]));
      }
      if (keys.length > 0) await redis.del(keys);
    },
  };
}
