// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type * as WorkspaceUi from '@oat/workspace-ui';
import type { DesktopUser, MeetingNoteSummary } from '@oat/core/bridge';
import { useDesktopShellData } from './use-desktop-shell-data';
const model = vi.hoisted(() => ({ load: vi.fn(), call: vi.fn(), online: true }));
vi.mock('@oat/workspace-ui', async (original) => ({
  ...(await original<typeof WorkspaceUi>()),
  loadShellData: model.load,
}));
vi.mock('../bridge', () => ({ call: model.call }));
vi.mock('../lib/api', () => ({ api: {} }));
vi.mock('./api-status', () => ({ useApiOnline: () => model.online }));
const user: DesktopUser = { id: 'u', name: 'Ada', email: 'ada@test.dev' };
const workspace = { id: 'w', name: 'Team', role: 'member' as const, members: 1 };
const snapshot = { activeId: 'w', targetId: 'w', workspaces: [{ ...workspace, canCreate: true }] };
const pending: MeetingNoteSummary = {
  documentId: 'pending',
  title: 'Pending',
  meetingId: 'm',
  workspaceId: 'w',
  ownerId: 'u',
  visibility: 'private',
  startedAt: null,
  endedAt: null,
  createdAt: '2026-11-21T10:00:00Z',
  pending: true,
};
const server = {
  user: { ...user, image: null },
  workspace,
  workspaces: [workspace],
  documents: [
    {
      id: 'page',
      title: 'Server page',
      kind: 'page',
      updatedAt: pending.createdAt,
      parentId: null,
      visibility: 'private',
      ownerId: 'u',
      access: { edit: true, delete: true },
    },
  ],
  trash: [],
  canJoin: false,
};
beforeEach(() => {
  model.load.mockReset();
  model.call.mockResolvedValue({ appOrigin: '' });
  model.online = true;
});
afterEach(cleanup);
it('uses the unmerged server list and pending rows for Home, retaining cached notes on failure', async () => {
  let resolve!: (value: unknown) => void;
  model.load.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const notes = [
    pending,
    { ...pending, documentId: 'cached', pending: false },
    { ...pending, documentId: 'foreign', workspaceId: 'other' },
  ];
  const { result } = renderHook(() => useDesktopShellData(user, notes, snapshot, null));
  expect(result.current.home.loading).toBe(true);
  expect(result.current.home.documents.map((doc) => doc.id)).toEqual(['pending']);
  await act(async () => {
    resolve(server);
  });
  expect(result.current.home.documents.map((doc) => doc.id).sort()).toEqual(['page', 'pending']);
  expect(result.current.data.documents.some((doc) => doc.id === 'cached')).toBe(true);
  model.load.mockRejectedValueOnce(new Error('Offline'));
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.home.error).toContain('Couldn’t load notes'));
  expect(result.current.home.documents.map((doc) => doc.id).sort()).toEqual([
    'cached',
    'page',
    'pending',
  ]);
});
it('scopes pending meetings to the server active workspace even before SQLite membership catches up', async () => {
  model.load.mockResolvedValue({
    ...server,
    workspace: { ...workspace, id: 'other' },
    workspaces: [{ ...workspace, id: 'other' }],
  });
  const notes = [pending, { ...pending, workspaceId: 'other', documentId: 'other-pending' }];
  const { result } = renderHook(() => useDesktopShellData(user, notes, snapshot, null));
  await waitFor(() => expect(result.current.home.loading).toBe(false));
  expect(result.current.home.documents.map((doc) => doc.id).sort()).toEqual([
    'other-pending',
    'page',
  ]);
});
