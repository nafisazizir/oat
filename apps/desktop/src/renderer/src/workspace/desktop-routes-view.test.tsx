// @vitest-environment jsdom
import type * as WorkspaceUi from '@oat/workspace-ui';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DesktopRoutesView } from './desktop-routes-view';

const model = vi.hoisted(() => ({
  get: vi.fn(),
  online: true,
  shell: { documents: [], trash: [], workspace: { id: 'w' }, workspaces: [] },
}));
vi.mock('../lib/api', () => ({ api: { documents: { get: model.get } }, apiTransport: vi.fn() }));
vi.mock('@oat/workspace-ui', async (original) => ({
  ...(await original<typeof WorkspaceUi>()),
  useWorkspaceHost: () => ({ online: model.online }),
  useShellData: () => model.shell,
  PageEditor: () => (
    <div className="oat-editor">
      <p data-id="first">First block</p>
      <p data-id="second">Second block</p>
    </div>
  ),
}));
afterEach(() => {
  model.online = true;
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('retains the editor offline and refocuses same-page citations after loading query.block', async () => {
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  const scroll = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = scroll;
  model.get.mockResolvedValue({ id: 'page', kind: 'page', workspaceId: 'w' });
  const { rerender } = render(
    <DesktopRoutesView
      route={{ view: 'document', id: 'page', query: { block: 'first' } }}
      notes={[]}
      meeting={null}
    />,
  );
  const first = await screen.findByText('First block');
  await waitFor(() => expect(first.hasAttribute('data-block-highlight')).toBe(true));
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: 'center', behavior: 'smooth' });
  model.online = false;
  rerender(
    <DesktopRoutesView
      route={{ view: 'document', id: 'page', query: { block: 'second' } }}
      notes={[]}
      meeting={null}
    />,
  );
  expect(first.hasAttribute('data-block-highlight')).toBe(false);
  expect(screen.getByText('First block')).toBe(first);
  expect(screen.getByText(/Keep this page open/)).toBeTruthy();
  expect(screen.getByText('Second block').hasAttribute('data-block-highlight')).toBe(true);
  expect(scroll).toHaveBeenCalledTimes(2);
  expect(model.get).toHaveBeenCalledExactlyOnceWith('page');
});
