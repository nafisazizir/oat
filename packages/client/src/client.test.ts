import { expect, expectTypeOf, it, vi } from 'vitest';
import type { DocumentDetail } from '@oat/services/dto/api-types';
import type { WorkspaceList } from '@oat/services/dto/workspaces';
import type { ChatSendInput } from '@oat/services/dto/chat';

import { createOatClient, type OatTransport } from './index.ts';

const mock = () => {
  const transport = vi.fn<OatTransport>().mockResolvedValue({ status: 200, json: async () => [] });
  return { transport, client: createOatClient(transport) };
};

it('encodes path parameters, sends bodies, and preserves the signal', async () => {
  const { client, transport } = mock();
  const signal = new AbortController().signal;
  await client.documents.update('a/b ?#', { baseVersion: 4, title: 'New' }, { signal });
  expect(transport).toHaveBeenLastCalledWith({
    method: 'PATCH',
    path: '/api/documents/a%2Fb%20%3F%23',
    body: { baseVersion: 4, title: 'New' },
    signal,
  });
  await client.workspaces.approveJoinRequest('w', 'req/1', { role: 'member' }, { signal });
  expect(transport).toHaveBeenLastCalledWith({
    method: 'POST',
    path: '/api/workspaces/w/join-requests/req%2F1/approve',
    body: { role: 'member' },
    signal,
  });
});

it('rejects empty and dot-segment IDs without dispatching', async () => {
  const { client, transport } = mock();
  for (const id of ['', '.', '..'])
    await expect(client.documents.get(id)).rejects.toThrow(TypeError);
  expect(transport).not.toHaveBeenCalled();
});

it('uses endpoint-specific query and body conventions', async () => {
  const { client, transport } = mock();
  await client.documents.meeting('d', { transcript: true, after: 0, recording: true });
  expect(transport).toHaveBeenLastCalledWith({
    method: 'GET',
    path: '/api/documents/d/meeting',
    query: { transcript: '1', after: 0, recording: '1' },
  });
  await client.documents.deleteForever('d');
  expect(transport).toHaveBeenLastCalledWith({
    method: 'DELETE',
    path: '/api/documents/d',
    query: { permanent: true },
  });
  await client.workspaces.delete('w', { confirmName: 'Workspace' });
  expect(transport).toHaveBeenLastCalledWith({
    method: 'DELETE',
    path: '/api/workspaces/w',
    body: { confirmName: 'Workspace' },
  });
  await client.invites.accept('token');
  expect(transport).toHaveBeenLastCalledWith({
    method: 'POST',
    path: '/api/invites/accept',
    body: { token: 'token' },
  });
});

it('passes empty list payloads through without validation', async () => {
  const { client } = mock();
  expect(await client.documents.list({ workspaceId: 'w', trash: false })).toEqual([]);
});

it('returns the enhancement stream unchanged and accepts a resume point and signal', async () => {
  const body = new ReadableStream<Uint8Array>();
  const transport = vi
    .fn<OatTransport>()
    .mockResolvedValue({ status: 200, json: async () => null, body });
  const signal = new AbortController().signal;
  expect(
    await createOatClient(transport).enhancements.stream('e', { lastEventId: '1-0' }, { signal }),
  ).toBe(body);
  expect(transport).toHaveBeenCalledWith({
    method: 'GET',
    path: '/api/enhancements/e/stream',
    query: { lastEventId: '1-0' },
    stream: true,
    signal,
  });
});

it('throws HTTP errors before returning a stream, and rejects missing streams', async () => {
  const forbidden = createOatClient(async () => ({
    status: 403,
    json: async () => ({ error: { code: 'forbidden', message: 'No' } }),
  }));
  await expect(forbidden.enhancements.stream('e')).rejects.toMatchObject({
    status: 403,
    code: 'forbidden',
  });
  const empty = createOatClient(async () => ({ status: 200, json: async () => null }));
  await expect(empty.enhancements.stream('e')).rejects.toMatchObject({ code: 'missing_stream' });
});

it('returns streaming Responses for chat and binary workspace exports', async () => {
  const transport: OatTransport = async (request) => ({
    status: 200,
    headers: {
      'content-type': request.path.endsWith('/export') ? 'application/zip' : 'text/event-stream',
    },
    body: new Blob([new Uint8Array([0, 255, 1])]).stream(),
    json: async () => {
      throw new Error('must not decode');
    },
  });
  const client = createOatClient(transport);
  const exported = await client.workspaces.export('w');
  expect(exported.headers.get('content-type')).toBe('application/zip');
  expect(new Uint8Array(await exported.arrayBuffer())).toEqual(new Uint8Array([0, 255, 1]));
  const chat = await client.chat.send({
    scope: { kind: 'workspace', workspaceId: 'w' },
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }],
  });
  expect(chat.headers.get('content-type')).toBe('text/event-stream');
});

it('provides the POST OAuth path helper without dispatching a JSON request', () => {
  const { client, transport } = mock();
  expect(client.notion.connectUrl()).toBe('/api/integrations/notion/connect');
  expect(transport).not.toHaveBeenCalled();
});

it('retains request and response DTO types', () => {
  const { client: _client } = mock();
  expectTypeOf<ReturnType<typeof _client.documents.get>>().toEqualTypeOf<Promise<DocumentDetail>>();
  expectTypeOf<ReturnType<typeof _client.workspaces.list>>().toEqualTypeOf<
    Promise<WorkspaceList>
  >();
  expectTypeOf<Parameters<typeof _client.chat.send>[0]>().toEqualTypeOf<ChatSendInput>();
  expectTypeOf<ReturnType<typeof _client.enhancements.stream>>().toEqualTypeOf<
    Promise<ReadableStream<Uint8Array>>
  >();
});
