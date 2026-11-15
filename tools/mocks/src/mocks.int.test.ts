import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoggedRequest } from './request-log.ts';
import { startMocks, type RunningMocks } from './server.ts';

// Provider behaviour is tested against an in-process `startMocks()` instance: it runs this checkout's code
// and its state is private to this test run. The shared container from `pnpm dev:up` only gets a read-only
// smoke test (it is built from whichever checkout last ran `pnpm dev:build`, normally main, and other
// worktrees' runs use it concurrently, so never `POST /_reset` it from tests).

describe('mocks over HTTP (in-process)', () => {
  let mocks: RunningMocks;
  beforeAll(async () => {
    mocks = await startMocks();
  });
  afterAll(() => mocks.close());

  const requests = async (query = '') =>
    (
      (await (await fetch(`${mocks.url}/_requests${query}`)).json()) as {
        requests: LoggedRequest[];
      }
    ).requests;

  it('records provider calls at /_requests', async () => {
    const marker = randomUUID();
    await fetch(`${mocks.url}/example/echo?marker=${marker}`, { method: 'POST', body: marker });
    expect((await requests('?provider=example')).at(-1)).toMatchObject({
      method: 'POST',
      path: '/example/echo',
      query: { marker },
      body: marker,
      status: 200,
    });
  });

  it('POST /_reset?provider= clears that provider only', async () => {
    await fetch(`${mocks.url}/example/counter`, { method: 'POST' });
    await fetch(`${mocks.url}/other/thing`);
    const res = await fetch(`${mocks.url}/_reset?provider=example`, { method: 'POST' });
    expect(await res.json()).toEqual({ ok: true, provider: 'example' });
    expect((await requests()).map((r) => r.provider)).toEqual(['other']);
    expect(await (await fetch(`${mocks.url}/example/counter`)).json()).toEqual({ count: 0 });
  });
});

describe('mocks container (compose, read-only smoke test)', () => {
  const MOCKS_URL = (process.env.MOCKS_URL || 'http://localhost:14010').replace(/\/$/, '');

  it('GET /health is 200 JSON', async () => {
    const res = await fetch(`${MOCKS_URL}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toMatchObject({ status: 'ok', service: '@oat/mocks' });
  });

  it('GET /_requests is served', async () => {
    const res = await fetch(`${MOCKS_URL}/_requests?limit=1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('requests');
  });
});
