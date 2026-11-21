import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SyncPullResponse, SyncPushRequest, SyncPushResponse } from '@oat/core/sync';
import {
  LocalStore,
  LocalStoreUnavailableError,
  type SyncStatus,
  SyncTransportError,
} from '@oat/local-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from './ipc.ts';
import { databaseFileFor, SyncService } from './sync-service.ts';

let dir: string;
let statuses: SyncStatus[];
let online: boolean;
let recording: boolean;
let services: SyncService[];
const pushes: SyncPushRequest[] = [];
const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const page = (workspace: string): SyncPullResponse => ({
  changes: [
    {
      op: 'upsert',
      table: 'workspace',
      row: { id: workspace, name: 'Me', role: 'owner' },
    },
  ],
  cursor: '1.1',
  hasMore: false,
  workspaceIds: [workspace],
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oat-sync-service-'));
  statuses = [];
  online = true;
  recording = false;
  services = [];
  pushes.length = 0;
});
afterEach(async () => {
  for (const s of services) await s.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

function service(
  extra: {
    onUnauthorized?: () => void;
    status?: number;
    openStore?: (path: string) => LocalStore;
    gate?: Promise<void>;
  } = {},
) {
  let user = 'ws-u1';
  const s = new SyncService({
    dir,
    log,
    isRecording: () => recording,
    onStatus: (st) => statuses.push(st),
    retryOpenMs: 10,
    ...(extra.onUnauthorized ? { onUnauthorized: extra.onUnauthorized } : {}),
    ...(extra.openStore ? { openStore: extra.openStore } : {}),
    engine: { setTimer: () => () => {}, random: () => 0.5 },
    transport: {
      push: async (req): Promise<SyncPushResponse> => {
        await extra.gate;
        if (extra.status) throw new SyncTransportError(extra.status, 'no');
        if (!online) throw new SyncTransportError(0, 'offline');
        pushes.push(req);
        return { results: req.entries.map((e) => ({ version: e.version, status: 'ok' as const })) };
      },
      pull: async () => {
        if (extra.status) throw new SyncTransportError(extra.status, 'no');
        if (!online) throw new SyncTransportError(0, 'offline');
        user = s.storeUser ? `ws-${s.storeUser}` : user;
        return page(user);
      },
    },
  });
  services.push(s);
  return s;
}

const meeting = (s: SyncService, id = 'm1') =>
  s.store!.createMeeting({
    meetingId: id,
    documentId: `d-${id}`,
    workspaceId: s.store!.firstWorkspaceId()!,
    ownerId: s.storeUser!,
    title: 'T',
    startedAt: null,
  });

describe('SyncService', () => {
  it('runs only while signed in, and reports status; signing out keeps the database open', async () => {
    const s = service();
    expect(await s.syncNow()).toMatchObject({ state: 'stopped' });
    await s.setUser('u1');
    expect(existsSync(join(dir, 'oat-u1.sqlite'))).toBe(true);
    expect(await s.syncNow()).toMatchObject({ state: 'idle', pending: 0, parked: 0 });
    expect(s.store!.firstWorkspaceId()).toBe('ws-u1');
    meeting(s);
    s.kick();
    expect(statuses.at(-1)).toMatchObject({ pending: 2 });
    await s.syncNow();
    expect(pushes.flatMap((p) => p.entries.map((e) => e.table))).toEqual(['document', 'meeting']);
    await s.setUser(null);
    expect(statuses.at(-1)).toMatchObject({ state: 'stopped' });
    expect(s.store).not.toBeNull();
  });

  it('re-announcing the same user (every MainStore change does) is a no-op — no feedback loop', async () => {
    // index.ts calls setUser on each MainStore change, and sync status changes are MainStore changes.
    let calls = 0;
    const s = new SyncService({
      dir,
      log,
      isRecording: () => false,
      onStatus: () => {
        if (++calls < 1000) queueMicrotask(() => void s.setUser(null));
      },
      transport: { push: async () => ({ results: [] }), pull: async () => page('w') },
    });
    services.push(s);
    await s.setUser(null);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBeLessThanOrEqual(1);
  });

  it('offline: changes wait in the outbox and drain later', async () => {
    const s = service();
    await s.setUser('u1');
    await s.syncNow();
    online = false;
    meeting(s);
    expect(await s.syncNow()).toMatchObject({ state: 'offline', pending: 2 });
    online = true;
    expect(await s.syncNow()).toMatchObject({ state: 'idle', pending: 0 });
  });

  it('one file per user: another account gets its own; the previous one is kept, not wiped', async () => {
    const s = service();
    await s.setUser('u1');
    await s.syncNow();
    online = false;
    meeting(s); // unsynced work of u1
    await s.setUser(null);
    await s.setUser('u2');
    expect(s.storeUser).toBe('u2');
    expect(s.store!.meeting('m1')).toBeUndefined();
    expect(existsSync(join(dir, databaseFileFor('u1')))).toBe(true);
    await s.setUser('u1');
    expect(s.store!.meeting('m1')).toBeDefined();
    expect(s.store!.outboxSize()).toBe(2); // still queued for u1
    expect(databaseFileFor('a/b c')).toBe('oat-a_b_c.sqlite');
  });

  it('a switch waits for the run in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = service({ gate });
    await s.setUser('u1');
    await s.syncNow(); // nothing to push yet: not held by the gate
    meeting(s);
    const run = s.syncNow(); // blocked in push
    let switched = false;
    const switching = s.setUser('u2').then(() => (switched = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(switched).toBe(false);
    expect(s.storeUser).toBe('u1');
    release();
    await Promise.all([run, switching]);
    expect(s.storeUser).toBe('u2');
  });

  it('no switch while recording: it happens once the recording has ended', async () => {
    const s = service();
    await s.setUser('u1');
    await s.syncNow();
    recording = true;
    await s.setUser('u2');
    expect(s.storeUser).toBe('u1'); // the meeting in progress keeps writing to u1's file
    meeting(s);
    recording = false;
    await s.recordingEnded();
    expect(s.storeUser).toBe('u2');
  });

  it('a database that can’t be opened is reported and retried, never wiped', async () => {
    let fail = 2;
    const s = service({
      openStore: (path) => {
        if (fail-- > 0) throw new LocalStoreUnavailableError('busy', { errcode: 5 });
        return new LocalStore({ path });
      },
    });
    await s.setUser('u1');
    expect(s.store).toBeNull();
    expect(statuses.at(-1)).toMatchObject({
      state: 'error',
      error: expect.stringMatching(/retrying/),
    });
    await vi.waitFor(() => expect(s.store).not.toBeNull());
  });

  it('learns the user’s workspaces on demand (bounded), not while offline', async () => {
    const s = service();
    expect(await s.awaitWorkspaces(10)).toBe(false); // nobody signed in
    online = false;
    await s.setUser('u1');
    expect(await s.awaitWorkspaces(50)).toBe(false);
    online = true;
    expect(await s.awaitWorkspaces(1_000)).toBe(true);
    expect(s.store!.firstWorkspaceId()).toBe('ws-u1');
  });

  it('a 401 stops syncing and tells the app', async () => {
    const onUnauthorized = vi.fn();
    const s = service({ onUnauthorized, status: 401 });
    await s.setUser('u1');
    expect(await s.syncNow()).toMatchObject({ state: 'stopped' });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});
