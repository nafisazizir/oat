/**
 * 3.5 property test: two desktops (A, B) and the web edit the same notes while the network drops requests
 * and loses responses. The in-memory server mirrors the real push rules (`apps/web` `push.ts`, covered
 * against Postgres in `sync.int.test.ts`): stale base → conflict unless the text is the current one or
 * one this document already had through a sync push (receipts); creates may be conflicted copies; a copy
 * can be deleted (trashed) by sync.
 *
 * Properties, for many seeds:
 * - Convergence: once the network is healthy, every device holds exactly the server's documents.
 * - Conflicted copies only for real concurrent edits: a copy's text never was a version of its original
 *   on the server (so a lost acknowledgement never produces one).
 * - Nothing is lost: each device's last text for a note is on the server, in history or in a copy.
 * - One writer + any faults → no copies at all.
 * - Resolving copies (keep copy / keep original) converges too, and the server trashes the copies.
 */
import {
  documentContentKey,
  type SyncDocumentRow,
  type SyncPullChange,
  type SyncPullResponse,
  type SyncPushEntry,
  type SyncPushRequest,
  type SyncPushResponse,
  type SyncPushResult,
} from '@oat/core';
import { afterAll, describe, expect, it } from 'vitest';

import { LocalStore } from './store.ts';
import { SyncEngine, SyncTransportError } from './sync-engine.ts';

const AT = '2026-11-14T10:00:00.000Z';
const body = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const textOf = (d: { contentJson: unknown }) =>
  ((d.contentJson as ReturnType<typeof body>).content[0]?.content?.[0]?.text as string) ?? '';

class Server {
  docs = new Map<string, SyncDocumentRow>();
  /** Every text a document ever had on the server. */
  history = new Map<string, Set<string>>();
  /** Texts a sync push wrote (the real server's receipts). */
  receipts = new Map<string, Set<string>>();
  log: string[] = ['ws'];
  #seq = 0;

  #write(row: SyncDocumentRow, receipt: boolean): void {
    this.docs.set(row.id, row);
    const key = documentContentKey(row.title, row.contentJson);
    (this.history.get(row.id) ?? this.history.set(row.id, new Set()).get(row.id)!).add(key);
    if (receipt) {
      (this.receipts.get(row.id) ?? this.receipts.set(row.id, new Set()).get(row.id)!).add(key);
    }
    this.log.push(row.id);
  }

  create(id: string, text: string): void {
    this.#write(
      {
        id,
        workspaceId: 'ws',
        folderId: null,
        ownerId: 'u1',
        kind: 'page',
        title: id,
        contentJson: body(text),
        visibility: 'private',
        version: 1,
        createdAt: AT,
        updatedAt: AT,
        deletedAt: null,
        conflictOfId: null,
        conflictDevice: null,
        conflictAt: null,
      },
      false,
    );
  }

  /** The web editor: an edit on the version it has (always current here). */
  webEdit(id: string, text: string): void {
    const cur = this.docs.get(id)!;
    if (cur.deletedAt) return;
    this.#write({ ...cur, contentJson: body(text), version: cur.version + 1 }, false);
  }

  push({ entries, device }: SyncPushRequest): SyncPushResponse {
    return { results: entries.map((e) => this.#apply(e, device?.name ?? null)) };
  }

  #apply(e: SyncPushEntry, device: string | null): SyncPushResult {
    const ok = { version: e.version, status: 'ok' as const };
    if (e.table !== 'document') throw new Error('only documents in this test');
    if (e.op === 'delete') {
      const cur = this.docs.get(e.id);
      if (!cur) return ok;
      if (!cur.conflictOfId) {
        return { version: e.version, status: 'rejected', code: 'unsupported', message: 'no' };
      }
      if (!cur.deletedAt) this.#write({ ...cur, deletedAt: AT }, false);
      return ok;
    }
    const cur = this.docs.get(e.row.id);
    const key = documentContentKey(e.row.title, e.row.contentJson);
    if (!cur) {
      const { conflictOf, ...row } = e.row;
      const created: SyncDocumentRow = {
        ...row,
        folderId: null,
        ownerId: 'u1',
        visibility: 'private',
        version: 0,
        createdAt: AT,
        updatedAt: AT,
        deletedAt: null,
        conflictOfId: conflictOf ?? null,
        conflictDevice: conflictOf ? device : null,
        conflictAt: conflictOf
          ? `2026-11-14T10:00:${String(++this.#seq % 60).padStart(2, '0')}.000Z`
          : null,
      };
      this.#write(created, true);
      return { ...ok, row: created };
    }
    if (documentContentKey(cur.title, cur.contentJson) === key) return { ...ok, row: cur };
    if (cur.version !== e.baseVersion) {
      // A text this document already had through a sync push: a replay of a write that landed.
      if (this.receipts.get(cur.id)?.has(key)) return { ...ok, row: cur };
      return { version: e.version, status: 'conflict', row: cur };
    }
    const row = {
      ...cur,
      title: e.row.title,
      contentJson: e.row.contentJson,
      version: cur.version + 1,
    };
    this.#write(row, true);
    return { ...ok, row };
  }

  pull(cursor: string | null): SyncPullResponse {
    const from = cursor === null ? 0 : Number(cursor);
    const slice = this.log.slice(from, from + 4);
    const seen = new Set<string>();
    const changes: SyncPullChange[] = [];
    for (const id of slice.toReversed()) {
      if (seen.has(id)) continue;
      seen.add(id);
      changes.unshift(
        id === 'ws'
          ? {
              op: 'upsert',
              table: 'workspace',
              row: { id: 'ws', name: 'Me', kind: 'personal', role: 'owner' },
            }
          : { op: 'upsert', table: 'document', row: this.docs.get(id)! },
      );
    }
    const next = from + slice.length;
    return { changes, cursor: String(next), hasMore: next < this.log.length, workspaceIds: ['ws'] };
  }
}

