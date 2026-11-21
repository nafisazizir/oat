import { createOatClient, type OatRequest, type OatTransport } from '@oat/client';
import { describe, expect, it, vi } from 'vitest';
import { loadShellData } from './load-shell-data';

const user = { id: 'u', name: 'User', email: 'user@test.com', image: null };
const workspace = {
  id: 'w',
  name: 'Work',
  slug: 'work',
  icon: '🌱',
  role: 'owner',
  memberCount: 2,
  joinedAt: '2026-01-01',
};

function fake(workspaces = [workspace], fail = false) {
  const transport = vi.fn<OatTransport>(async (request: OatRequest) => {
    if (fail) throw new Error('offline');
    const body =
      request.path === '/api/workspaces'
        ? { workspaces, activeWorkspaceId: 'w' }
        : request.path === '/api/workspaces/joinable'
          ? { invites: [{}], workspaces: [] }
          : request.path === '/api/folders'
            ? [{ id: 'f', name: 'Folder', parentId: null }]
            : [
                {
                  id: request.query?.trash ? 'trash' : 'doc',
                  title: 'Page',
                  folderId: 'f',
                  kind: 'page',
                },
              ];
    return { status: 200, json: async () => body };
  });
  return { client: createOatClient(transport), transport };
}

describe('loadShellData', () => {
  it('loads the active workspace, tree, trash and join choices through REST', async () => {
    const { client, transport } = fake();
    const data = await loadShellData(client, user);
    expect(data.workspace).toMatchObject({ id: 'w', members: 2, icon: '🌱' });
    expect(data.documents).toMatchObject([
      { id: 'f', kind: 'folder' },
      { id: 'doc', parentId: 'f' },
    ]);
    expect(data.trash).toMatchObject([{ id: 'trash' }]);
    expect(data.canJoin).toBe(true);
    expect(transport.mock.calls.map(([request]) => request.query)).toContainEqual({
      workspaceId: 'w',
      trash: true,
    });
  });
  it('rejects an empty membership list', async () => {
    await expect(loadShellData(fake([]).client, user)).rejects.toThrow(
      'signed-in user has no workspace',
    );
  });
  it('propagates API failures', async () => {
    await expect(loadShellData(fake([workspace], true).client, user)).rejects.toThrow(
      'Couldn’t reach Oat',
    );
  });
});
