import { EventEmitter } from 'node:events';

import type { BridgeApiRequest } from '@oat/core/bridge';
import { describe, expect, it, vi } from 'vitest';

import { createApiClient, createApiRequester } from './api-client.ts';
import { apiProxyUrl, registerApiProxy } from './api-proxy.ts';
import { AuthController } from './auth.ts';
import { createBridge, type IpcEventLike, type Logger } from './ipc.ts';
import { MainStore } from './store.ts';
import type { TokenStore } from './token-store.ts';

const BASE = 'https://oat.test';
const USER = { id: 'u', email: 'ada@oat.test', name: 'Ada' };
class Owner extends EventEmitter {
  id = 1;
  destroyed = false;
  messages: { channel: string; payload: unknown }[] = [];
  isDestroyed() {
    return this.destroyed;
  }
  send(channel: string, payload: unknown) {
    this.messages.push({ channel, payload });
  }
}

async function setup(signedIn = true) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ value: true }));
  const apiFetch: typeof fetch = async (url, init) =>
    new URL(String(url)).pathname.endsWith('/get-session')
      ? Response.json({ user: USER, session: { activeOrganizationId: 'w' } })
      : fetcher(url, init);
  const api = createApiClient({ baseUrl: BASE, fetch: apiFetch });
  const tokens = {
    load: async () => (signedIn ? { token: 'main-only-secret', user: USER } : null),
    clear: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
  };
  const store = new MainStore();
  const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const auth = new AuthController({
    api,
    tokens: tokens as unknown as TokenStore,
    store,
    webUrl: BASE,
    log,
    openExternal: async () => {},
  });
  await auth.restore();
  if (signedIn) await auth.me();
  const handlers = new Map<string, (event: IpcEventLike, ...args: unknown[]) => unknown>();
  const bridge = createBridge({
    ipcMain: {
      handle: (name, fn) => {
        handlers.set(name, fn);
      },
      on: () => {},
    },
    isTrustedSender: (event) =>
      event.senderFrame?.url === 'app://oat/index.html' && event.senderFrame.parent === null,
    log,
  });
  const proxy = registerApiProxy({
    bridge,
    baseUrl: BASE,
    auth,
    store,
    request: createApiRequester({ baseUrl: BASE, fetch: apiFetch, userAgent: 'Oat-Desktop/Test' }),
  });
  const owner = new Owner();
  const event = { sender: owner, senderFrame: { url: 'app://oat/index.html', parent: null } };
  const invoke = async (channel: string, input: unknown, sender = event) =>
    (await handlers.get(channel)!(sender, input)) as {
      ok: boolean;
      value: { streamId: string; status: number; body: unknown; headers: Record<string, string> };
      error: { code: string; message: string };
    };
  return { fetcher, store, auth, tokens, owner, event, invoke, proxy };
}

describe('API proxy allowlist', () => {
  it.each([
    ['GET', '/api/documents'],
    ['PATCH', '/api/documents/d-1'],
    ['POST', '/api/chat'],
    ['POST', '/api/invites/lookup'],
    ['GET', '/api/enhancements/e/stream'],
    ['GET', '/api/workspaces/w/export'],
    ['POST', '/api/workspaces/w/join-requests/r/approve'],
    ['DELETE', '/api/calendar/google'],
    ['GET', '/api/tasks/assignees'],
    ['PUT', '/api/integrations/notion/target'],
  ])('allows %s %s', (method, path) => {
    expect(apiProxyUrl({ method: method as BridgeApiRequest['method'], path }, BASE).pathname).toBe(
      path,
    );
  });
  it.each([
    ['GET', '/api/auth/get-session'],
    ['POST', '/api/sign-in/magic-link'],
    ['POST', '/api/stt/token'],
    ['GET', '/api/sync/events'],
    ['GET', '/api/health'],
    ['POST', '/api/integrations/notion/connect'],
    ['GET', '/api/integrations/notion/callback'],
    ['DELETE', '/api/chat'],
    ['GET', '/api/workspaces/mine'],
    ['DELETE', '/api/workspaces/active'],
    ['GET', '/api/unknown'],
    ['GET', '/private'],
    ['GET', '//evil.test/api/profile'],
    ['GET', '/api/../api/profile'],
    ['GET', '/api/documents/a..b'],
    ['GET', '/api//profile'],
    ['GET', '/api/documents/%2e%2e'],
    ['GET', '/api/documents/%2Fauth'],
    ['GET', '/api/documents/%5Cauth'],
    ['GET', '/api/documents/%252e%252e'],
    ['GET', '/api/documents/a\\b'],
    ['GET', '/api/profile?q=x'],
    ['GET', '/api/profile#x'],
    ['GET', '/api/documents/é'],
    ['GET', '/api/documents/a\u0000b'],
    ['GET', '/api/documents/a\u007fb'],
    ['GET', '/api/documents/a;b'],
    ['GET', 'https://evil.test/api/profile'],
  ])('denies %s %s', (method, path) => {
    expect(() =>
      apiProxyUrl({ method: method as BridgeApiRequest['method'], path }, BASE),
    ).toThrow();
  });
});

