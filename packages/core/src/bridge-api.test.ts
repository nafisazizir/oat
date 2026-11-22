import { expect, it } from 'vitest';

import { bridgeContract } from './bridge.ts';

const schema = bridgeContract.invoke['api:request'].request;
it('accepts JSON requests and primitive queries without a body limit', () => {
  expect(
    schema.parse({
      method: 'POST',
      path: '/api/chat',
      query: { a: 1, b: false, c: null, d: 'text' },
      body: { text: 'x'.repeat(100_000) },
    }).body,
  ).toBeDefined();
  expect(schema.parse({ method: 'GET', path: '/api/profile' })).toEqual({
    method: 'GET',
    path: '/api/profile',
  });
});
it.each([
  { method: 'HEAD', path: '/api/chat' },
  { method: 'GET', path: '/api/' + 'a'.repeat(2049) },
  { method: 'GET', path: '/api/chat', token: 'no' },
  { method: 'GET', path: '/api/chat', query: { nested: {} } },
  { method: 'POST', path: '/api/chat', body: () => {} },
])('rejects invalid or extra request fields %j', (value) => {
  expect(schema.safeParse(value).success).toBe(false);
  expect(bridgeContract.invoke['api:stream-open'].request.safeParse(value).success).toBe(false);
});
it('validates strict stream events, cancel, headers, and HTTP failures as values', () => {
  expect(
    bridgeContract.invoke['api:request'].response.parse({
      status: 403,
      body: { error: { code: 'forbidden', message: 'No' } },
    }).status,
  ).toBe(403);
  expect(
    bridgeContract.invoke['api:request'].response.parse({ status: 204, body: null }).body,
  ).toBeNull();
  expect(
    bridgeContract.invoke['api:stream-open'].response.parse({
      streamId: 's',
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }).streamId,
  ).toBe('s');
  expect(
    bridgeContract.invoke['api:stream-cancel'].request.safeParse({ streamId: 's', extra: true })
      .success,
  ).toBe(false);
  expect(
    bridgeContract.subscribe['api:stream-chunk'].parse({ streamId: 's', chunk: 'é' }).chunk,
  ).toBe('é');
  expect(
    bridgeContract.subscribe['api:stream-end'].parse({
      streamId: 's',
      error: { code: 'unavailable', message: 'Offline' },
    }).error?.code,
  ).toBe('unavailable');
  expect(
    bridgeContract.subscribe['api:stream-end'].safeParse({ streamId: 's', token: 'no' }).success,
  ).toBe(false);
});
