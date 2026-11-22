import type { OatBridge } from '@oat/core/bridge';
import { expect, it, vi } from 'vitest';

import { bridgeTransport } from './bridge.ts';
import { createOatClient, OatApiError } from './index.ts';

function setup() {
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const invoke = vi.fn<(channel: string, payload: unknown) => Promise<unknown>>();
  const oat = {
    invoke,
    subscribe(channel: string, listener: (value: unknown) => void) {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
      return () => set.delete(listener);
    },
  } as unknown as Pick<OatBridge, 'invoke' | 'subscribe'>;
  return {
    invoke,
    transport: bridgeTransport(oat),
    emit(channel: string, value: unknown) {
      for (const listener of listeners.get(channel) ?? []) listener(value);
    },
    count: () => [...listeners.values()].reduce((count, set) => count + set.size, 0),
  };
}
const opened = {
  ok: true,
  value: { streamId: 's', status: 200, headers: { 'content-type': 'text/event-stream' } },
};

it('dispatches JSON without signals/secrets, returns null and maps HTTP errors into OatApiError', async () => {
  const fake = setup();
  fake.invoke.mockResolvedValueOnce({ ok: true, value: { status: 204, body: null } });
  expect(await createOatClient(fake.transport).templates.delete('t')).toBeUndefined();
  expect(fake.invoke).toHaveBeenCalledWith('api:request', {
    method: 'DELETE',
    path: '/api/templates/t',
  });
  fake.invoke.mockResolvedValueOnce({
    ok: true,
    value: { status: 409, body: { error: { code: 'stale_version', message: 'Changed' } } },
  });
  await expect(createOatClient(fake.transport).documents.get('d')).rejects.toMatchObject({
    status: 409,
    code: 'stale_version',
    message: 'Changed',
  });
});
it.each([
  ['unavailable', 0],
  ['unauthorized', 401],
  ['forbidden', 403],
] as const)('maps bridge %s failures', async (code, status) => {
  const fake = setup();
  fake.invoke.mockResolvedValue({ ok: false, error: { code, message: 'No' } });
  await expect(createOatClient(fake.transport).profile.get()).rejects.toMatchObject({
    status,
    code,
  });
});
it('buffers early events, preserves UTF-8/order and ignores other stream ids', async () => {
  const fake = setup();
  fake.invoke.mockImplementation(async () => {
    fake.emit('api:stream-chunk', { streamId: 'other', chunk: 'wrong' });
    fake.emit('api:stream-chunk', { streamId: 's', chunk: 'data: é\n' });
    fake.emit('api:stream-chunk', { streamId: 's', chunk: '\n' });
    fake.emit('api:stream-end', { streamId: 's' });
    return opened;
  });
  const response = await fake.transport({
    method: 'GET',
    path: '/api/enhancements/e/stream',
    stream: true,
  });
  expect(await new Response(response.body).text()).toBe('data: é\n\n');
  expect(response.headers).toEqual({ 'content-type': 'text/event-stream' });
  expect(fake.count()).toBe(0);
});
it('reader cancellation cancels main and unsubscribes', async () => {
  const fake = setup();
  fake.invoke.mockResolvedValueOnce(opened).mockResolvedValue({ ok: true });
  const response = await fake.transport({ method: 'POST', path: '/api/chat', stream: true });
  await response.body?.cancel();
  expect(fake.invoke).toHaveBeenLastCalledWith('api:stream-cancel', { streamId: 's' });
  expect(fake.count()).toBe(0);
});
it('signal abort errors the reader and cancels main', async () => {
  const fake = setup();
  fake.invoke.mockResolvedValueOnce(opened).mockResolvedValue({ ok: true });
  const abort = new AbortController();
  const response = await fake.transport({
    method: 'POST',
    path: '/api/chat',
    stream: true,
    signal: abort.signal,
  });
  const read = response.body!.getReader().read();
  abort.abort();
  await expect(read).rejects.toMatchObject({ name: 'AbortError' });
  expect(fake.invoke).toHaveBeenLastCalledWith('api:stream-cancel', { streamId: 's' });
  expect(fake.count()).toBe(0);
});
it('abort during stream-open stops waiting and cancels as soon as main returns its id', async () => {
  const fake = setup();
  let resolve!: (value: unknown) => void;
  fake.invoke
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValue({ ok: true });
  const abort = new AbortController();
  const pending = fake.transport({
    method: 'POST',
    path: '/api/chat',
    stream: true,
    signal: abort.signal,
  });
  abort.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  resolve(opened);
  await vi.waitFor(() =>
    expect(fake.invoke).toHaveBeenLastCalledWith('api:stream-cancel', { streamId: 's' }),
  );
  expect(fake.count()).toBe(0);
});
it('delivers stream failures and cleans up failed opens', async () => {
  const fake = setup();
  fake.invoke.mockResolvedValueOnce(opened);
  const response = await fake.transport({
    method: 'GET',
    path: '/api/enhancements/e/stream',
    stream: true,
  });
  const text = new Response(response.body).text();
  fake.emit('api:stream-end', { streamId: 's', error: { code: 'unavailable', message: 'Broken' } });
  await expect(text).rejects.toBeInstanceOf(OatApiError);
  expect(fake.count()).toBe(0);
  fake.invoke.mockResolvedValueOnce({ ok: false, error: { code: 'unauthorized', message: 'No' } });
  await expect(
    fake.transport({ method: 'POST', path: '/api/chat', stream: true }),
  ).rejects.toMatchObject({ status: 401 });
  expect(fake.count()).toBe(0);
});
it('does not dispatch aborted requests and strips undefined query values', async () => {
  const fake = setup();
  await expect(
    fake.transport({ method: 'GET', path: '/api/profile', signal: AbortSignal.abort() }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(fake.invoke).not.toHaveBeenCalled();
  fake.invoke.mockResolvedValue({ ok: true, value: { status: 200, body: null } });
  await fake.transport({
    method: 'GET',
    path: '/api/search',
    query: { q: 'x', absent: undefined, zero: 0 },
  });
  expect(fake.invoke).toHaveBeenCalledWith('api:request', {
    method: 'GET',
    path: '/api/search',
    query: { q: 'x', zero: 0 },
  });
});
