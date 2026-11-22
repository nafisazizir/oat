// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DocumentActions, DocumentRemoveAction, DocumentTrashBanner } from './document-actions';
import type { DocumentNode } from './tree';
const model = vi.hoisted(() => ({
  remove: vi.fn(),
  restore: vi.fn(),
  deleteForever: vi.fn(),
  online: true,
  error: vi.fn(),
}));
vi.mock('./tree-actions', () => ({ useTreeActions: () => model }));
vi.mock('./host', () => ({ useWorkspaceHost: () => ({ online: model.online }) }));
vi.mock('./share-dialog', () => ({ ShareDialog: () => <button>Share</button> }));
vi.mock('sonner', () => ({ toast: { error: model.error } }));
const node: DocumentNode = {
  id: 'd',
  title: 'Note',
  kind: 'meeting',
  updatedAt: '',
  ownerId: 'u',
  visibility: 'private',
  parentId: null,
  access: { edit: true, delete: true },
};
beforeEach(() => {
  vi.clearAllMocks();
  model.online = true;
});
afterEach(cleanup);
it('shares the same lifecycle menu slot with host-supplied Notion/history actions and saves first', async () => {
  let resolve!: (saved: boolean) => void;
  const before = vi.fn(
    () =>
      new Promise<boolean>((done) => {
        resolve = done;
      }),
  );
  render(
    <DocumentActions
      node={node}
      beforeRemove={before}
      renderSecondaryActions={(lifecycle) => (
        <>
          <button>History</button>
          {lifecycle}
        </>
      )}
    />,
  );
  expect(screen.getByRole('button', { name: 'Share' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Move to trash' }));
  expect(before).toHaveBeenCalledOnce();
  expect(model.remove).not.toHaveBeenCalled();
  resolve(true);
  await waitFor(() => expect(model.remove).toHaveBeenCalledWith(node));
});
it('keeps failed preflight edits and surfaces their error instead of trashing', async () => {
  render(<DocumentRemoveAction node={node} beforeRemove={async () => false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Move to trash' }));
  await waitFor(() =>
    expect(model.error).toHaveBeenCalledWith('Your latest edits aren’t saved yet.'),
  );
  expect(model.remove).not.toHaveBeenCalled();
});
it('hides unauthorized mutations and disables recording/offline mutations', () => {
  const { rerender } = render(
    <DocumentRemoveAction node={{ ...node, access: { edit: false, delete: false } }} />,
  );
  expect(screen.queryByRole('button')).toBeNull();
  rerender(<DocumentRemoveAction node={node} disabled />);
  fireEvent.click(screen.getByRole('button', { name: 'Move to trash' }));
  expect(model.remove).not.toHaveBeenCalled();
  model.online = false;
  rerender(<DocumentTrashBanner node={node} />);
  fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete forever' }));
  expect(model.restore).not.toHaveBeenCalled();
  expect(model.deleteForever).not.toHaveBeenCalled();
});
it('restores or deletes a trashed document through the existing lifecycle transport', () => {
  render(<DocumentTrashBanner node={node} />);
  fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete forever' }));
  expect(model.restore).toHaveBeenCalledWith(node);
  expect(model.deleteForever).toHaveBeenCalledWith(node);
});
