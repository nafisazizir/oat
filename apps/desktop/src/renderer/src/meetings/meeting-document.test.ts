import { createOatClient } from '@oat/client';
import { expect, it, vi } from 'vitest';
import { meetingDocumentAdapter } from './meeting-document';

const contentJson = { type: 'doc', content: [] };
function setup(readOnlyRefresh?: () => Promise<unknown>) {
  const apply = vi.fn(async () => {});
  const assistant = {
    settle: vi.fn(async () => true),
    currentVersion: () => 3,
    prepareApply: vi.fn(() => apply),
    adopt: vi.fn(),
    replace: vi.fn(),
  };
  const transport = vi.fn(async () => ({
    status: 200,
    json: async () => ({ version: 4, contentJson }),
  }));
  const host = meetingDocumentAdapter({
    documentId: 'd',
    client: createOatClient(transport),
    assistant,
    readOnlyRefresh,
  });
  return { host, assistant, apply, transport };
}
it('captures the local writer before enhancement/restore and validates the returned server version/body', async () => {
  const env = setup();
  const apply = env.host.prepareApply();
  expect(env.apply).not.toHaveBeenCalled();
  const newerWriter = vi.fn(async () => {});
  env.assistant.prepareApply.mockReturnValue(newerWriter);
  await apply({ version: 4, contentJson, updatedAt: '2026-11-22' });
  expect(env.apply).toHaveBeenCalledOnce();
  expect(newerWriter).not.toHaveBeenCalled();
});
it.each(['version', 'body'])(
  'does not overwrite a newer server %s with a stale completion event',
  async (field) => {
    const env = setup();
    const apply = env.host.prepareApply();
    await expect(
      apply({
        version: field === 'version' ? 2 : 4,
        contentJson:
          field === 'body' ? { type: 'doc', content: [{ type: 'paragraph' }] } : contentJson,
        updatedAt: '2026-11-22',
      }),
    ).rejects.toThrow('changed again');
    expect(env.apply).not.toHaveBeenCalled();
  },
);
it('does not write when the server is unreachable', async () => {
  const env = setup();
  env.transport.mockRejectedValue(new Error('Offline'));
  await expect(
    env.host.prepareApply()({ version: 4, contentJson, updatedAt: '2026-11-22' }),
  ).rejects.toThrow();
  expect(env.apply).not.toHaveBeenCalled();
});
it('uses an unapplied body only through an explicitly invoked, settled local writer', async () => {
  const env = setup();
  expect(env.apply).not.toHaveBeenCalled();
  await env.host.useBody(contentJson);
  expect(env.assistant.settle.mock.invocationCallOrder[0]).toBeLessThan(
    env.assistant.prepareApply.mock.invocationCallOrder[0]!,
  );
  expect(env.apply).toHaveBeenCalledWith({ version: 3, contentJson });
  expect(env.transport).not.toHaveBeenCalled();
});
it('keeps pending edits when an explicit body replace cannot settle', async () => {
  const env = setup();
  env.assistant.settle.mockResolvedValue(false);
  await expect(env.host.useBody(contentJson)).rejects.toThrow('latest edits');
  expect(env.apply).not.toHaveBeenCalled();
});
it('updates a view-only note through authorized sync without creating an edit/outbox write', async () => {
  const refresh = vi.fn(async () => {});
  const env = setup(refresh);
  await env.host.prepareApply()({ version: 4, contentJson, updatedAt: '2026-11-22' });
  expect(refresh).toHaveBeenCalledOnce();
  expect(env.assistant.prepareApply).not.toHaveBeenCalled();
  expect(env.apply).not.toHaveBeenCalled();
});
it('never offers a body-writing bypass for a view-only note', async () => {
  const env = setup(vi.fn(async () => {}));
  await expect(env.host.useBody(contentJson)).rejects.toThrow('read-only');
  expect(env.apply).not.toHaveBeenCalled();
});
