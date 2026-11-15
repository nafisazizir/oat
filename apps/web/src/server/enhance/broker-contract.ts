/**
 * Behaviour every `EnhanceBroker` must have, run against the in-memory one (unit) and Redis (int). Test-only.
 */
import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import type { EnhanceEvent, EnhancementDto } from '@/lib/enhance';

import type { EnhanceBroker, StoredEvent } from './broker';

const preview = (n: number): EnhanceEvent => ({
  type: 'preview',
  output: { sections: [{ heading: `S${n}`, blocks: [] }] },
});

const dto = { id: 'e', status: 'completed' } as EnhancementDto;
const completed: EnhanceEvent = { type: 'completed', enhancement: dto, doc: { type: 'doc' } };

async function collect(iterable: AsyncIterable<StoredEvent>): Promise<StoredEvent[]> {
  const out: StoredEvent[] = [];
  for await (const e of iterable) out.push(e);
  return out;
}

export function brokerContract(make: () => EnhanceBroker) {
  it('locks per document for its owner until unlocked or expired', async () => {
    const broker = make();
    const doc = randomUUID();
    expect(await broker.lock(doc, 'a', 10_000)).toBe(true);
    expect(await broker.lock(doc, 'b', 10_000)).toBe(false);
    expect(await broker.lock(doc, 'a', 10_000)).toBe(true); // re-entrant for the owner
    await broker.unlock(doc, 'b'); // not the owner: no effect
    expect(await broker.lock(doc, 'b', 10_000)).toBe(false);
    await broker.unlock(doc, 'a');
    expect(await broker.lock(doc, 'b', 50)).toBe(true);
    await new Promise((r) => setTimeout(r, 120));
    expect(await broker.lock(doc, 'c', 10_000)).toBe(true);
    expect(await broker.holder(doc)).toBe('c');
    // Take-over only from the named (dead) owner.
    expect(await broker.lock(doc, 'd', 10_000, { takeOverFrom: 'x' })).toBe(false);
    expect(await broker.lock(doc, 'd', 10_000, { takeOverFrom: 'c' })).toBe(true);
    expect(await broker.holder(doc)).toBe('d');
    await broker.unlock(doc, 'd');
    expect(await broker.holder(doc)).toBeNull();
    await broker.close();
  });

  it('replays the newest preview + terminal event, and resumes after an id', async () => {
    const broker = make();
    const run = randomUUID();
    const ids = [];
    for (let n = 1; n <= 3; n++) ids.push(await broker.publish(run, preview(n)));
    // A reader resuming after an older id gets the newest snapshot (previews replace each other).
    const early = new AbortController();
    for await (const e of broker.subscribe(run, ids[0]!, early.signal)) {
      expect(e).toEqual({ id: ids[2], event: preview(3) });
      early.abort();
    }
    const all = await (async () => {
      const abort = new AbortController();
      const got: StoredEvent[] = [];
      const done = (async () => {
        for await (const e of broker.subscribe(run, null, abort.signal)) {
          got.push(e);
          if (got.length === 1) await broker.publish(run, completed);
        }
      })();
      await done;
      return got;
    })();
    // Compacted backlog: only the newest preview, then the terminal event, then the iterator ends.
    expect(all.map((e) => e.event)).toEqual([preview(3), completed]);
    expect(all[0]!.id).toBe(ids[2]);

    // Resuming after the newest preview yields only the terminal event.
    expect(
      (await collect(broker.subscribe(run, ids[2]!, new AbortController().signal))).map(
        (e) => e.event,
      ),
    ).toEqual([completed]);
    // Once finished, the terminal event (which carries the whole result) replaces the previews.
    expect(
      (await collect(broker.subscribe(run, ids[0]!, new AbortController().signal))).map(
        (e) => e.event,
      ),
    ).toEqual([completed]);
    await broker.close();
  });

  it('delivers live events to a waiting reader and stops on abort', async () => {
    const broker = make();
    const run = randomUUID();
    const abort = new AbortController();
    const got: StoredEvent[] = [];
    const reading = (async () => {
      for await (const e of broker.subscribe(run, null, abort.signal)) got.push(e);
    })();
    await new Promise((r) => setTimeout(r, 50));
    await broker.publish(run, preview(1));
    await expect.poll(() => got.length, { timeout: 3000 }).toBe(1);
    abort.abort();
    await reading;
    expect(got[0]!.event).toEqual(preview(1));
    await broker.close();
  });
}
