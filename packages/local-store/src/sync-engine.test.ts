import type {
  SyncDocumentRow,
  SyncPullChange,
  SyncPullResponse,
  SyncPushEntry,
  SyncPushRequest,
  SyncPushResponse,
  SyncPushResult,
  SyncSegmentRow,
} from '@oat/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalStore } from './store.ts';
import { SyncEngine, type SyncStatus, SyncTransportError } from './sync-engine.ts';

/**
 * A small in-memory stand-in for the server's push/pull semantics (the real thing is covered by the web
 * app's `sync.int.test.ts`): document versions with stale-base conflicts and idempotent replays,
 * segments insert-or-replace within their meeting, a change log for pulls.
 */
class FakeServer {
  docs = new Map<string, SyncDocumentRow>();
  meetings = new Map<string, { id: string; documentId: string }>();
  segments = new Map<string, SyncSegmentRow>();
  log: { table: 'document' | 'transcript_segment' | 'workspace'; id: string }[] = [
    { table: 'workspace', id: 'ws' },
  ];
  pushes = 0;

  push({ entries }: SyncPushRequest): SyncPushResponse {
    this.pushes += 1;
    return { results: entries.map((e) => this.#apply(e)) };
  }

  #apply(e: SyncPushEntry): SyncPushResult {
    const ok = { version: e.version, status: 'ok' as const };
    if (e.op === 'delete') {
      if (e.table === 'transcript_segment' && this.segments.delete(e.id)) {
        this.log.push({ table: 'transcript_segment', id: e.id });
      }
      return ok;
    }
    switch (e.table) {
      case 'document': {
        const cur = this.docs.get(e.row.id);
        const at = '2026-11-14T10:00:00.000Z';
        if (!cur) {
          const row: SyncDocumentRow = {
            ...e.row,
            folderId: null,
            ownerId: 'u1',
            visibility: 'private',
            version: 0,
            createdAt: at,
            updatedAt: at,
            deletedAt: null,
          };
          this.docs.set(row.id, row);
          this.log.push({ table: 'document', id: row.id });
          return { ...ok, row };
        }
        const same = cur.title === e.row.title;
        if (cur.version !== e.baseVersion) {
          return same ? { ...ok, row: cur } : { version: e.version, status: 'conflict', row: cur };
        }
        const row = { ...cur, title: e.row.title, version: cur.version + 1 };
        this.docs.set(row.id, row);
        this.log.push({ table: 'document', id: row.id });
        return { ...ok, row };
      }
      case 'meeting':
        if (!this.docs.has(e.row.documentId)) {
          return { version: e.version, status: 'rejected', code: 'not_found', message: 'no doc' };
        }
        this.meetings.set(e.row.id, { id: e.row.id, documentId: e.row.documentId });
        return ok;
      case 'participant':
        return ok;
      case 'transcript_segment': {
        if (!this.meetings.has(e.row.meetingId)) {
          return { version: e.version, status: 'rejected', code: 'not_found', message: 'no mtg' };
        }
        const cur = this.segments.get(e.row.id);
        if (cur && cur.meetingId !== e.row.meetingId) {
          return { version: e.version, status: 'rejected', code: 'invalid', message: 'spoof' };
        }
        this.segments.set(e.row.id, e.row);
        this.log.push({ table: 'transcript_segment', id: e.row.id });
        return ok;
      }
    }
  }

  pull(cursor: string | null): SyncPullResponse {
    const from = cursor === null ? 0 : Number(cursor);
    const slice = this.log.slice(from, from + 3);
    const changes: SyncPullChange[] = slice.map(({ table, id }) => {
      if (table === 'workspace') {
        return { op: 'upsert', table, row: { id: 'ws', name: 'Me', kind: 'personal' } };
      }
      if (table === 'document') return { op: 'upsert', table, row: this.docs.get(id)! };
      const s = this.segments.get(id);
      return s ? { op: 'upsert', table, row: s } : { op: 'delete', table, id };
    });
    const next = from + slice.length;
    return {
      changes,
      cursor: String(next),
      hasMore: next < this.log.length,
      workspaceIds: ['ws'],
    };
  }
}

type Fault = 'none' | 'offline' | 'lost-response' | 'server-error';

let server: FakeServer;
let store: LocalStore;
let fault: () => Fault;
let statuses: SyncStatus[];
let timers: { fn: () => void; ms: number; cancelled: boolean }[];

function transport() {
  const call = async <T>(fn: () => T): Promise<T> => {
    const f = fault();
    if (f === 'offline') throw new SyncTransportError(0, 'unreachable');
    if (f === 'server-error') throw new SyncTransportError(503, 'busy');
    const result = fn();
    if (f === 'lost-response') throw new SyncTransportError(0, 'connection reset');
    return JSON.parse(JSON.stringify(result)) as T;
  };
  return {
    push: (req: SyncPushRequest) => call(() => server.push(req)),
    pull: (cursor: string | null) => call(() => server.pull(cursor)),
  };
}

function engine(extra: Partial<ConstructorParameters<typeof SyncEngine>[0]> = {}) {
  return new SyncEngine({
    store,
    transport: transport(),
    onStatus: (s) => statuses.push(s),
    setTimer: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => (t.cancelled = true);
    },
    random: () => 0.5,
    pushBatchSize: 7,
    ...(process.env.DEBUG_SYNC ? { log: { info: console.log, warn: console.log } } : {}),
    ...extra,
  });
}

