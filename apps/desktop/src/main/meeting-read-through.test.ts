import { createOatClient, type OatTransport } from '@oat/client';
import { LocalStore } from '@oat/local-store';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MeetingNotes } from './meeting-notes';
import { createMeetingReadClient, MeetingReadThrough } from './meeting-read-through';
import { createApiRequester } from './api-client';

const date = '2026-11-22T10:00:00.000Z';
const doc = {
  id: 'doc',
  workspaceId: 'ws',
  folderId: null,
  ownerId: 'user',
  kind: 'meeting' as const,
  title: 'Remote meeting',
  contentJson: { type: 'doc' as const, content: [] },
  visibility: 'private' as const,
  version: 4,
  createdAt: date,
  updatedAt: date,
  deletedAt: null,
  conflictOfId: null,
  conflictDevice: null,
  conflictAt: null,
};
const workspace = { id: 'ws', name: 'Team', role: 'member' as const };
const meeting = {
  id: 'meeting',
  documentId: 'doc',
  calendarEventId: null,
  startedAt: date,
  endedAt: date,
  platform: 'web',
  templateId: null,
};
const segment = {
  id: 'segment',
  meetingId: 'meeting',
  source: 'mic' as const,
  speakerLabel: null,
  startMs: 1000,
  endMs: 2000,
  text: 'Remote transcript',
};
let store: LocalStore;
let currentStore: LocalStore | null;
let user: string | null;
let notes: MeetingNotes;
let changed: ReturnType<typeof vi.fn<() => void>>;
beforeEach(() => {
  store = new LocalStore({ path: ':memory:' });
  currentStore = store;
  user = 'user';
  changed = vi.fn();
  notes = new MeetingNotes({
    store: () => currentStore,
    userId: () => user,
    sync: { kick: vi.fn() },
    onChange: changed,
  });
});
afterEach(() => store.close());
function setup(override?: OatTransport) {
  const transport = vi.fn<OatTransport>(
    override ??
      (async (request) => ({
        status: 200,
        json: async () =>
          request.path === '/api/documents/doc'
            ? doc
            : request.path === '/api/workspaces'
              ? { workspaces: [workspace] }
              : {
                  changes: [
                    { op: 'upsert', table: 'meeting', row: meeting },
                    { op: 'upsert', table: 'transcript_segment', row: segment },
                  ],
                  next: null,
                },
      })),
  );
  return {
    transport,
    reader: new MeetingReadThrough({
      store: () => currentStore,
      userId: () => user,
      notes,
      client: createOatClient(transport),
      onChange: changed,
    }),
  };
}
it('caches remote meetings without echoing, then writes edits through the normal outbox', async () => {
  const { reader, transport } = setup();
  const loaded = await reader.load('doc');
  expect(loaded).toMatchObject({
    state: 'ready',
    note: { title: 'Remote meeting', editable: true, recordedHere: false },
  });
  expect(store.segments('meeting')[0]?.text).toBe('Remote transcript');
  expect(store.outboxSize()).toBe(0);
  expect(changed).toHaveBeenCalledOnce();
  await notes.save('doc', { title: doc.title, contentJson: doc.contentJson }, { title: 'My edit' });
  expect(store.outbox().some((entry) => entry.rowId === 'doc')).toBe(true);
  transport.mockClear();
  expect(await reader.load('doc')).toMatchObject({ state: 'ready', note: { title: 'My edit' } });
  expect(transport).not.toHaveBeenCalled();
});
it('does not replace a newer local document that arrives while the remote read is pending', async () => {
  const { reader } = setup(async (request) => {
    if (request.path === '/api/documents/doc') {
      store.cacheMeeting({ ...doc, title: 'Newer local', version: 8 }, workspace, []);
      return { status: 200, json: async () => doc };
    }
    return {
      status: 200,
      json: async () =>
        request.path === '/api/workspaces'
          ? { workspaces: [workspace] }
          : { changes: [{ op: 'upsert', table: 'meeting', row: meeting }], next: null },
    };
  });
  expect(await reader.load('doc')).toMatchObject({
    state: 'ready',
    note: { title: 'Newer local' },
  });
  expect(store.meeting('meeting')).toBeUndefined();
});
it.each([403, 404, 500, 0])(
  'maps server/network status %s without caching failed reads',
  async (status) => {
    const { reader } = setup(async () => ({
      status,
      json: async () => ({ error: { code: 'unavailable', message: 'No access' } }),
    }));
    expect(await reader.load('doc')).toEqual({
      state: status === 0 ? 'offline' : status === 500 ? 'error' : 'missing',
    });
    expect(store.document('doc')).toBeUndefined();
  },
);
it('paginates before committing, and accepts a meeting with no transcript or recording', async () => {
  let page = 0;
  const { reader, transport } = setup(async (request) => {
    if (request.path === '/api/documents/doc') return { status: 200, json: async () => doc };
    if (request.path === '/api/workspaces')
      return { status: 200, json: async () => ({ workspaces: [workspace] }) };
    expect(store.document('doc')).toBeUndefined();
    return {
      status: 200,
      json: async () =>
        ++page === 1 ? { changes: [], next: 's:next' } : { changes: [], next: null },
    };
  });
  expect(await reader.load('doc')).toMatchObject({
    state: 'ready',
    note: { meetingId: null, participants: [] },
  });
  expect(transport).toHaveBeenLastCalledWith(
    expect.objectContaining({
      path: '/api/sync/backfill',
      query: { document: 'doc', after: 's:next' },
    }),
  );
});
it('does not cache partial results, foreign children, or data fetched before an account switch', async () => {
  for (const mode of ['partial', 'foreign', 'account'] as const) {
    const { reader } = setup(async (request) => {
      if (request.path === '/api/documents/doc') return { status: 200, json: async () => doc };
      if (request.path === '/api/workspaces')
        return { status: 200, json: async () => ({ workspaces: [workspace] }) };
      if (mode === 'partial') throw new Error('offline');
      if (mode === 'account') user = 'other';
      return {
        status: 200,
        json: async () => ({
          changes: [{ op: 'upsert', table: 'meeting', row: { ...meeting, documentId: 'foreign' } }],
          next: null,
        }),
      };
    });
    expect((await reader.load('doc')).state).not.toBe('ready');
    expect(store.document('doc')).toBeUndefined();
  }
});
it('uses the server workspace role for read-only meeting notes', async () => {
  const { reader } = setup(async (request) => ({
    status: 200,
    json: async () =>
      request.path === '/api/documents/doc'
        ? doc
        : request.path === '/api/workspaces'
          ? { workspaces: [{ ...workspace, role: 'viewer' }] }
          : { changes: [], next: null },
  }));
  expect(await reader.load('doc')).toMatchObject({ state: 'ready', note: { editable: false } });
});
it('authenticates declared API reads in main, follows no redirects, and handles rejected sessions', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(doc)));
  const auth = {
    async withSession<T>(fn: (token: string) => Promise<T>): Promise<T> {
      return fn('main-owned');
    },
  };
  const client = createMeetingReadClient({
    baseUrl: 'https://oat.test',
    request: createApiRequester({ baseUrl: 'https://oat.test', fetch: fetcher }),
    auth,
  });
  expect(await client.documents.get('doc')).toEqual(doc);
  expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get('authorization')).toBe(
    'Bearer main-owned',
  );
  expect(fetcher.mock.calls[0]![1]?.redirect).toBe('error');
  fetcher.mockResolvedValue(new Response('{}', { status: 401 }));
  await expect(client.documents.get('doc')).rejects.toMatchObject({ status: 401 });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
