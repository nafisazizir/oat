// @vitest-environment jsdom
import { createOatClient } from '@oat/client';
import type { MeetingNoteSummary } from '@oat/core/bridge';
import { useFeatureUi } from '@oat/feature-ui';
import type * as WorkspaceUi from '@oat/workspace-ui';
import { hrefOf } from '@oat/workspace-ui/routes';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DesktopFeatureProvider, FeatureViews } from './feature-views';

const model = vi.hoisted(() => ({ host: null as WorkspaceUi.WorkspaceHost | null }));
vi.mock('@oat/feature-ui/tasks', () => ({
  TasksView: ({ value, onChange }: { value: unknown; onChange(value: unknown): void }) => (
    <button onClick={() => onChange({ view: 'created', status: 'done', due: 'soon' })}>
      Filters {JSON.stringify(value)}
    </button>
  ),
}));
vi.mock('@oat/feature-ui/search', async (original) => ({
  ...(await original<object>()),
  SearchView: ({
    query,
    type,
    onQueryChange,
    onTypeChange,
  }: {
    query: string;
    type: string;
    onQueryChange(q: string): void;
    onTypeChange(type: string): void;
  }) => (
    <>
      <button onClick={() => onTypeChange('transcripts')}>Tab {type}</button>
      <button onClick={() => onQueryChange('next')}>Query {query}</button>
    </>
  ),
}));
vi.mock('@oat/workspace-ui', async (original) => ({
  ...(await original<typeof WorkspaceUi>()),
  useWorkspaceHost: () => model.host!,
  useShellData: () => ({
    workspace: { id: 'w', name: 'Workspace' },
    user: { id: 'u', name: 'Alex', email: 'alex@example.test' },
  }),
}));

afterEach(cleanup);

function OpenDocument() {
  const { navigate } = useFeatureUi();
  return (
    <button
      onClick={() =>
        navigate({
          kind: 'document',
          id: 'doc',
          blockId: 'block',
          segmentId: 'segment',
          timeMs: 65000,
        })
      }
    >
      Open document
    </button>
  );
}

it.each([false, true])('navigates in-app with deep links (cached meeting: %s)', (cached) => {
  const navigate = vi.fn();
  model.host = {
    platform: 'desktop',
    appOrigin: 'https://oat.example',
    client: createOatClient(async () => ({ status: 200, json: async () => ({}) })),
    route: { view: 'tasks' },
    navigate,
    hrefOf,
    refresh: vi.fn(),
    online: true,
    Link: () => null,
  };
  const note: MeetingNoteSummary = {
    documentId: 'doc',
    meetingId: 'm',
    workspaceId: 'w',
    ownerId: 'u',
    title: 'Meeting',
    visibility: 'private',
    startedAt: null,
    endedAt: null,
    createdAt: '2026-11-20T00:00:00Z',
  };
  render(
    <DesktopFeatureProvider notes={cached ? [note] : null} refreshKey={null}>
      <OpenDocument />
    </DesktopFeatureProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open document' }));
  expect(navigate).toHaveBeenCalledExactlyOnceWith({
    view: 'document',
    id: 'doc',
    query: { t: '65', block: 'block', seg: 'segment', ...(cached ? { kind: 'meeting' } : {}) },
  });
});

it('keeps task filters and search tab/query in host routes instead of component state', () => {
  const navigate = vi.fn();
  model.host = {
    platform: 'desktop',
    appOrigin: '',
    client: createOatClient(async () => ({ status: 200, json: async () => ({}) })),
    route: { view: 'tasks' },
    navigate,
    hrefOf,
    refresh: vi.fn(),
    online: true,
    Link: () => null,
  };
  const renderRoute = (route: Extract<WorkspaceUi.AppRoute, { view: 'search' | 'tasks' }>) => (
    <DesktopFeatureProvider notes={[]} refreshKey={null}>
      <FeatureViews route={route} />
    </DesktopFeatureProvider>
  );
  const { rerender } = render(
    renderRoute({ view: 'tasks', filters: { view: 'all', status: 'done', due: 'overdue' } }),
  );
  fireEvent.click(screen.getByRole('button', { name: /Filters/ }));
  expect(navigate).toHaveBeenLastCalledWith({
    view: 'tasks',
    filters: { view: 'created', status: 'done', due: 'soon' },
  });
  rerender(renderRoute({ view: 'search', q: 'budget', type: 'transcripts' }));
  expect(screen.getByRole('button', { name: 'Tab transcripts' })).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Query budget' }));
  expect(navigate).toHaveBeenLastCalledWith({ view: 'search', q: 'next', type: 'transcripts' });
  fireEvent.click(screen.getByRole('button', { name: 'Tab transcripts' }));
  expect(navigate).toHaveBeenLastCalledWith({ view: 'search', q: 'budget', type: 'transcripts' });
});
