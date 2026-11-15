/**
 * Cross-instance coordination for enhancement jobs (D-20): a per-document run lock and a resumable event log
 * per enhancement that SSE readers replay from `Last-Event-ID`. Redis in the app (`REDIS_URL`: compose Redis in
 * dev, managed Redis in prod), so the job can run on one server instance while the stream is read on another;
 * in-memory for unit tests.
 *
 * The log is compacted: `preview` events are full snapshots of the output so far, so only the newest preview
 * and the terminal event (`completed` / `failed`) are kept. A reader that resumes after any older id gets the
 * newest snapshot, then the rest live.
 */
import { createClient } from 'redis';

import type { EnhanceEvent } from '../dto/enhance.ts';

export interface StoredEvent {
  /** Opaque, increasing per enhancement (the SSE `id`). */
  id: string;
  event: EnhanceEvent;
}

export interface EnhanceBroker {
  /**
   * Takes the per-document run lock for `ttlMs` unless someone else holds it. `takeOverFrom`: also take it if
   * exactly that owner holds it (the caller checked that owner's run is dead); atomic compare-and-set.
   */
  lock(
    documentId: string,
    owner: string,
    ttlMs: number,
    options?: { takeOverFrom?: string },
  ): Promise<boolean>;
  /** Who holds the lock (`null` if nobody). */
  holder(documentId: string): Promise<string | null>;
  /** Releases the lock if `owner` still holds it. */
  unlock(documentId: string, owner: string): Promise<void>;
  publish(enhancementId: string, event: EnhanceEvent): Promise<string>;
  /**
   * Events after `afterId` (all retained ones when `null`), then new ones as they are published, until a
   * terminal event has been yielded or `signal` aborts.
   */
  subscribe(
    enhancementId: string,
    afterId: string | null,
    signal: AbortSignal,
  ): AsyncIterable<StoredEvent>;
  close(): Promise<void>;
}

/** How long an enhancement's events are kept after the last one (readers re-attach within this window). */
export const EVENT_TTL_SECONDS = 60 * 60;

export const isTerminal = (event: EnhanceEvent) =>
  event.type === 'completed' || event.type === 'failed';

// ---------------------------------------------------------------------------------------------------------
// In memory
// ---------------------------------------------------------------------------------------------------------