it('attaches main token/user-agent, follows no redirects, preserves HTTP envelopes, and exposes no headers', async () => {
  const s = await setup();
  s.fetcher.mockResolvedValueOnce(
    Response.json(
      { error: { code: 'stale_version', message: 'Changed' } },
      { status: 409, headers: { 'set-cookie': 'private', authorization: 'secret' } },
    ),
  );
  const result = await s.invoke('api:request', {
    method: 'PATCH',
    path: '/api/documents/d',
    query: { q: 'a b', nil: null },
    body: { title: 'Hi', baseVersion: 1 },
  });
  expect(result).toEqual({
    ok: true,
    value: { status: 409, body: { error: { code: 'stale_version', message: 'Changed' } } },
  });
  const [url, init] = s.fetcher.mock.calls[0]!;
  expect(String(url)).toBe(BASE + '/api/documents/d?q=a+b');
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer main-only-secret');
  expect(new Headers(init?.headers).get('user-agent')).toBe('Oat-Desktop/Test');
  expect(init).toMatchObject({ redirect: 'error', body: '{"title":"Hi","baseVersion":1}' });
  expect(JSON.stringify(result)).not.toContain('secret');
  s.proxy.dispose();
});

it('returns 204 as null; signed out is unauthorized; offline is unavailable; rejected sessions clear persisted auth', async () => {
  const s = await setup();
  s.fetcher.mockResolvedValueOnce(new Response(null, { status: 204 }));
  expect(await s.invoke('api:request', { method: 'DELETE', path: '/api/templates/t' })).toEqual({
    ok: true,
    value: { status: 204, body: null },
  });
  s.fetcher.mockRejectedValueOnce(new TypeError('offline main-only-secret'));
  expect((await s.invoke('api:request', { method: 'GET', path: '/api/profile' })).error.code).toBe(
    'unavailable',
  );
  s.fetcher.mockResolvedValueOnce(
    Response.json({ error: { code: 'unauthorized', message: 'Expired' } }, { status: 401 }),
  );
  expect(
    (await s.invoke('api:request', { method: 'GET', path: '/api/profile' })).value.status,
  ).toBe(401);
  expect(s.auth.signedIn).toBe(false);
  expect(s.tokens.clear).toHaveBeenCalledOnce();
  expect(s.store.state.auth.status).toBe('signed-out');
  expect(
    (await s.invoke('api:stream-open', { method: 'POST', path: '/api/chat' })).error.code,
  ).toBe('unauthorized');
  expect(s.owner.listenerCount('destroyed')).toBe(0);
  expect((await s.invoke('api:request', { method: 'GET', path: '/api/profile' })).error.code).toBe(
    'unauthorized',
  );
  s.proxy.dispose();
});

it('uses the existing sender checks and strict schemas before dispatch', async () => {
  const s = await setup(false);
  expect(
    (
      await s.invoke(
        'api:request',
        { method: 'GET', path: '/api/profile' },
        { ...s.event, senderFrame: { url: 'https://evil.test', parent: null } },
      )
    ).error.code,
  ).toBe('forbidden');
  expect(
    (await s.invoke('api:request', { method: 'GET', path: '/api/profile', token: 'no' })).error
      .code,
  ).toBe('invalid_payload');
  expect(s.fetcher).not.toHaveBeenCalled();
  s.proxy.dispose();
});

it('retains the plain request timeout and gives streams no overall timeout', async () => {
  const s = await setup();
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  try {
    s.fetcher.mockResolvedValueOnce(
      new Response('', { headers: { 'content-type': 'text/event-stream' } }),
    );
    await s.invoke('api:stream-open', { method: 'POST', path: '/api/chat' });
    expect(timeout).not.toHaveBeenCalled();
    await s.invoke('api:request', { method: 'GET', path: '/api/profile' });
    expect(timeout).toHaveBeenCalledWith(10_000);
  } finally {
    timeout.mockRestore();
    s.proxy.dispose();
  }
});

it('preserves non-JSON HTTP failures as status/null and handles stream 401 like api:me', async () => {
  const s = await setup();
  s.fetcher.mockResolvedValueOnce(new Response('gateway failed', { status: 502 }));
  expect(await s.invoke('api:request', { method: 'GET', path: '/api/profile' })).toEqual({
    ok: true,
    value: { status: 502, body: null },
  });
  s.fetcher.mockResolvedValueOnce(
    Response.json({ error: { code: 'unauthorized', message: 'Expired' } }, { status: 401 }),
  );
  const result = await s.invoke('api:stream-open', { method: 'POST', path: '/api/chat' });
  expect(result.value.status).toBe(401);
  expect(s.auth.signedIn).toBe(false);
  expect(s.tokens.clear).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(s.owner.messages.at(-1)?.channel).toBe('api:stream-end'));
  expect(s.owner.messages.some((message) => message.channel === 'api:stream-chunk')).toBe(true);
  s.proxy.dispose();
});

