// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SearchCommandGroup } from '@oat/feature-ui/search';
import { afterEach, expect, it, vi } from 'vitest';
import { FeatureSearch } from './feature-search';

const model = vi.hoisted(() => ({
  switchActive: vi.fn(),
  navigate: vi.fn(),
  refresh: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@oat/workspace-ui', () => ({
  useWorkspaceHost: () => ({
    client: { workspaces: { switchActive: model.switchActive } },
    navigate: model.navigate,
    refresh: model.refresh,
  }),
  useShellData: () => ({
    documents: [],
    workspace: { id: 'w' },
    workspaces: [
      { id: 'w', name: 'Current' },
      { id: 'other', name: 'Other' },
    ],
  }),
  useTreeActions: () => ({ canCreate: false }),
}));
vi.mock('@oat/ui/components/sidebar', () => ({ useSidebar: () => ({ toggleSidebar: vi.fn() }) }));
vi.mock('@oat/settings-ui', () => ({ useTheme: () => ({ theme: 'system', setTheme: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { error: model.error } }));
vi.mock('@oat/feature-ui/search', () => ({
  SearchDialog: ({ commandGroups }: { commandGroups: SearchCommandGroup[] }) =>
    commandGroups
      .flatMap((g) => g.items)
      .map((item) => (
        <button key={item.value} onClick={item.onSelect}>
          {item.text}
        </button>
      )),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('switches through the typed API so server and local workspace observers stay aligned', async () => {
  model.switchActive.mockResolvedValue({ ok: true });
  render(<FeatureSearch open onOpenChange={vi.fn()} onNewMeeting={vi.fn()} canStart={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Switch to Other' }));
  await waitFor(() => expect(model.refresh).toHaveBeenCalledOnce());
  expect(model.switchActive).toHaveBeenCalledExactlyOnceWith('other');
  expect(model.navigate).toHaveBeenCalledExactlyOnceWith({ view: 'home' });
});
it('reports workspace switch failures without navigating', async () => {
  model.switchActive.mockRejectedValue(new Error('offline'));
  render(<FeatureSearch open onOpenChange={vi.fn()} onNewMeeting={vi.fn()} canStart={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Switch to Other' }));
  await waitFor(() =>
    expect(model.error).toHaveBeenCalledWith('Couldn’t switch workspace. Try again.'),
  );
  expect(model.navigate).not.toHaveBeenCalled();
  expect(model.refresh).not.toHaveBeenCalled();
});