/** mulberry32 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Fault = 'none' | 'offline' | 'lost-response' | 'server-error';

interface Device {
  name: string;
  store: LocalStore;
  engine: SyncEngine;
  /** The last text this device wrote per note. */
  last: Map<string, string>;
}

function device(name: string, server: Server, fault: () => Fault): Device {
  const store = new LocalStore({
    path: ':memory:',
    deviceName: name,
    log: { warn: () => {}, error: () => {} },
  });
  const call = async <T>(fn: () => T): Promise<T> => {
    const f = fault();
    if (f === 'offline') throw new SyncTransportError(0, 'unreachable');
    if (f === 'server-error') throw new SyncTransportError(503, 'busy');
    const result = fn();
    if (f === 'lost-response') throw new SyncTransportError(0, 'connection reset');
    return structuredClone(result);
  };
  const engine = new SyncEngine({
    store,
    transport: {
      push: (r) => call(() => server.push(structuredClone(r))),
      pull: (c) => call(() => server.pull(c)),
    },
    device: { name },
    setTimer: () => () => {}, // driven by syncNow() only
    random: () => 0.5,
    serverErrorsBeforeSplit: 1_000, // a flaky network isn't a poison entry
    pushBatchSize: 3,
  });
  engine.start();
  return { name, store, engine, last: new Map() };
}

async function settle(server: Server, devices: Device[]) {
  for (let round = 0; round < 4; round++) {
    for (const d of devices) await d.engine.syncNow();
  }
  for (const d of devices) {
    expect(d.engine.status, d.name).toMatchObject({ state: 'idle', pending: 0, parked: 0 });
  }
}

function assertConverged(server: Server, devices: Device[]) {
  const pick = (d: SyncDocumentRow | ReturnType<LocalStore['document']>) => ({
    id: d!.id,
    title: d!.title,
    text: textOf(d!),
    version: d!.version,
    deletedAt: d!.deletedAt,
    conflictOfId: d!.conflictOfId,
    conflictDevice: d!.conflictDevice,
  });
  const expected = [...server.docs.values()].map(pick).sort((a, b) => a.id.localeCompare(b.id));
  for (const d of devices) {
    const local = d.store
      .documents()
      .map(pick)
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(local, d.name).toEqual(expected);
  }
}

function assertCopiesAreReal(server: Server) {
  for (const copy of server.docs.values()) {
    if (!copy.conflictOfId) continue;
    const key = documentContentKey(
      copy.title.replace(/ \(conflicted copy\)$/, ''),
      copy.contentJson,
    );
    expect(
      server.history.get(copy.conflictOfId)?.has(key),
      `copy ${copy.id} was a false conflict`,
    ).toBe(false);
    expect(['A', 'B']).toContain(copy.conflictDevice);
  }
}

function assertNothingLost(server: Server, devices: Device[]) {
  const texts = (id: string) => {
    const out = new Set<string>();
    for (const key of server.history.get(id) ?? []) out.add(key);
    return out;
  };
  for (const d of devices) {
    for (const [id, text] of d.last) {
      const inHistory = texts(id).has(documentContentKey(id, body(text)));
      const inCopy = [...server.docs.values()].some(
        (c) => c.conflictOfId === id && textOf(c) === text && c.conflictDevice === d.name,
      );
      expect(inHistory || inCopy, `${d.name}'s "${text}" for ${id} was lost`).toBe(true);
    }
  }
}