it('forwards stream chunks in order with split UTF-8 and only safe headers, then cleans up listeners', async () => {
  const s = await setup();
  const bytes = new TextEncoder().encode('é');
  s.fetcher.mockResolvedValueOnce(
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(bytes.slice(0, 1));
          c.enqueue(bytes.slice(1));
          c.enqueue(new TextEncoder().encode('\n'));
          c.close();
        },
      }),
      {
        headers: {
          'content-type': 'text/event-stream',
          'x-vercel-ai-ui-message-stream': 'v1',
          'x-oat-thread-id': 'th1',
          'set-cookie': 'secret',
          authorization: 'secret',
        },
      },
    ),
  );
  const result = await s.invoke('api:stream-open', { method: 'POST', path: '/api/chat', body: {} });
  expect(result.value.headers).toEqual({
    'content-type': 'text/event-stream',
    'x-vercel-ai-ui-message-stream': 'v1',
    'x-oat-thread-id': 'th1',
  });
  await vi.waitFor(() => expect(s.owner.messages.at(-1)?.channel).toBe('api:stream-end'));
  expect(
    s.owner.messages
      .filter((message) => message.channel === 'api:stream-chunk')
      .map((message) => (message.payload as { chunk: string }).chunk),
  ).toEqual(['é', '\n']);
  expect(s.owner.listenerCount('destroyed')).toBe(0);
  expect(s.owner.listenerCount('did-start-navigation')).toBe(0);
  s.proxy.dispose();
});

it.each(['cancel', 'destroyed', 'did-start-navigation', 'sign-out'] as const)(
  'aborts upstream on %s and refuses cross-window cancellation',
  async (reason) => {
    const s = await setup();
    let signal: AbortSignal | undefined;
    s.fetcher.mockImplementationOnce(async (_url, init) => {
      signal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream({
          start(controller) {
            signal?.addEventListener('abort', () => controller.error(new Error('aborted')), {
              once: true,
            });
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const opened = await s.invoke('api:stream-open', {
      method: 'GET',
      path: '/api/enhancements/e/stream',
    });
    const other = new Owner();
    other.id = 2;
    expect(
      (
        await s.invoke(
          'api:stream-cancel',
          { streamId: opened.value.streamId },
          { ...s.event, sender: other },
        )
      ).error.code,
    ).toBe('forbidden');
    expect(signal?.aborted).toBe(false);
    if (reason === 'cancel')
      await s.invoke('api:stream-cancel', { streamId: opened.value.streamId });
    else if (reason === 'sign-out') s.proxy.cancelAll();
    else {
      if (reason === 'destroyed') s.owner.destroyed = true;
      s.owner.emit(reason);
    }
    expect(signal?.aborted).toBe(true);
    expect(s.owner.listenerCount('destroyed')).toBe(0);
    s.proxy.dispose();
  },
);

it('aborts streams when auth state changes, reports source failures, and rejects binary responses', async () => {
  const s = await setup();
  let signal: AbortSignal | undefined;
  s.fetcher.mockImplementationOnce(async (_url, init) => {
    signal = init?.signal ?? undefined;
    return new Response(
      new ReadableStream({
        start(c) {
          signal?.addEventListener('abort', () => c.error(new Error('aborted')));
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
  await s.invoke('api:stream-open', { method: 'POST', path: '/api/chat' });
  await s.auth.signOut();
  expect(signal?.aborted).toBe(true);
  const b = await setup();
  b.fetcher.mockResolvedValueOnce(
    new Response(
      new ReadableStream({
        start(c) {
          c.error(new Error('secret'));
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    ),
  );
  await b.invoke('api:stream-open', { method: 'POST', path: '/api/chat' });
  await vi.waitFor(() => expect(b.owner.messages.at(-1)?.channel).toBe('api:stream-end'));
  expect(b.owner.messages.at(-1)?.payload).toMatchObject({ error: { code: 'unavailable' } });
  expect(JSON.stringify(b.owner.messages)).not.toContain('secret');
  b.fetcher.mockResolvedValueOnce(
    new Response('zip', { headers: { 'content-type': 'application/zip' } }),
  );
  expect(
    (await b.invoke('api:stream-open', { method: 'GET', path: '/api/workspaces/w/export' })).error
      .code,
  ).toBe('unavailable');
  s.proxy.dispose();
  b.proxy.dispose();
});
