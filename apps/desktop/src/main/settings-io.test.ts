import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { createSettingsIo } from './settings-io';

const BASE = 'https://oat.example.test';

function setup(chooseZip: () => Promise<string | null> = async () => null) {
  const request = vi.fn<Parameters<typeof createSettingsIo>[0]['request']>();
  const openExternal = vi.fn(async () => {});
  const io = createSettingsIo({
    baseUrl: BASE,
    withSession: (run) => run('desktop-session'),
    request,
    chooseZip,
    openExternal,
  });
  return { io, request, openExternal };
}

it('writes the ZIP byte-for-byte in the selected destination and cleans partial downloads', async () => {
  const dir = await mkdtemp(join(homedir(), 'oat-export-test-'));
  try {
    const path = join(dir, 'notes.zip');
    const { io, request } = setup(async () => path);
    const zip = new Uint8Array([80, 75, 3, 4, 0, 255, 129]);
    request.mockResolvedValueOnce(
      new Response(zip, {
        headers: { 'content-type': 'application/zip', 'x-oat-export-count': '2' },
      }),
    );
    expect(await io.exportNotes({ workspaceId: 'team' })).toEqual({ count: 2 });
    expect(await readFile(path)).toEqual(Buffer.from(zip));
    expect(request).toHaveBeenCalledWith(
      '/api/workspaces/team/export',
      expect.objectContaining({ token: 'desktop-session' }),
    );
    request.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new Error('interrupted'));
          },
        }),
        { headers: { 'content-type': 'application/zip', 'x-oat-export-count': '2' } },
      ),
    );
    await expect(io.exportNotes({ workspaceId: 'team' })).rejects.toThrow(/Nothing was saved/);
    expect(await readdir(dir)).toEqual(['notes.zip']);
    expect(await readFile(path)).toEqual(Buffer.from(zip));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('does not fetch when the save dialog is cancelled', async () => {
  const { io, request } = setup();
  expect(await io.exportNotes({ workspaceId: 'team' })).toBeNull();
  expect(request).not.toHaveBeenCalled();
});

it('opens only a same-origin browser consent handoff URL', async () => {
  const { io, request, openExternal } = setup();
  const suffix = '/api/settings/consent/browser?ticket=' + 'a'.repeat(43);
  const input = { workspaceId: 'team', provider: 'notion' as const };
  request.mockResolvedValueOnce(Response.json({ url: 'https://other.example.test' + suffix }));
  await expect(io.connect(input)).rejects.toThrow(/Couldn’t open/);
  expect(openExternal).not.toHaveBeenCalled();
  request.mockResolvedValueOnce(Response.json({ url: BASE + suffix }));
  await io.connect(input);
  expect(openExternal).toHaveBeenCalledExactlyOnceWith(BASE + suffix);
});
