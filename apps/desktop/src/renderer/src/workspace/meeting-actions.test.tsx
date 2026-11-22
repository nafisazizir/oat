// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type * as WorkspaceUi from '@oat/workspace-ui';
import { MeetingActions } from './meeting-actions';
const model = vi.hoisted(() => {
  const get = vi.fn();
  return {
    documents: [] as { id: string; version?: number; deletedAt?: string }[],
    trash: [] as { id: string; version?: number; deletedAt?: string }[],
    get,
    client: { documents: { get } },
    call: vi.fn(),
    online: true,
    actions: vi.fn(),
  };
});
vi.mock('../bridge', () => ({ call: model.call }));
vi.mock('@oat/workspace-ui', async (original) => ({
  ...(await original<typeof WorkspaceUi>()),
  useShellData: () => ({ documents: model.documents, trash: model.trash }),
  useWorkspaceHost: () => ({ online: model.online, client: model.client }),
  DocumentTrashBanner: () => <p>Restore / Delete forever</p>,
  DocumentActions: (props: unknown) => {
    model.actions(props);
    return <p>Share / Move to trash</p>;
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  model.documents = [];
  model.trash = [];
  model.online = true;
  model.call.mockResolvedValue(undefined);
});
afterEach(cleanup);
it('uses shared trashed actions for locally cached meetings and forwards guarded active actions', () => {
  model.trash = [{ id: 'd', version: 1, deletedAt: 'now' }];
  const { rerender } = render(<MeetingActions id="d" />);
  expect(screen.getByText('Restore / Delete forever')).toBeTruthy();
  model.trash = [];
  model.documents = [{ id: 'd', version: 2 }];
  const beforeRemove = vi.fn();
  rerender(<MeetingActions id="d" beforeRemove={beforeRemove} removeDisabled />);
  expect(screen.getByText('Share / Move to trash')).toBeTruthy();
  expect(model.actions).toHaveBeenCalledWith(
    expect.objectContaining({ beforeRemove, removeDisabled: true }),
  );
  expect(model.get).not.toHaveBeenCalled();
});
it('loads authorized metadata for a meeting outside the active workspace or shell list', async () => {
  model.get.mockResolvedValue({
    id: 'd',
    kind: 'meeting',
    access: { delete: true },
    deletedAt: 'now',
  });
  render(<MeetingActions id="d" />);
  expect(await screen.findByText('Restore / Delete forever')).toBeTruthy();
  expect(model.get).toHaveBeenCalledWith('d');
});
it('does not offer broken server actions for an unsynced local note; sync/retry recovers', async () => {
  model.documents = [{ id: 'd' }];
  model.get
    .mockRejectedValueOnce(new Error('Not found'))
    .mockResolvedValue({ id: 'd', kind: 'meeting', access: { delete: true } });
  render(<MeetingActions id="d" />);
  expect(await screen.findByText(/Actions are unavailable/)).toBeTruthy();
  expect(screen.queryByText('Share / Move to trash')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Share / Move to trash')).toBeTruthy();
  expect(model.call).toHaveBeenCalledWith('sync:now');
});
it('does not fetch when offline and reports sync failure without dropping a pending note', async () => {
  model.online = false;
  const { rerender } = render(<MeetingActions id="d" />);
  expect(screen.getByText('Reconnect to share or manage this note.')).toBeTruthy();
  expect(model.get).not.toHaveBeenCalled();
  model.online = true;
  model.get.mockRejectedValue(new Error('Offline'));
  rerender(<MeetingActions id="d" />);
  await screen.findByText(/Actions are unavailable/);
  model.call.mockRejectedValueOnce(new Error('Offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() =>
    expect(screen.getByText('Couldn’t sync this note. Please try again.')).toBeTruthy(),
  );
});
