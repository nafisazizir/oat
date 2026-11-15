/** The Redis index queue against the compose Redis (shared: every test uses its own key prefix). */
import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { indexingConfig } from './env.ts';
import { createIndexQueue, type IndexQueue, type IndexQueueOptions, type Redis } from './queue.ts';

let redis: Redis;
const queues: IndexQueue[] = [];
let clock = 1_000_000;

beforeAll(async () => {
  redis = createClient({ url: indexingConfig().redisUrl });
  await redis.connect();
});
afterEach(async () => {
  await Promise.all(queues.splice(0).map((q) => q.clear()));
});
afterAll(() => redis?.destroy());

function queue(options: IndexQueueOptions = {}, prefix = `oat-test:idx:${randomUUID()}`) {
  const q = createIndexQueue(redis, {
    prefix,
    debounceMs: 1000,
    maxWaitMs: 5000,
    leaseMs: 30_000,
    backoffMs: 100,
    maxBackoffMs: 400,
    maxAttempts: 3,
    now: () => clock,
    ...options,
  });
  queues.push(q);
  return q;
}
const doc = (id: string) => ({ kind: 'document' as const, id });
const keys = (claimed: { key: string }[]) => claimed.map((c) => c.key);

describe('index queue', () => {
  it('debounces: repeated enqueues are one job, due after the last one', async () => {
    const q = queue();
    await q.enqueue(doc('a'), doc('a'));
    clock += 800;
    await q.enqueue(doc('a'));
    clock += 800; // 1600 after the first, 800 after the last
    expect(await q.claim(5)).toEqual([]);
    clock += 300;
    const claimed = await q.claim(5);
    expect(claimed).toEqual([
      { key: 'document:a', job: doc('a'), attempt: 1, token: expect.any(String) },
    ]);
    expect(await q.stats()).toEqual({ pending: 0, active: 1, failed: 0 });
    expect(await q.complete(claimed[0]!)).toBe(true);
    expect(await q.stats()).toEqual({ pending: 0, active: 0, failed: 0 });
  });

  it('runs a continuously edited job at least every maxWait', async () => {
    const q = queue();
    for (let t = 0; t < 6000; t += 500) {
      await q.enqueue(doc('busy'));
      clock += 500;
      if (t >= 5000) break;
    }
    expect(keys(await q.claim(1))).toEqual(['document:busy']);
  });

  it('never runs a job twice at once; a change during a run schedules another run', async () => {
    const q = queue({ debounceMs: 0 });
    await q.enqueue(doc('x'), doc('y'));
    const first = await q.claim(5);
    expect(keys(first).sort()).toEqual(['document:x', 'document:y']);
    await q.enqueue(doc('x'));
    expect(await q.claim(5)).toEqual([]); // still active
    await q.complete(first.find((c) => c.key === 'document:x')!);
    expect(keys(await q.claim(5))).toEqual(['document:x']);
  });

  it('retries with exponential backoff, then gives up into failed', async () => {
    const q = queue({ debounceMs: 0 });
    await q.enqueue(doc('bad'));
    let [job] = await q.claim(1);
    expect(job!.attempt).toBe(1);
    expect(await q.fail(job!, new Error('boom 1'))).toEqual({ retryAt: clock + 100 });
    clock += 99;
    expect(await q.claim(1)).toEqual([]);
    clock += 1;
    [job] = await q.claim(1);
    expect(job!.attempt).toBe(2);
    expect(await q.fail(job!, new Error('boom 2'))).toEqual({ retryAt: clock + 200 });
    clock += 200;
    [job] = await q.claim(1);
    expect(job!.attempt).toBe(3);
    expect(await q.fail(job!, new Error('boom 3'))).toEqual({ gaveUp: true });
    expect(await q.stats()).toEqual({ pending: 0, active: 0, failed: 1 });
    expect(await q.failures()).toEqual({ 'document:bad': 'boom 3' });
    // A new change gives it a fresh start; success clears the failure.
    await q.enqueue(doc('bad'));
    [job] = await q.claim(1);
    expect(job!.attempt).toBe(1);
    await q.complete(job!);
    expect(await q.failures()).toEqual({});
  });

  it('puts a job whose worker died (lease expired) back in line', async () => {
    const q = queue({ debounceMs: 0, leaseMs: 1000 });
    await q.enqueue(doc('orphan'));
    expect(await q.claim(1)).toHaveLength(1);
    clock += 999;
    expect(await q.claim(1)).toEqual([]);
    clock += 2;
    expect(await q.claim(1)).toEqual([
      { key: 'document:orphan', job: doc('orphan'), attempt: 2, token: expect.any(String) },
    ]);
  });

  it('sends a job that keeps killing its worker to failed after maxAttempts lease expiries', async () => {
    const q = queue({ debounceMs: 0, leaseMs: 1000, maxAttempts: 3 });
    await q.enqueue(doc('poison'));
    for (let attempt = 1; attempt <= 3; attempt++) {
      const [job] = await q.claim(1);
      expect(job!.attempt).toBe(attempt);
      clock += 1001; // the worker died: no complete, no fail
    }
    expect(await q.claim(1)).toEqual([]);
    expect(await q.stats()).toEqual({ pending: 0, active: 0, failed: 1 });
    expect((await q.failures())['document:poison']).toMatch(/lease expired/);
  });

  it('two workers: a stale owner cannot complete, fail or extend a job someone else re-claimed', async () => {
    const prefix = `oat-test:idx:${randomUUID()}`;
    const a = queue({ debounceMs: 0, leaseMs: 1000 }, prefix);
    const b = queue({ debounceMs: 0, leaseMs: 1000 }, prefix);
    await a.enqueue(doc('shared'));
    const [jobA] = await a.claim(1);
    clock += 500;
    expect(await a.extend(jobA!)).toBe(true); // heartbeat: now due at +1500
    clock += 999;
    expect(await b.claim(1)).toEqual([]); // still A's
    clock += 2; // A hangs past its lease
    const [jobB] = await b.claim(1);
    expect(jobB!.attempt).toBe(2);
    expect(jobB!.token).not.toBe(jobA!.token);

    // A wakes up: none of its calls touch B's claim.
    expect(await a.complete(jobA!)).toBe(false);
    expect(await a.fail(jobA!, new Error('late'))).toEqual({ stale: true });
    expect(await a.extend(jobA!)).toBe(false);
    expect(await a.stats()).toEqual({ pending: 0, active: 1, failed: 0 });
    await a.enqueue(doc('shared'));
    expect(await a.claim(1)).toEqual([]); // B still holds it: no third concurrent run
    expect(await b.complete(jobB!)).toBe(true);
    expect(keys(await a.claim(1))).toEqual(['document:shared']); // the change made meanwhile
  });

  it('stores the follower cursor and hands a lock to one holder at a time', async () => {
    const q = queue();
    expect(await q.getCursor()).toBeNull();
    await q.setCursor('12.34');
    expect(await q.getCursor()).toBe('12.34');
    const a = await q.acquireLock('follower', 10_000);
    expect(a).not.toBeNull();
    expect(await q.acquireLock('follower', 10_000)).toBeNull();
    expect(await a!.renew()).toBe(true);
    await a!.release();
    const b = await q.acquireLock('follower', 10_000);
    expect(b).not.toBeNull();
    expect(await a!.renew()).toBe(false); // a's token no longer owns it
    await b!.release();
  });

  it('clear() removes only its own keys', async () => {
    const mine = queue();
    const other = queue();
    await mine.enqueue(doc('1'));
    await other.enqueue(doc('2'));
    await mine.clear();
    expect((await mine.stats()).pending).toBe(0);
    expect((await other.stats()).pending).toBe(1);
  });
});
