import { createOatClient } from '@oat/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { meetingAssistantHandle } from './meeting-assistant';
import { NoteAutosave } from './note-autosave';

const call = vi.hoisted(() => vi.fn());
vi.mock('../bridge', () => ({ call }));
beforeEach(() => {
  call.mockReset();
  call.mockResolvedValue({ conflict: null });
});
const original = { type: 'doc' as const, content: [] };
const next = {
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Approved' }] }],
};
function setup() {
  const save = vi.fn(async () => {});
  const autosave = new NoteAutosave({ base: { title: 'Note', contentJson: original }, save });
  const transport = vi.fn(async () => ({
    status: 200,
    json: async () => ({ title: 'Note', contentJson: original }),
  }));
  const adopt = vi.fn();
  const handle = meetingAssistantHandle({
    documentId: 'd1',
    autosave,
    client: createOatClient(transport),
    adopt,
  });
  return { handle, autosave, save, transport, adopt };
}
it('flushes pending local edits before sync and checking server visibility', async () => {
  const env = setup();
  env.autosave.queue({ contentJson: original });
  expect(await env.handle.settle()).toBe(true);
  expect(env.save.mock.invocationCallOrder[0]).toBeLessThan(call.mock.invocationCallOrder[0]!);
  expect(call).toHaveBeenCalledWith('sync:now');
  expect(call.mock.invocationCallOrder[0]).toBeLessThan(env.transport.mock.invocationCallOrder[0]!);
  expect(env.adopt).not.toHaveBeenCalled();
  env.autosave.dispose();
});
it('allows a saved empty note without creating a local write', async () => {
  const env = setup();
  expect(await env.handle.settle()).toBe(true);
  expect(env.save).not.toHaveBeenCalled();
  expect(call.mock.calls.some(([channel]) => channel === 'meeting:save')).toBe(false);
});
it('blocks unsaved, offline and not-yet-synced edits without applying anything', async () => {
  const env = setup();
  env.save.mockRejectedValueOnce(new Error('Disk unavailable'));
  env.autosave.queue({ contentJson: original });
  expect(await env.handle.settle()).toBe(false);
  expect(call).not.toHaveBeenCalled();
  env.autosave.dispose();
  const unsynced = setup();
  unsynced.autosave.rebase({ title: 'New local title', contentJson: original });
  expect(await unsynced.handle.settle()).toBe(false);
  call.mockRejectedValueOnce(new Error('Offline'));
  await expect(unsynced.handle.settle()).rejects.toThrow('Offline');
  expect(unsynced.adopt).not.toHaveBeenCalled();
});
it('persists the explicitly approved body through meeting:save, then updates the editor', async () => {
  const env = setup();
  expect(call).not.toHaveBeenCalled();
  const apply = env.handle.prepareApply!();
  expect(call).not.toHaveBeenCalled();
  await apply({ version: 4, contentJson: next });
  expect(call).toHaveBeenCalledWith('meeting:save', {
    documentId: 'd1',
    base: { title: 'Note', contentJson: original },
    contentJson: next,
  });
  expect(env.autosave.base?.contentJson).toEqual(next);
  expect(env.adopt).toHaveBeenCalledWith(next);
});
it('keeps the editor and base intact on write failure or concurrent-change conflict', async () => {
  const env = setup();
  const apply = env.handle.prepareApply!();
  call.mockRejectedValueOnce(new Error('Disk unavailable'));
  await expect(apply({ version: 4, contentJson: next })).rejects.toThrow('Disk unavailable');
  call.mockResolvedValueOnce({ conflict: { documentId: 'copy' } });
  await expect(apply({ version: 4, contentJson: next })).rejects.toThrow('Conflicted copies');
  expect(env.adopt).not.toHaveBeenCalled();
  expect(env.autosave.base?.contentJson).toEqual(original);
});
it('keeps the pre-approval write base even when a later sync rebases the editor', async () => {
  const env = setup();
  const apply = env.handle.prepareApply!();
  const newer = {
    type: 'doc' as const,
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Newer synced edit' }] }],
  };
  env.autosave.rebase({ title: 'Note', contentJson: newer });
  call.mockResolvedValueOnce({ conflict: { documentId: 'copy' } });
  await expect(apply({ version: 4, contentJson: next })).rejects.toThrow('Conflicted copies');
  expect(call).toHaveBeenCalledWith(
    'meeting:save',
    expect.objectContaining({ base: { title: 'Note', contentJson: original } }),
  );
  expect(env.autosave.base?.contentJson).toEqual(newer);
  expect(env.adopt).not.toHaveBeenCalled();
});
it('refuses approval if new edits became pending after preparation', async () => {
  const env = setup();
  const apply = env.handle.prepareApply!();
  env.autosave.queue({ title: 'Typed while approving' });
  await expect(apply({ version: 4, contentJson: next })).rejects.toThrow('latest edits');
  expect(call).not.toHaveBeenCalled();
  env.autosave.dispose();
});
