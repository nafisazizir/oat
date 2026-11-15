import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import type { LoggedRequest } from './request-log.ts';

async function requests(app: Hono, query = ''): Promise<LoggedRequest[]> {
  const res = await app.request(`/_requests${query}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { requests: LoggedRequest[] }).requests;
}

describe('mocks app', () => {
  it('GET /health reports ok and the mounted providers', async () => {
    const { app } = createApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as { status: string; providers: { name: string }[] };
    expect(body.status).toBe('ok');
    expect(body.providers.map((p) => p.name)).toContain('example');
  });

  it('mounts providers under /<name>', async () => {
    const { app } = createApp();
    const res = await app.request('/example/echo?x=1', { method: 'POST', body: '{"hi":true}' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ method: 'POST', query: { x: '1' }, body: '{"hi":true}' });
  });

  it('returns JSON 404 for unknown routes', async () => {
    const { app } = createApp();
    const res = await app.request('/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_found', path: '/nope' });
  });

  it('logs provider calls (not service routes) with body, status and redacted credentials', async () => {
    const { app } = createApp();
    await app.request('/health');
    await app.request('/example/echo?q=2', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    });
    await app.request('/nope/thing');

    const log = await requests(app);
    expect(log.map((r) => [r.method, r.path, r.provider, r.status])).toEqual([
      ['POST', '/example/echo', 'example', 200],
      ['GET', '/nope/thing', 'nope', 404],
    ]);
    const [first] = log;
    expect(first?.query).toEqual({ q: '2' });
    expect(first?.body).toBe('{"a":1}');
    expect(first?.headers.authorization).toBe('Bearer [redacted]');
    expect(first?.headers['content-type']).toBe('application/json');
  });

  it('lets providers read a body the logger already consumed', async () => {
    const app = new Hono();
    app.post('/json', async (c) => c.json(await c.req.json()));
    const { app: mocks } = createApp({
      providers: [() => ({ name: 'p', description: 'test', app })],
    });
    const res = await mocks.request('/p/json', { method: 'POST', body: '{"ok":1}' });
    expect(await res.json()).toEqual({ ok: 1 });
  });

  it('GET /_requests filters by provider/since/limit and validates input', async () => {
    const { app } = createApp();
    await app.request('/example/counter');
    await app.request('/other');
    await app.request('/example/counter');
    expect((await requests(app, '?provider=example')).map((r) => r.id)).toEqual([1, 3]);
    expect((await requests(app, '?since=1&limit=1')).map((r) => r.id)).toEqual([3]);
    expect((await app.request('/_requests?limit=-1')).status).toBe(400);
  });

  it('POST /_reset clears the log and resets provider state', async () => {
    const { app } = createApp();
    await app.request('/example/counter', { method: 'POST' });
    await app.request('/example/counter', { method: 'POST' });
    expect(await (await app.request('/example/counter')).json()).toEqual({ count: 2 });

    const res = await app.request('/_reset', { method: 'POST' });
    expect(await res.json()).toEqual({ ok: true });
    expect(await requests(app)).toEqual([]);
    expect(await (await app.request('/example/counter')).json()).toEqual({ count: 0 });
  });

  it('POST /_reset?provider=<name> resets only that provider and its log entries', async () => {
    const reset = { a: 0, b: 0 };
    const p = (name: 'a' | 'b') => () => {
      const app = new Hono();
      app.get('/x', (c) => c.text(name));
      return { name, description: '', app, reset: () => void reset[name]++ };
    };
    const { app } = createApp({ providers: [p('a'), p('b')] });
    await app.request('/a/x');
    await app.request('/b/x');

    const res = await app.request('/_reset?provider=a', { method: 'POST' });
    expect(await res.json()).toEqual({ ok: true, provider: 'a' });
    expect(reset).toEqual({ a: 1, b: 0 });
    expect((await requests(app)).map((r) => r.provider)).toEqual(['b']);

    const unknown = await app.request('/_reset?provider=nope', { method: 'POST' });
    expect(unknown.status).toBe(404);
    expect(reset).toEqual({ a: 1, b: 0 });
  });

  it('gives each app instance its own provider state', async () => {
    const a = createApp().app;
    const b = createApp().app;
    await a.request('/example/counter', { method: 'POST' });
    expect(await (await b.request('/example/counter')).json()).toEqual({ count: 0 });
  });

  it('rejects invalid or duplicate provider names', () => {
    const p = (name: string) => () => ({ name, description: '', app: new Hono() });
    expect(() => createApp({ providers: [p('Bad Name')] })).toThrow(/invalid/);
    expect(() => createApp({ providers: [p('_reset')] })).toThrow(/invalid/);
    expect(() => createApp({ providers: [p('health')] })).toThrow(/invalid/);
    expect(() => createApp({ providers: [p('a'), p('a')] })).toThrow(/duplicate/);
  });
});
