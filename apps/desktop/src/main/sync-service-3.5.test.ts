/** SyncService 3.5: SSE channel lifecycle, device name, local search and conflicted copies. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SyncDocumentRow, SyncPullResponse, SyncPushRequest } from '@oat/core/sync';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from './ipc.ts';
import { deviceName, SyncService } from './sync-service.ts';

let dir: string;
let services: SyncService[];
const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oat-sync-service-35-'));
  services = [];
});
afterEach(async () => {
  for (const s of services) await s.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

const body = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const docRow = (patch: Partial<SyncDocumentRow>): SyncDocumentRow => ({
  id: 'd1',
  workspaceId: 'ws',
  folderId: null,
  ownerId: 'u1',
  kind: 'page',
  title: 'Plan',
  contentJson: body('the budget is fine'),
  visibility: 'private',
  version: 1,
  createdAt: '2026-11-14T10:00:00.000Z',
  updatedAt: '2026-11-14T10:00:00.000Z',
  deletedAt: null,
  conflictOfId: null,
  conflictDevice: null,
  conflictAt: null,
  ...patch,
});

/** A controllable SSE stream per connection. */
function sseServer() {
  const conns: { send(text: string): void; closed: boolean }[] = [];
  return {
    conns,
    connect: async (_last: string | null, signal: AbortSignal) => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const conn = {
        closed: false,
        send: (t: string) => controller.enqueue(new TextEncoder().encode(t)),
      };
      const stream = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
      signal.addEventListener('abort', () => {
        conn.closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
      conns.push(conn);
      return new Response(stream);
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

describe('SyncService (3.5)', () => {
  it('opens the event channel while signed in; events pull; sign-out closes it', async () => {
    const sse = sseServer();
    let pulls = 0;
    const pushes: SyncPushRequest[] = [];
    const docs = [docRow({})];
    const s = new SyncService({
      dir,
      log,
      isRecording: () => false,
      onStatus: () => {},
      deviceName: 'Studio Mac',
      engine: { setTimer: (fn, ms) => (ms <= 200 ? (setTimeout(fn, 0), () => {}) : () => {}) },
      events: { connect: sse.connect, setTimer: () => () => {} },
      transport: {
        push: async (req) => {
          pushes.push(req);
          return {
            results: req.entries.map((e) => ({ version: e.version, status: 'ok' as const })),
          };
        },
        pull: async (cursor): Promise<SyncPullResponse> => {
          pulls += 1;
          return {
            changes:
              cursor === null
                ? [
                    {
                      op: 'upsert',
                      table: 'workspace',
                      row: { id: 'ws', name: 'Me', kind: 'personal' },
                    },
                    ...docs.map((row) => ({
                      op: 'upsert' as const,
                      table: 'document' as const,
                      row,
                    })),
                  ]
                : docs.map((row) => ({ op: 'upsert' as const, table: 'document' as const, row })),
            cursor: '1',
            hasMore: false,
            workspaceIds: ['ws'],
          };
        },
      },
    });
    services.push(s);
    await s.setUser('u1');
    await s.syncNow();
    await flush();
    expect(sse.conns).toHaveLength(1);
    sse.conns[0]!.send('id: 1.1\nevent: ready\ndata: {"seq":"1.1"}\n\n');
    await flush();
    expect(s.live).toBe(true);
    const before = pulls;
    docs[0] = docRow({ version: 2, contentJson: body('the budget doubled') });
    sse.conns[0]!.send(
      'id: 1.2\nevent: change\ndata: {"seq":"1.2","tables":["document"],"ids":["d1"]}\n\n',
    );
    await flush();
    await s.syncNow();
    expect(pulls).toBeGreaterThan(before);
    expect(s.search('doubled').map((h) => h.documentId)).toEqual(['d1']);

    // A local edit pushes with this Mac's name.
    s.store!.updateDocument('d1', { contentJson: body('mine') });
    await s.syncNow();
    expect(pushes.at(-1)?.device).toEqual({ name: 'Studio Mac' });

    await s.setUser(null);
    await flush();
    expect(sse.conns[0]!.closed).toBe(true);
    expect(s.live).toBe(false);
  });

  it('lists, compares and resolves conflicted copies (synced as an edit + a delete)', async () => {
    const pushes: SyncPushRequest[] = [];
    let conflictOnce = true;
    let server = docRow({ contentJson: body('base line') });
    const s = new SyncService({
      dir,
      log,
      isRecording: () => false,
      onStatus: () => {},
      deviceName: 'Studio Mac',
      engine: { setTimer: () => () => {} },
      transport: {
        push: async (req) => {
          pushes.push(req);
          return {
            results: req.entries.map((e) =>
              e.table === 'document' && e.op === 'upsert' && e.row.id === 'd1' && conflictOnce
                ? ((conflictOnce = false),
                  (server = docRow({ version: 2, contentJson: body('theirs line') })),
                  { version: e.version, status: 'conflict' as const, row: server })
                : { version: e.version, status: 'ok' as const },
            ),
          };
        },
        pull: async () => ({
          changes: [
            { op: 'upsert', table: 'workspace', row: { id: 'ws', name: 'Me', kind: 'personal' } },
            { op: 'upsert', table: 'document', row: server },
          ],
          cursor: '1',
          hasMore: false,
          workspaceIds: ['ws'],
        }),
      },
    });
    services.push(s);
    await s.setUser('u1');
    await s.syncNow();
    s.store!.updateDocument('d1', { contentJson: body('mine line') });
    await s.syncNow();
    const [c] = s.conflicts();
    expect(c).toMatchObject({
      title: 'Plan (conflicted copy)',
      device: 'Studio Mac',
      originalId: 'd1',
      originalTitle: 'Plan',
    });
    const detail = s.conflict(c!.copyId)!;
    expect(detail.original).toEqual([
      { text: 'Plan', changed: false },
      { text: 'theirs line', changed: true },
    ]);
    expect(detail.copy).toEqual([
      { text: 'Plan', changed: false },
      { text: 'mine line', changed: true },
    ]);
    expect(s.conflict('d1')).toBeNull();
    expect(s.resolveConflict(c!.copyId, 'copy')).toBe(true);
    await s.syncNow();
    const last = pushes.flatMap((p) => p.entries).slice(-2);
    expect(last.map((e) => [e.table, e.op])).toEqual([
      ['document', 'upsert'],
      ['document', 'delete'],
    ]);
    expect(s.conflicts()).toEqual([]);
  });

  it('device name from the host name', () => {
    expect(deviceName('Nafiss-MacBook-Pro.local')).toBe('Nafiss MacBook Pro');
    expect(deviceName('')).toBe('Mac');
  });
});
