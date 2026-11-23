// @vitest-environment jsdom
import { OatApiError, type OatTransport } from '@oat/client';
import { areaOf } from '@oat/workspace-ui';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { observeApi, useApiOnline } from './api-status';
import { localShellData, mergeLocalNotes, useDesktopShellData } from './use-desktop-shell-data';
import { api } from '../lib/api';

const { call } = vi.hoisted(() => ({ call: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock('../bridge', () => ({ call, bridge: () => ({}) }));

const user = { id: 'u', name: null, email: 'u@example.test' };
const workspace = { id: 'w', name: 'Work', role: 'owner' as const, canCreate: true };
const shell = localShellData(user, { workspaces: [workspace], activeId: 'w', targetId: 'w' });
const note = {
  documentId: 'local',
  workspaceId: 'w',
  ownerId: 'u',
  title: 'Local note',
  visibility: 'workspace' as const,
  meetingId: null,
  startedAt: null,
  endedAt: null,
  createdAt: '2026-11-20',
};

afterEach(() => {
  vi.restoreAllMocks();
  call.mockReset().mockResolvedValue(undefined);
});

describe('cached desktop workspace selection', () => {
  it.each([false, true])(
    'does not reconcile the previous online workspace while the selected one is loading (failure: %s)',
    async (fail) => {
      const next = { ...workspace, id: 'next', name: 'Next' };
      vi.spyOn(api.workspaces, 'list').mockResolvedValue({
        activeWorkspaceId: 'w',
        workspaces: [workspace, next].map((w) => ({
          ...w,
          slug: w.id,
          icon: null,
          memberCount: 2,
          joinedAt: '2026-11-20',
        })),
      });
      vi.spyOn(api.workspaces, 'joinable').mockResolvedValue({ invites: [], workspaces: [] });
      vi.spyOn(api.documents, 'list').mockResolvedValue([]);
      let release!: () => void;
      const pending = new Promise<void>((resolve, reject) => {
        release = fail ? () => reject(new OatApiError(503, 'unavailable', 'Unavailable')) : resolve;
      });
      vi.spyOn(api.folders, 'tree').mockImplementation(async (workspaceId) => {
        if (workspaceId === 'next') await pending;
        return [];
      });
      await observeApi(async () => ({ status: 200, json: async () => [] }))({
        method: 'GET',
        path: '/api/workspaces',
      });
      const { result, unmount } = renderHook(() => {
        const [snapshot, setSnapshot] = useState({
          workspaces: [workspace, next],
          activeId: 'w',
          targetId: 'w',
        });
        const state = useDesktopShellData(user, [], snapshot, null);
        return {
          state,
          snapshot,
          select: (activeId: string) =>
            setSnapshot((s) => ({ ...s, activeId, targetId: activeId })),
        };
      });
      try {
        await waitFor(() => expect(result.current.state.data.workspace.members).toBe(2));
        call.mockClear();
        call.mockImplementation(async (channel, payload) => {
          if (channel === 'workspaces:set-active')
            result.current.select((payload as { workspaceId: string }).workspaceId);
          return undefined;
        });
        await act(async () => result.current.select('next'));
        expect(result.current.snapshot.targetId).toBe('next');
        expect(call).not.toHaveBeenCalledWith('workspaces:set-active', { workspaceId: 'w' });
        await act(async () => release());
        await waitFor(() => expect(result.current.state.data.workspace.id).toBe('next'));
        if (fail) expect(result.current.state.online).toBe(false);
        expect(result.current.snapshot).toMatchObject({ activeId: 'next', targetId: 'next' });
      } finally {
        unmount();
        release();
      }
    },
  );

  it('still reconciles a removed cached membership after its own fallback load completes', async () => {
    vi.spyOn(api.workspaces, 'list').mockResolvedValue({
      activeWorkspaceId: 'w',
      workspaces: [
        { ...workspace, slug: 'work', icon: null, memberCount: 2, joinedAt: '2026-11-20' },
      ],
    });
    vi.spyOn(api.workspaces, 'joinable').mockResolvedValue({ invites: [], workspaces: [] });
    vi.spyOn(api.documents, 'list').mockResolvedValue([]);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(api.folders, 'tree').mockImplementation(async () => {
      await pending;
      return [];
    });
    await observeApi(async () => ({ status: 200, json: async () => [] }))({
      method: 'GET',
      path: '/api/workspaces',
    });
    call.mockClear();
    const { result, unmount } = renderHook(() =>
      useDesktopShellData(
        user,
        [],
        {
          workspaces: [workspace, { ...workspace, id: 'removed' }],
          activeId: 'removed',
          targetId: 'removed',
        },
        null,
      ),
    );
    try {
      expect(call).not.toHaveBeenCalledWith('workspaces:set-active', { workspaceId: 'w' });
      await act(async () => release());
      await waitFor(() =>
        expect(call).toHaveBeenCalledWith('workspaces:set-active', { workspaceId: 'w' }),
      );
      expect(result.current.data.workspace.id).toBe('w');
    } finally {
      unmount();
      release();
    }
  });
  it('does not roll back an offline switch or replace it with the server default on reconnect', async () => {
    const next = { ...workspace, id: 'next', name: 'Next' };
    vi.spyOn(api.workspaces, 'list').mockResolvedValue({
      activeWorkspaceId: 'w',
      workspaces: [workspace, next].map((w) => ({
        ...w,
        slug: w.id,
        icon: null,
        memberCount: 1,
        joinedAt: '2026-11-20',
      })),
    });
    vi.spyOn(api.workspaces, 'joinable').mockResolvedValue({ invites: [], workspaces: [] });
    vi.spyOn(api.folders, 'tree').mockResolvedValue([]);
    vi.spyOn(api.documents, 'list').mockResolvedValue([]);
    const snapshot = { workspaces: [workspace, next], activeId: 'w', targetId: 'w' };
    const { result, rerender, unmount } = renderHook(
      ({ activeId }) => useDesktopShellData(user, [], { ...snapshot, activeId }, null),
      { initialProps: { activeId: 'w' } },
    );
    await waitFor(() => expect(api.documents.list).toHaveBeenCalled());
    call.mockClear();
    await act(async () => {
      await observeApi(async () => {
        throw new OatApiError(0, 'network', 'Offline');
      })({ method: 'GET', path: '/api/workspaces' }).catch(() => {});
    });
    rerender({ activeId: 'next' });
    await waitFor(() => expect(result.current.data.workspace.id).toBe('next'));
    expect(call).not.toHaveBeenCalledWith('workspaces:set-active', { workspaceId: 'w' });
    await act(async () => {
      await observeApi(async () => ({ status: 200, json: async () => [] }))({
        method: 'GET',
        path: '/api/workspaces',
      });
    });
    await waitFor(() => expect(result.current.online).toBe(true));
    expect(result.current.data.workspace.id).toBe('next');
    expect(api.documents.list).toHaveBeenCalledWith({ workspaceId: 'next' });
    unmount();
  });
});

describe('desktop local shell data', () => {
  it('keeps cached member counts offline without overriding the local role', () => {
    const cached = { ...shell, workspaces: [{ ...shell.workspace, members: 4, icon: '🌱' }] };
    const local = localShellData(
      user,
      {
        workspaces: [{ ...workspace, role: 'viewer', canCreate: false }],
        activeId: 'w',
        targetId: null,
      },
      cached,
    );
    expect(local.workspace).toMatchObject({ members: 4, icon: '🌱', role: 'viewer' });
    expect(
      localShellData(
        user,
        { workspaces: [{ ...workspace, id: 'new' }], activeId: 'new', targetId: 'new' },
        cached,
      ).workspace.members,
    ).toBe(1);
  });
  it('keeps unknown workspace roles view-only and permits an empty local snapshot', () => {
    expect(localShellData(user, null).documents).toEqual([]);
    expect(localShellData(user, null).workspace.name).toBe(user.email);
    expect(
      localShellData(user, {
        workspaces: [{ ...workspace, role: null }],
        activeId: 'w',
        targetId: null,
      }).workspace.role,
    ).toBe('viewer');
  });
  it.each(['private', 'workspace', 'link'] as const)(
    'preserves cached %s visibility on cold offline launch',
    (visibility) => {
      const merged = mergeLocalNotes(shell, [
        { ...note, visibility },
        { ...note, documentId: 'other', workspaceId: 'other' },
      ]);
      expect(merged.documents).toEqual([
        expect.objectContaining({
          id: 'local',
          kind: 'meeting',
          visibility,
          parentId: null,
        }),
      ]);
      expect(areaOf(merged.documents[0]!, user.id)).toBe(
        visibility === 'private' ? 'private' : 'shared',
      );
      expect(mergeLocalNotes(shell, []).documents).toEqual([]);
    },
  );
  it('does not duplicate server notes or resurrect a trashed note', () => {
    const node = mergeLocalNotes(shell, [note]).documents[0]!;
    expect(mergeLocalNotes({ ...shell, documents: [node] }, [note]).documents).toEqual([node]);
    expect(mergeLocalNotes({ ...shell, trash: [node] }, [note]).documents).toEqual([]);
    expect(
      mergeLocalNotes(
        { ...shell, documents: [{ ...node, visibility: 'workspace', title: 'Server title' }] },
        [note],
      ).documents,
    ).toEqual([{ ...node, visibility: 'workspace' }]);
  });
});

describe('desktop API observation', () => {
  it('tracks network errors, not authorization refusals, and recovers on a response', async () => {
    const { result } = renderHook(useApiOnline);
    const request = { method: 'GET' as const, path: '/api/documents' };
    await act(async () => {
      await expect(
        observeApi(async () => {
          throw new OatApiError(0, 'network', 'Offline');
        })(request),
      ).rejects.toThrow('Offline');
    });
    expect(result.current).toBe(false);
    await act(async () => {
      await expect(
        observeApi(async () => {
          throw new OatApiError(403, 'forbidden', 'Denied');
        })(request),
      ).rejects.toThrow('Denied');
    });
    expect(result.current).toBe(true);
    await act(async () => {
      await observeApi(async () => ({ status: 200, json: async () => [] }))(request);
    });
    expect(result.current).toBe(true);
  });
  it('syncs membership and updates the local recording target after a REST workspace switch', async () => {
    call.mockClear();
    const transport = vi.fn<OatTransport>(async () => ({
      status: 200,
      json: async () => ({ ok: true, workspaceId: 'next' }),
    }));
    const response = await observeApi(transport)({
      method: 'PUT',
      path: '/api/workspaces/active',
      body: { workspaceId: 'next' },
    });
    expect(call.mock.calls).toEqual([
      ['sync:now'],
      ['workspaces:set-active', { workspaceId: 'next' }],
    ]);
    expect(await response.json()).toEqual({ ok: true, workspaceId: 'next' });
  });
});