beforeEach(() => {
  server = new FakeServer();
  store = new LocalStore({ path: ':memory:', log: { warn: () => {}, error: () => {} } });
  fault = () => 'none';
  statuses = [];
  timers = [];
});
afterEach(() => store.close());

const live = () => timers.filter((t) => !t.cancelled);

async function bootstrap(e: SyncEngine) {
  e.start();
  await e.syncNow();
  expect(store.personalWorkspaceId()).toBe('ws');
  store.createMeeting({
    meetingId: 'm1',
    documentId: 'd1',
    workspaceId: 'ws',
    ownerId: 'u1',
    title: 'Standup',
    startedAt: null,
  });
}

const seg = (id: string, text: string): Parameters<LocalStore['saveSegment']>[0] => ({
  id,
  meetingId: 'm1',
  source: id.charCodeAt(id.length - 1) % 2 ? 'mic' : 'system',
  speakerLabel: null,
  startMs: 0,
  endMs: 5,
  text,
});

describe('SyncEngine', () => {
  it('pushes the outbox, pulls, and goes idle with the interval scheduled', async () => {
    const e = engine({ intervalMs: 30_000 });
    await bootstrap(e);
    for (let i = 0; i < 20; i++) store.saveSegment(seg(`s${i}`, `hello ${i}`));
    e.kick();
    expect(e.status.pending).toBe(22);
    const status = await e.syncNow();
    expect(status).toMatchObject({ state: 'idle', pending: 0, error: null });
    expect(server.segments.size).toBe(20);
    expect(server.pushes).toBeGreaterThanOrEqual(4); // batches of 7
    expect(live().at(-1)!.ms).toBe(30_000);
  });

  it('offline: keeps the outbox, backs off, and drains once back', async () => {
    const e = engine({ backoffMs: 1_000, maxBackoffMs: 8_000 });
    await bootstrap(e);
    fault = () => 'offline';
    store.saveSegment(seg('s1', 'a'));
    e.kick();
    await e.syncNow();
    expect(e.status).toMatchObject({ state: 'offline', pending: 3 });
    expect(e.status.error).toMatch(/Offline/);
    // Exponential backoff: 1 s, 2 s, 4 s, 8 s, 8 s (jitter fixed at 1×).
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = live().at(-1)!;
      delays.push(t.ms);
      t.cancelled = true;
      t.fn();
      await e.idle();
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 8_000]);
    // A local write while backing off doesn't hammer the server.
    store.saveSegment(seg('s2', 'b'));
    const before = timers.length;
    e.kick();
    expect(timers.length).toBe(before);
    expect(e.status.pending).toBe(4);
    fault = () => 'none';
    live().at(-1)!.fn();
    await e.idle();
    expect(e.status).toMatchObject({ state: 'idle', pending: 0 });
    expect([...server.segments.keys()].sort()).toEqual(['s1', 's2']);
  });

  it('401 stops the engine and reports it', async () => {
    let unauthorized = 0;
    const e = engine({ onUnauthorized: () => unauthorized++ });
    await bootstrap(e);
    e.stop();
    const t = engine({
      onUnauthorized: () => unauthorized++,
      transport: {
        push: () => Promise.reject(new SyncTransportError(401, 'no')),
        pull: () => Promise.reject(new SyncTransportError(401, 'no')),
      },
    });
    t.start();
    await t.syncNow();
    expect(t.status.state).toBe('stopped');
    expect(t.started).toBe(false);
    expect(unauthorized).toBe(1);
  });

  it('409 on pull restarts the cursor', async () => {
    let first = true;
    const real = transport();
    const e = engine({
      transport: {
        push: real.push,
        pull: (cursor) => {
          if (cursor !== null && first) {
            first = false;
            return Promise.reject(new SyncTransportError(409, 'stale'));
          }
          return real.pull(cursor);
        },
      },
    });
    await bootstrap(e);
    store.setState('pull.cursor', '1');
    await e.syncNow();
    expect(e.status.state).toBe('error');
    expect(store.pullCursor()).toBeNull();
    await e.syncNow();
    expect(e.status.state).toBe('idle');
  });

  it('an oversized entry (413) is isolated and parked; everything else syncs', async () => {
    const real = transport();
    const e = engine({
      pushBatchSize: 50,
      transport: {
        push: (req) =>
          JSON.stringify(req).length > 20_000
            ? Promise.reject(new SyncTransportError(413, 'too large'))
            : real.push(req),
        pull: real.pull,
      },
    });
    await bootstrap(e);
    for (let i = 0; i < 12; i++) store.saveSegment(seg(`s${i}`, `ok ${i}`));
    store.saveSegment(seg('huge', 'x'.repeat(9_900)));
    store.saveSegment(seg('huge2', 'y'.repeat(9_900)));
    store.saveSegment(seg('huge3', 'z'.repeat(9_900)));
    const status = await e.syncNow();
    // The three big ones fit alone (each < 20 kB) but not together: bisection finds working halves.
    expect(status).toMatchObject({ state: 'idle', pending: 0, parked: 0 });
    expect(server.segments.size).toBe(15);
    // One entry that is too large even alone is parked, the rest goes through.
    store.saveSegment(seg('monster', 'm'.repeat(10_000)));
    store.updateDocument('d1', {
      contentJson: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'q'.repeat(25_000) }] }],
      },
    });
    store.saveSegment(seg('after', 'still syncs'));
    const second = await e.syncNow();
    expect(second).toMatchObject({ state: 'idle', pending: 0, parked: 1 });
    expect(server.segments.has('monster')).toBe(true);
    expect(server.segments.has('after')).toBe(true);
    expect(store.outbox().find((x) => x.parked)).toMatchObject({ table: 'document', rowId: 'd1' });
  });

  it('a poison entry (400) is isolated and parked instead of blocking the queue', async () => {
    const real = transport();
    const sent: number[] = [];
    const e = engine({
      pushBatchSize: 50,
      transport: {
        push: (req) => {
          sent.push(req.entries.length);
          return req.entries.some((x) => x.op === 'upsert' && x.row.id === 'poison')
            ? Promise.reject(new SyncTransportError(400, 'bad request'))
            : real.push(req);
        },
        pull: real.pull,
      },
    });
    await bootstrap(e);
    for (let i = 0; i < 20; i++) store.saveSegment(seg(i === 7 ? 'poison' : `s${i}`, `t${i}`));
    const status = await e.syncNow();
    expect(status).toMatchObject({ state: 'idle', pending: 0, parked: 1 });
    expect(server.segments.size).toBe(19);
    expect(server.segments.has('poison')).toBe(false);
    expect(sent.length).toBeLessThan(15); // log2 bisection, not one request per entry
    // Retried later (parkedRetryMs): still refused, parked again; the queue keeps flowing.
    store.saveSegment(seg('later', 'x'));
    expect((await e.syncNow()).parked).toBe(1);
  });

  it('5xx: an outage parks nothing; a 5xx poison is parked after repeated failures', async () => {
    const real = transport();
    let down = true;
    const e = engine({
      pushBatchSize: 50,
      serverErrorsBeforeSplit: 2,
      transport: {
        push: (req) =>
          down || req.entries.some((x) => x.op === 'upsert' && x.row.id === 'boom')
            ? Promise.reject(new SyncTransportError(500, 'oops'))
            : real.push(req),
        pull: real.pull,
      },
    });
    await bootstrap(e);
    for (let i = 0; i < 6; i++) store.saveSegment(seg(`s${i}`, `t${i}`));
    for (let i = 0; i < 4; i++) await e.syncNow();
    expect(e.status).toMatchObject({ state: 'error', parked: 0, pending: 8 });
    down = false;
    store.saveSegment(seg('boom', 'explodes the server'));
    // Still failing (the 5xx streak continues) → split → the rest goes through, 'boom' is parked.
    await e.syncNow();
    expect(e.status).toMatchObject({ state: 'idle', pending: 0, parked: 1 });
    expect(server.segments.size).toBe(6);
  });

  it('a 409 from push does not reset the pull cursor', async () => {
    const real = transport();
    let conflict = true;
    const e = engine({
      transport: {
        push: (req) =>
          conflict ? Promise.reject(new SyncTransportError(409, 'conflict')) : real.push(req),
        pull: real.pull,
      },
    });
    await bootstrap(e);
    const cursor = store.pullCursor();
    expect(cursor).not.toBeNull();
    await e.syncNow();
    expect(e.status.state).toBe('error');
    expect(store.pullCursor()).toBe(cursor);
    conflict = false;
    expect((await e.syncNow()).state).toBe('idle');
  });

  it('kick debounces and a write during a run triggers another run', async () => {
    const e = engine({ debounceMs: 500 });
    await bootstrap(e);
    timers.length = 0;
    e.kick();
    e.kick();
    expect(live().map((t) => t.ms)).toEqual([500]);
    const run = live()[0]!;
    run.cancelled = true;
    run.fn();
    store.saveSegment(seg('s1', 'during'));
    e.kick(); // while running
    await e.idle();
    expect(live().some((t) => t.ms === 0)).toBe(true);
  });

  it('property: random writes and network faults converge with no duplicates', async () => {
    for (let round = 0; round < 25; round++) {
      server = new FakeServer();
      store.close();
      store = new LocalStore({ path: ':memory:', log: { warn: () => {}, error: () => {} } });
      timers = [];
      let seed = round + 1;
      const rand = () => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        return seed / 2 ** 31;
      };
      const faults: Fault[] = ['none', 'offline', 'lost-response', 'server-error'];
      fault = () => faults[Math.floor(rand() * faults.length)]!;
      const e = engine({ random: rand });
      e.start();
      while (!store.personalWorkspaceId()) await e.syncNow();
      store.createMeeting({
        meetingId: 'm1',
        documentId: 'd1',
        workspaceId: 'ws',
        ownerId: 'u1',
        title: 'T',
        startedAt: null,
      });
      let next = 0;
      for (let step = 0; step < 60; step++) {
        const r = rand();
        const ids = store.segments('m1').map((s) => s.id);
        if (r < 0.5 || ids.length === 0) store.saveSegment(seg(`s${next++}`, `t${step}`));
        else if (r < 0.7) store.saveSegment(seg(ids[Math.floor(rand() * ids.length)]!, `e${step}`));
        else if (r < 0.8) store.deleteSegment(ids[Math.floor(rand() * ids.length)]!);
        else if (r < 0.85) store.updateDocument('d1', { title: `T${step}` });
        else await e.syncNow();
      }
      fault = () => 'none';
      for (let i = 0; i < 5 && store.outboxSize() > 0; i++) await e.syncNow();
      expect(store.outboxSize(), `round ${round}`).toBe(0);
      const local = store
        .segments('m1')
        .map((s) => [s.id, s.text])
        .sort();
      const remote = [...server.segments.values()].map((s) => [s.id, s.text]).sort();
      expect(remote, `round ${round}`).toEqual(local);
      expect(server.docs.get('d1')!.title).toBe(store.document('d1')!.title);
      e.stop();
    }
  });
});
