// @vitest-environment jsdom
import { OatApiError, type OatTransport } from '@oat/client';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { observeApi, useApiOnline } from './api-status';
import { localShellData, mergeLocalNotes } from './use-desktop-shell-data';

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

describe('desktop local shell data', () => {
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
  it('merges unsynced notes as private meetings only in the active workspace', () => {
    const merged = mergeLocalNotes(shell, [
      note,
      { ...note, documentId: 'other', workspaceId: 'other' },
    ]);
    expect(merged.documents).toEqual([
      expect.objectContaining({
        id: 'local',
        kind: 'meeting',
        visibility: 'private',
        parentId: null,
      }),
    ]);
    expect(mergeLocalNotes(shell, []).documents).toEqual([]);
  });
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
