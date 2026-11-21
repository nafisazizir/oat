import { describe, expect, it, vi } from 'vitest';

import {
  createOatClient,
  fetchTransport,
  OatApiError,
  toFetch,
  type OatTransport,
} from './index.ts';

describe('fetchTransport', () => {
  it('builds URL/query, omits nullish values, preserves false/zero, and sends JSON with signal', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ id: 'doc' }, { status: 201, headers: { 'x-test': 'yes' } }),
      );
    const abort = new AbortController();
    const transport = fetchTransport({ baseUrl: 'https://oat.test/', fetch: fetcher });
    const response = await transport({
      method: 'POST',
      path: '/api/documents',
      query: { q: 'a b/&', empty: '', zero: 0, no: false, absent: undefined, nil: null },
      body: { title: 'Hello' },
      signal: abort.signal,
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://oat.test/api/documents?q=a+b%2F%26&empty=&zero=0&no=false',
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: '{"title":"Hello"}',
        signal: abort.signal,
      },
    );
    expect(response.status).toBe(201);
    expect(response.headers).toMatchObject({ 'x-test': 'yes' });
    expect(await response.json()).toEqual({ id: 'doc' });
  });

  it('defaults to relative URLs and global fetch; omits body headers on GET', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    try {
      await fetchTransport()({ method: 'GET', path: '/api/profile' });
      expect(fetcher).toHaveBeenCalledWith('/api/profile', {
        method: 'GET',
        credentials: 'same-origin',
        signal: undefined,
      });
    } finally {
      fetcher.mockRestore();
    }
  });

  it('supports an explicit credentials policy and a JSON null body', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(null));
    await fetchTransport({ fetch: fetcher, credentials: 'include' })({
      method: 'PUT',
      path: '/api/profile',
      body: null,
    });
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'include',
      body: 'null',
      headers: { 'content-type': 'application/json' },
    });
  });

  it.each([
    '/not-api',
    '/api/../private',
    '//evil.test/api/chat',
    '/api/chat?q=x',
    '/api/chat#fragment',
  ])('rejects invalid transport path %s', async (path) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(fetchTransport({ fetch: fetcher })({ method: 'GET', path })).rejects.toThrow(
      TypeError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('passes the raw stream through', async () => {
    const native = new Response('hello');
    const result = await fetchTransport({ fetch: vi.fn<typeof fetch>().mockResolvedValue(native) })(
      { method: 'GET', path: '/api/chat', stream: true },
    );
    expect(result.body).toBe(native.body);
    expect(await new Response(result.body).text()).toBe('hello');
  });
});