/** Per-process broker: fine for tests and a single dev server; not shared between instances. */
export function createMemoryBroker(): EnhanceBroker {
  const locks = new Map<string, { owner: string; until: number }>();
  const logs = new Map<string, { seq: number; kept: StoredEvent[]; waiters: Set<() => void> }>();
  const log = (id: string) => {
    let l = logs.get(id);
    if (!l) logs.set(id, (l = { seq: 0, kept: [], waiters: new Set() }));
    return l;
  };
  return {
    async lock(documentId, owner, ttlMs, options) {
      const held = locks.get(documentId);
      const live = held && held.until > Date.now();
      if (live && held.owner !== owner && held.owner !== options?.takeOverFrom) return false;
      locks.set(documentId, { owner, until: Date.now() + ttlMs });
      return true;
    },
    async holder(documentId) {
      const held = locks.get(documentId);
      return held && held.until > Date.now() ? held.owner : null;
    },
    async unlock(documentId, owner) {
      if (locks.get(documentId)?.owner === owner) locks.delete(documentId);
    },
    async publish(enhancementId, event) {
      const l = log(enhancementId);
      const stored = { id: String(++l.seq), event };
      // Compaction: a new event replaces older previews.
      l.kept = [...l.kept.filter((e) => e.event.type !== 'preview'), stored];
      for (const wake of l.waiters) wake();
      return stored.id;
    },
    async *subscribe(enhancementId, afterId, signal) {
      const l = log(enhancementId);
      let last = Number(afterId ?? 0) || 0;
      while (!signal.aborted) {
        // Re-read after every yield: events published while the reader was busy aren't missed.
        const next = l.kept.find((e) => Number(e.id) > last);
        if (next) {
          last = Number(next.id);
          yield next;
          if (isTerminal(next.event)) return;
          continue;
        }
        await new Promise<void>((resolve) => {
          const done = () => {
            l.waiters.delete(done);
            signal.removeEventListener('abort', done);
            resolve();
          };
          l.waiters.add(done);
          signal.addEventListener('abort', done, { once: true });
        });
      }
    },
    async close() {
      locks.clear();
      logs.clear();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------------------------------------

function newClient(url: string) {
  // RESP2: plain array replies for the raw stream commands below.
  return createClient({ url, RESP: 2 });
}
type Client = ReturnType<typeof newClient>;

const lockKey = (documentId: string) => `oat:enh:lock:${documentId}`;
const streamKey = (enhancementId: string) => `oat:enh:events:${enhancementId}`;

/** SET if free, or held by ARGV[1] (owner, re-entrant) or ARGV[3] (the owner being taken over from). */
const LOCK_SCRIPT = `local cur = redis.call('GET', KEYS[1])
if cur == false or cur == ARGV[1] or (ARGV[3] ~= '' and cur == ARGV[3]) then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 1
end
return 0`;

const UNLOCK_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

/** XADD, then drop older previews (keep the newest entry + any terminal one), then refresh the TTL. */
const PUBLISH_SCRIPT = `local id = redis.call('XADD', KEYS[1], '*', 'e', ARGV[1])
local entries = redis.call('XRANGE', KEYS[1], '-', '+')
for i = 1, #entries - 1 do
  local entry = entries[i]
  if entry[2][2] and string.find(entry[2][2], '"type":"preview"', 1, true) then
    redis.call('XDEL', KEYS[1], entry[1])
  end
end
redis.call('EXPIRE', KEYS[1], ARGV[2])
return id`;

type StreamEntries = Array<[id: string, fields: string[]]>;
type XReadReply = Array<[key: string, entries: StreamEntries]> | null;

function parseEntries(entries: StreamEntries): StoredEvent[] {
  return entries.flatMap(([id, fields]) => {
    const raw = fields[fields.indexOf('e') + 1];
    try {
      return raw ? [{ id, event: JSON.parse(raw) as EnhanceEvent }] : [];
    } catch {
      return [];
    }
  });
}

/**
 * Redis broker: `SET NX PX` lock with a compare-and-delete unlock, and a Redis Stream per enhancement (`XADD`;
 * readers `XRANGE` the backlog, then `XREAD BLOCK` on a dedicated connection). One shared connection for
 * commands, created lazily.
 */
export function createRedisBroker(redisUrl: string): EnhanceBroker {
  let shared: Promise<Client> | undefined;
  const connect = async (): Promise<Client> => {
    const client = newClient(redisUrl);
    client.on('error', (error) => console.warn('enhance broker: redis error', error));
    await client.connect();
    return client;
  };
  const client = () => {
    shared ??= connect().catch((error: unknown) => {
      shared = undefined;
      throw error;
    });
    return shared;
  };
  const send = async <T>(args: string[]): Promise<T> =>
    (await client()).sendCommand(args) as unknown as Promise<T>;

  return {
    async lock(documentId, owner, ttlMs, options) {
      const reply = await send<number>([
        'EVAL',
        LOCK_SCRIPT,
        '1',
        lockKey(documentId),
        owner,
        String(Math.max(1, Math.round(ttlMs))),
        options?.takeOverFrom ?? '',
      ]);
      return Number(reply) === 1;
    },
    async holder(documentId) {
      return send<string | null>(['GET', lockKey(documentId)]);
    },
    async unlock(documentId, owner) {
      await send(['EVAL', UNLOCK_SCRIPT, '1', lockKey(documentId), owner]);
    },
    async publish(enhancementId, event) {
      return send<string>([
        'EVAL',
        PUBLISH_SCRIPT,
        '1',
        streamKey(enhancementId),
        JSON.stringify(event),
        String(EVENT_TTL_SECONDS),
      ]);
    },
    async *subscribe(enhancementId, afterId, signal) {
      const key = streamKey(enhancementId);
      const backlog = parseEntries(
        await send<StreamEntries>(['XRANGE', key, afterId ? `(${afterId}` : '-', '+']),
      );
      let last = afterId ?? '0-0';
      for (const stored of backlog) {
        last = stored.id;
        yield stored;
        if (isTerminal(stored.event)) return;
      }
      // Blocking reads tie up a connection: give this reader its own.
      const reader = await connect();
      const stop = () => void reader.destroy();
      signal.addEventListener('abort', stop, { once: true });
      try {
        while (!signal.aborted) {
          let reply: XReadReply;
          try {
            reply = (await reader.sendCommand([
              'XREAD',
              'BLOCK',
              '5000',
              'STREAMS',
              key,
              last,
            ])) as unknown as XReadReply;
          } catch (error) {
            if (signal.aborted) return;
            throw error;
          }
          for (const stored of parseEntries(reply?.[0]?.[1] ?? [])) {
            last = stored.id;
            yield stored;
            if (isTerminal(stored.event)) return;
          }
        }
      } finally {
        signal.removeEventListener('abort', stop);
        if (reader.isOpen) reader.destroy();
      }
    },
    async close() {
      const c = shared;
      shared = undefined;
      (await c?.catch(() => undefined))?.destroy();
    },
  };
}
