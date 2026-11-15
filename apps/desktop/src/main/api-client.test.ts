import { describe, expect, it, vi } from 'vitest';

import { ApiError, createApiClient } from './api-client.ts';

const BASE = 'http://localhost:3000';

function client(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) =>
    respond(String(url), init ?? {}),
  );
  return {
    api: createApiClient({ baseUrl: BASE, fetch: fetch as typeof globalThis.fetch }),
    fetch,
  };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });

describe('exchangeDesktopCode', () => {
  it('posts code + verifier and returns the signed token from set-auth-token', async () => {
    const { api, fetch } = client(() =>
      json(
        { user: { id: 'u', email: 'a@b.c', name: null } },
        { headers: { 'set-auth-token': 'abc.def%2B%3D' } },
      ),
    );
    expect(await api.exchangeDesktopCode('c', 'v')).toEqual({
      token: 'abc.def%2B%3D',
      user: { id: 'u', email: 'a@b.c', name: null },
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`${BASE}/api/auth/desktop/token`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ code: 'c', verifier: 'v' });
    // Never follows redirects with the request (or a token) somewhere else.
    expect(init?.redirect).toBe('error');
  });

  it('refuses a missing/unsigned token or a failed exchange', async () => {
    const user = { user: { id: 'u', email: 'e', name: null } };
    for (const res of [
      json({ code: 'invalid_grant' }, { status: 400 }),
      json(user),
      json(user, { headers: { 'set-auth-token': 'unsigned' } }),
      json({ nope: 1 }, { headers: { 'set-auth-token': 'a.b' } }),
    ]) {
      const { api } = client(() => res);
      await expect(api.exchangeDesktopCode('c', 'v')).rejects.toBeInstanceOf(ApiError);
    }
  });
});

describe('me', () => {
  it('sends the bearer token and maps the session', async () => {
    const { api, fetch } = client(() =>
      json({
        user: { id: 'u', email: 'a@b.c', name: '' },
        session: { activeOrganizationId: 'w' },
      }),
    );
    expect(await api.me('tok.sig')).toEqual({
      user: { id: 'u', email: 'a@b.c', name: null },
      activeWorkspaceId: 'w',
    });
    const headers = new Headers(fetch.mock.calls[0]![1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer tok.sig');
    expect(headers.get('user-agent')).toMatch(/^Oat-Desktop/);
  });

  it('a null session is a 401; a network failure is status 0', async () => {
    await expect(client(() => json(null)).api.me('t.s')).rejects.toMatchObject({ status: 401 });
    const offline = client(() => {
      throw new TypeError('fetch failed');
    });
    await expect(offline.api.me('t.s')).rejects.toMatchObject({ status: 0 });
  });
});

describe('signOut', () => {
  it('posts to sign-out with the bearer token', async () => {
    const { api, fetch } = client(() => json({ success: true }));
    await api.signOut('tok.sig');
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`${BASE}/api/auth/sign-out`);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tok.sig');
  });
});

describe('sync', () => {
  const entry = {
    version: 1,
    op: 'delete' as const,
    table: 'transcript_segment' as const,
    id: 's1',
  };

  it('pushes to the sync origin with the bearer token and validates the answer', async () => {
    const fetch = vi.fn(async () => json({ results: [{ version: 1, status: 'ok' }] }));
    const api = createApiClient({
      baseUrl: BASE,
      syncBaseUrl: 'http://127.0.0.1:4444',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(await api.syncPush('t.s', { entries: [entry] })).toEqual({
      results: [{ version: 1, status: 'ok' }],
    });
    const [url, init] = (fetch.mock.calls[0] as unknown as [URL, RequestInit])!;
    expect(String(url)).toBe('http://127.0.0.1:4444/api/sync/push');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer t.s');
    expect(JSON.parse(String(init.body))).toEqual({ entries: [entry] });

    await expect(
      client(() => json({ nope: true })).api.syncPush('t.s', { entries: [entry] }),
    ).rejects.toMatchObject({ status: 502 });
    await expect(
      client(() => json({}, { status: 503 })).api.syncPush('t.s', { entries: [entry] }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('pulls with the cursor and skips changes that don\u2019t match the protocol', async () => {
    const skipped: string[] = [];
    const fetch = vi.fn(async () =>
      json({
        changes: [
          { op: 'delete', table: 'transcript_segment', id: 's1' },
          { op: 'upsert', table: 'folder', row: { id: 'f' } },
        ],
        cursor: '5.6',
        hasMore: false,
        workspaceIds: ['w'],
      }),
    );
    const api = createApiClient({
      baseUrl: BASE,
      fetch: fetch as unknown as typeof globalThis.fetch,
      onSkippedChange: (r) => skipped.push(r),
    });
    const page = await api.syncPull('t.s', '1.2');
    expect(page.changes).toEqual([{ op: 'delete', table: 'transcript_segment', id: 's1' }]);
    expect(page.cursor).toBe('5.6');
    expect(skipped).toHaveLength(1);
    const [url] = (fetch.mock.calls[0] as unknown as [URL])!;
    expect(String(url)).toBe(`${BASE}/api/sync/pull?cursor=1.2`);
    await api.syncPull('t.s', null);
    expect(String((fetch.mock.calls[1] as unknown as [URL])[0])).toBe(`${BASE}/api/sync/pull`);
    await expect(
      client(() => json({}, { status: 409 })).api.syncPull('t.s', 'x'),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe('pipeline (7.5: the meeting header’s post-meeting status)', () => {
  const run = {
    id: 'r1',
    meetingId: 'm1',
    documentId: 'doc 1',
    status: 'running',
    attempt: 1,
    currentStep: 'enhance',
    steps: [{ step: 'enhance', outcome: 'skipped', reason: 'transcript too short', at: 'x' }],
    error: null,
    retryable: false,
    createdAt: 'x',
    startedAt: null,
    finishedAt: null,
    updatedAt: 'x',
  };

  it('reads the run with the bearer token and keeps only what the header shows', async () => {
    const { api, fetch } = client(() => json({ run, meetingEnded: true, canRun: true }));
    expect(await api.pipeline('tok.sig', 'doc 1')).toEqual({
      run: {
        status: 'running',
        currentStep: 'enhance',
        error: null,
        retryable: false,
        steps: [{ step: 'enhance', outcome: 'skipped', reason: 'transcript too short' }],
      },
      meetingEnded: true,
      canRun: true,
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`${BASE}/api/documents/doc%201/pipeline`);
    expect(init?.method).toBeUndefined();
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tok.sig');
  });

  it('retry posts; refusals carry their status', async () => {
    const { api, fetch } = client(() => json({ run: null, meetingEnded: false, canRun: false }));
    await api.pipeline('tok.sig', 'd1', { retry: true });
    expect(fetch.mock.calls[0]![1]?.method).toBe('POST');
    for (const status of [401, 403, 404, 500]) {
      const failing = client(() => json({ error: 'x' }, { status }));
      await expect(failing.api.pipeline('t.s', 'd1')).rejects.toMatchObject({ status });
    }
    const odd = client(() => json({ run: { status: 'weird' } }));
    await expect(odd.api.pipeline('t.s', 'd1')).rejects.toBeInstanceOf(ApiError);
  });
});
