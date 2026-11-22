// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { HomeView } from './home-view';
import { DesktopHomeData } from '../workspace/home-data';
import type { HomeDocument } from '@oat/workspace-ui/home-model';
const model = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('@oat/workspace-ui', () => ({ useWorkspaceHost: () => ({ navigate: model.navigate }) }));
vi.mock('../calendar/upcoming-list.tsx', () => ({ UpcomingList: () => null }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const documents: HomeDocument[] = [
  { id: 'p', title: 'Server page', kind: 'page', updatedAt: '2026-11-21T10:00:00Z' },
  {
    id: 'm',
    title: 'Pending meeting',
    kind: 'meeting',
    updatedAt: '2026-11-21T11:00:00Z',
    pending: true,
  },
];
it('opens pages without forcing the meeting route and keeps pending meetings through load errors', () => {
  const retry = vi.fn();
  render(
    <DesktopHomeData.Provider
      value={{ documents, loading: false, error: 'Couldn’t load notes.', retry }}
    >
      <HomeView
        calendar={null}
        onOpen={vi.fn()}
        recordingMeetingId={null}
        otherWorkspace={() => null}
      />
    </DesktopHomeData.Provider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /Server page/ }));
  expect(model.navigate).toHaveBeenLastCalledWith({ view: 'document', id: 'p' });
  fireEvent.click(screen.getByRole('button', { name: /Pending meeting/ }));
  expect(model.navigate).toHaveBeenLastCalledWith({
    view: 'document',
    id: 'm',
    query: { kind: 'meeting' },
  });
  expect(screen.getByText('Pending sync')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(retry).toHaveBeenCalledOnce();
});
it('shows loading rather than a false empty state before server documents arrive', () => {
  render(
    <DesktopHomeData.Provider value={{ documents: [], loading: true, error: null, retry: vi.fn() }}>
      <HomeView
        calendar={null}
        onOpen={vi.fn()}
        recordingMeetingId={null}
        otherWorkspace={() => null}
      />
    </DesktopHomeData.Provider>,
  );
  expect(screen.getByText('Loading notes…')).toBeTruthy();
  expect(screen.queryByTestId('home-empty')).toBeNull();
});
it('distinguishes failed empty cache from a genuinely empty server workspace', () => {
  render(
    <DesktopHomeData.Provider
      value={{ documents: [], loading: false, error: 'Couldn’t load notes.', retry: vi.fn() }}
    >
      <HomeView
        calendar={null}
        onOpen={vi.fn()}
        recordingMeetingId={null}
        otherWorkspace={() => null}
      />
    </DesktopHomeData.Provider>,
  );
  expect(screen.getByText('No saved or pending notes on this device.')).toBeTruthy();
  expect(screen.queryByText('No notes yet')).toBeNull();
});