const stats = { copies: 0, webEdits: 0 };

describe('multi-device sync (property)', () => {
  afterAll(() => {
    // The seeds above must actually produce real conflicts (otherwise the properties prove little).
    expect(stats.copies).toBeGreaterThan(3);
  });

  it.each(Array.from({ length: 12 }, (_, i) => i + 1))(
    'seed %i: A + B + web with faults converge; copies only for real concurrent edits',
    async (seed) => {
      const random = rng(seed);
      const server = new Server();
      for (const id of ['d1', 'd2', 'd3']) server.create(id, `${id} v0`);
      let faulty = true;
      const fault = (): Fault => {
        if (!faulty) return 'none';
        const r = random();
        return r < 0.6 ? 'none' : r < 0.75 ? 'lost-response' : r < 0.9 ? 'offline' : 'server-error';
      };
      const A = device('A', server, fault);
      const B = device('B', server, fault);
      faulty = false;
      await settle(server, [A, B]);
      faulty = true;

      let n = 0;
      const faults = new Set<string>();
      for (let step = 0; step < 60; step++) {
        const doc = ['d1', 'd2', 'd3'][Math.floor(random() * 3)]!;
        const r = random();
        const text = `t${++n}`;
        if (r < 0.25) {
          if (A.store.updateDocument(doc, { contentJson: body(text) })) A.last.set(doc, text);
        } else if (r < 0.45) {
          if (B.store.updateDocument(doc, { contentJson: body(text) })) B.last.set(doc, text);
        } else if (r < 0.55) {
          server.webEdit(doc, text);
        } else {
          const d = r < 0.8 ? A : B;
          await d.engine.syncNow();
          faults.add(d.engine.status.state);
        }
      }
      faulty = false;
      await settle(server, [A, B]);
      assertConverged(server, [A, B]);
      assertCopiesAreReal(server);
      assertNothingLost(server, [A, B]);
      stats.copies += [...server.docs.values()].filter((d) => d.conflictOfId).length;
      stats.webEdits += [...server.history.values()].reduce((s, h) => s + h.size, 0);
      if (process.env.DEBUG_SYNC) console.log(seed, stats, [...faults]);

      // Resolve every copy (alternating keep copy / keep original) on A; everything converges again.
      let i = 0;
      for (const { copy, original } of A.store.conflicts()) {
        expect(original).toBeDefined();
        expect(A.store.resolveConflict(copy.id, i++ % 2 ? 'copy' : 'original')).toBe(true);
      }
      await settle(server, [A, B]);
      assertConverged(server, [A, B]);
      expect(A.store.conflicts()).toEqual([]);
      expect(B.store.conflicts()).toEqual([]);
      for (const c of server.docs.values()) if (c.conflictOfId) expect(c.deletedAt).not.toBeNull();
      A.store.close();
      B.store.close();
    },
  );

  it.each([1, 2, 3, 4, 5, 6])(
    'seed %i: one writer with lost acks never gets a conflicted copy',
    async (seed) => {
      const random = rng(100 + seed);
      const server = new Server();
      for (const id of ['d1', 'd2']) server.create(id, `${id} v0`);
      let faulty = false;
      let lost = 0;
      const fault = (): Fault => {
        if (!faulty) return 'none';
        const r = random();
        if (r < 0.35) {
          lost += 1;
          return 'lost-response';
        }
        return r < 0.45 ? 'offline' : 'none';
      };
      const A = device('A', server, fault);
      const B = device('B', server, fault); // only reads
      await settle(server, [A, B]);
      faulty = true;
      for (let step = 0; step < 50; step++) {
        const doc = random() < 0.5 ? 'd1' : 'd2';
        if (random() < 0.6) {
          const text = `a${step}`;
          if (A.store.updateDocument(doc, { contentJson: body(text) })) A.last.set(doc, text);
        } else {
          await A.engine.syncNow();
        }
      }
      faulty = false;
      await settle(server, [A, B]);
      expect(lost).toBeGreaterThan(0);
      expect([...server.docs.values()].filter((d) => d.conflictOfId)).toEqual([]);
      expect(A.store.conflicts()).toEqual([]);
      assertConverged(server, [A, B]);
      for (const [id, text] of A.last) expect(textOf(server.docs.get(id)!)).toBe(text);
      A.store.close();
      B.store.close();
    },
  );
});