describe('request results and errors', () => {
  it('parses the error envelope and preserves extra error details', async () => {
    const details = {
      error: { code: 'stale_version', message: 'Try again' },
      document: { id: 'd' },
    };
    const client = createOatClient(async () => ({ status: 409, json: async () => details }));
    await expect(client.documents.get('d')).rejects.toMatchObject({
      name: 'OatApiError',
      status: 409,
      code: 'stale_version',
      message: 'Try again',
      details,
    });
  });

  it.each([null, { error: 'unauthorized' }, { error: { code: 42, message: 'No' } }])(
    'handles malformed errors %j',
    async (value) => {
      const client = createOatClient(async () => ({ status: 502, json: async () => value }));
      await expect(client.profile.get()).rejects.toMatchObject({ status: 502, code: 'http_error' });
    },
  );

  it('handles a non-JSON HTTP error', async () => {
    const client = createOatClient(async () => ({
      status: 500,
      json: async () => {
        throw new SyntaxError('html');
      },
    }));
    await expect(client.profile.get()).rejects.toBeInstanceOf(OatApiError);
    await expect(client.profile.get()).rejects.toMatchObject({ status: 500, code: 'http_error' });
  });

  it('maps offline transport failures to unavailable', async () => {
    const client = createOatClient(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(client.profile.get()).rejects.toMatchObject({ status: 0, code: 'unavailable' });
  });

  it('maps an explicit status zero to unavailable', async () => {
    const client = createOatClient(async () => ({ status: 0, json: async () => null }));
    await expect(client.profile.get()).rejects.toMatchObject({ status: 0, code: 'unavailable' });
  });

  it('returns undefined for 204 without decoding JSON', async () => {
    const json = vi.fn();
    const client = createOatClient(async () => ({ status: 204, json }));
    expect(await client.templates.delete('t')).toBeUndefined();
    expect(json).not.toHaveBeenCalled();
  });

  it('preserves JSON null', async () => {
    const client = createOatClient(async () => ({ status: 200, json: async () => null }));
    expect(await client.notion.status('w')).toBeNull();
  });

  it('does not send an already aborted request', async () => {
    const transport = vi.fn<OatTransport>();
    const signal = AbortSignal.abort();
    await expect(createOatClient(transport).profile.get({ signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('passes an abort signal through fetch and preserves AbortError', async () => {
    const abort = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const pending = createOatClient(fetchTransport({ fetch: fetcher })).profile.get({
      signal: abort.signal,
    });
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBe(abort.signal);
  });
});

describe('toFetch', () => {
  it('preserves query names that match object prototype properties', async () => {
    const transport = vi
      .fn<OatTransport>()
      .mockResolvedValue({ status: 204, json: async () => null });
    await toFetch(transport)('/api/search?toString=x&__proto__=y');
    const query = transport.mock.calls[0]?.[0].query;
    expect(Object.entries(query ?? {})).toEqual([
      ['toString', 'x'],
      ['__proto__', 'y'],
    ]);
  });

  it('accepts an API path, parses JSON and returns a streaming Response with SDK headers', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: [DONE]\\n\\n'));
        controller.close();
      },
    });
    const transport = vi.fn<OatTransport>().mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
      json: async () => null,
      body,
    });
    const abort = new AbortController();
    const response = await toFetch(transport)('/api/chat?resume=true', {
      method: 'POST',
      body: JSON.stringify({ messages: [] }),
      signal: abort.signal,
    });
    expect(transport.mock.calls[0]?.[0]).toMatchObject({
      method: 'POST',
      path: '/api/chat',
      query: { resume: 'true' },
      body: { messages: [] },
      stream: true,
    });
    expect(transport.mock.calls[0]?.[0].signal?.aborted).toBe(false);
    expect(response).toBeInstanceOf(Response);
    expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
    expect(await response.text()).toBe('data: [DONE]\\n\\n');
  });

  it('supports Request objects, URL inputs and init overrides', async () => {
    const transport = vi.fn<OatTransport>().mockResolvedValue({ status: 204, json: vi.fn() });
    const fetcher: typeof fetch = toFetch(transport);
    const response = await fetcher(
      new Request('https://oat.test/api/tasks/t', { method: 'PATCH', body: '{"done":false}' }),
      { body: '{"done":true}' },
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(transport.mock.calls[0]?.[0]).toMatchObject({
      method: 'PATCH',
      path: '/api/tasks/t',
      body: { done: true },
    });
    await fetcher(new URL('https://oat.test/api/profile'));
    expect(transport.mock.calls[1]?.[0]).toMatchObject({ method: 'GET', path: '/api/profile' });
  });

  it('retains fetch HTTP error semantics and serializes JSON-only transport results', async () => {
    const transport: OatTransport = async () => ({
      status: 403,
      headers: { 'x-test': 'yes' },
      json: async () => ({ error: { code: 'forbidden', message: 'No' } }),
    });
    const response = await toFetch(transport)('/api/profile');
    expect(response.ok).toBe(false);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: 'forbidden', message: 'No' } });
    expect(response.headers.get('x-test')).toBe('yes');
  });

  it.each(['/profile', 'https://oat.test/private', 'file:///api/chat', '/api/../profile'])(
    'rejects non-API fetch URL %s',
    async (input) => {
      const transport = vi.fn<OatTransport>();
      await expect(toFetch(transport)(input)).rejects.toThrow(TypeError);
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it('rejects unsupported methods, non-JSON bodies, and repeated query keys', async () => {
    const fetcher = toFetch(vi.fn<OatTransport>());
    await expect(fetcher('/api/chat', { method: 'HEAD' })).rejects.toThrow(TypeError);
    await expect(fetcher('/api/chat', { method: 'POST', body: 'not json' })).rejects.toThrow(
      SyntaxError,
    );
    await expect(fetcher('/api/chat?a=1&a=2')).rejects.toThrow(TypeError);
  });

  it('maps offline failures and propagates cancellation', async () => {
    await expect(
      toFetch(async () => {
        throw new TypeError('offline');
      })('/api/chat'),
    ).rejects.toMatchObject({ status: 0, code: 'unavailable' });
    const controller = new AbortController();
    const transport: OatTransport = async (req) => {
      controller.abort();
      req.signal?.throwIfAborted();
      throw new Error('unreachable');
    };
    await expect(
      toFetch(transport)('/api/chat', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('cancels the underlying stream when the Response body is cancelled', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const response = await toFetch(async () => ({ status: 200, body, json: async () => null }))(
      '/api/chat',
    );
    await response.body?.cancel();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
