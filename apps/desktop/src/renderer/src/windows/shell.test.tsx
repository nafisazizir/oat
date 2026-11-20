// @vitest-environment jsdom
import type { SearchHitSnapshot } from '@oat/core/bridge';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MainWindow from './main-window.tsx';

const model = vi.hoisted(() => {
  const user = { id: 'user', name: 'Alex', email: 'alex@example.test' };
  const sync = { state: 'idle', pending: 0, parked: 0, lastSyncedAt: null, error: null };
  return {
    invoke: vi.fn(),
    searchHits: [] as SearchHitSnapshot[],
    user,
    sync,
    recording: {
      seq: 1,
      status: 'idle',
      meetingId: null,
      input: null,
      fixture: null,
      startedAt: null,
      elapsedMs: 0,
      elapsedAt: 0,
      levels: { mic: null, system: null },
      stt: { mic: 'idle', system: 'idle' },
      issues: [],
    },
  };
});
vi.mock('../bridge.ts', () => ({
  call: model.invoke,
  bridge: () => ({ subscribe: () => () => {} }),
  BridgeCallError: class extends Error {},
}));
vi.mock('../main-state.ts', () => ({
  useMainState: () => ({
    auth: { status: 'signed-in', user: model.user },
    recording: { status: 'idle' },
    activeMeetingId: null,
    sync: model.sync,
  }),
}));
vi.mock('../recording-state.ts', () => ({ useRecording: () => model.recording }));
vi.mock('../meetings/meetings-state.ts', () => ({
  useMeetingNotes: () => [],
  bumpMeetingsVersion: vi.fn(),
}));
vi.mock('../meetings/meeting-view.tsx', () => ({
  MeetingView: ({ documentId }: { documentId: string | null }) => (
    <section data-testid="meeting-content" data-document-id={documentId}>
      Meeting content
    </section>
  ),
}));
vi.mock('../settings/settings-view.tsx', () => ({
  SettingsView: () => <section data-testid="settings">Settings content</section>,
}));
vi.mock('../calendar/calendar-state.ts', () => ({
  useCalendar: () => null,
  useMeetingPrompt: () => null,
}));
vi.mock('../auto-stop/auto-stop-state.ts', () => ({ useAutoStopNotice: () => null }));
vi.mock('../onboarding/onboarding-state.ts', () => ({
  useOnboarding: () => ({ state: { needed: false, guide: false } }),
}));
vi.mock('../workspaces/workspaces-state.ts', () => ({
  useWorkspaces: () => ({
    active: { id: 'workspace', name: 'Personal', kind: 'personal', role: 'owner' },
    snapshot: { workspaces: [] },
    fallback: null,
  }),
  roleLabel: () => 'Owner',
}));

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = () => {};
  model.searchHits = [];
  model.invoke.mockReset().mockImplementation(async (channel: string) => {
    if (channel === 'recording:options')
      return { defaultInput: 'sidecar', defaultFixture: null, fixtures: [] };
    if (channel === 'conflicts:list') return { conflicts: [] };
    if (channel === 'search:query') return { hits: model.searchHits };
    if (channel === 'api:me') return { user: model.user };
    return undefined;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('desktop shell', () => {
  it('keeps new meeting recording behavior for click and shortcut', async () => {
    render(<MainWindow />);
    const button = screen.getByTestId('new-meeting');
    expect(button.className).toContain('text-brand-900 hover:text-brand-1000');
    expect(
      button.parentElement?.querySelector('[data-sidebar="menu-badge"] kbd')?.textContent,
    ).toBe('⌘N');
    await userEvent.click(screen.getByRole('button', { name: 'New meeting note' }));
    expect(model.invoke).toHaveBeenCalledWith('recording:start', { input: 'sidecar' });
    await waitFor(() =>
      expect(screen.getByTestId('new-meeting').hasAttribute('disabled')).toBe(false),
    );
    fireEvent.keyDown(window, { key: 'n', metaKey: true });
    expect(
      model.invoke.mock.calls.filter(([channel]) => channel === 'recording:start'),
    ).toHaveLength(2);
  });

  it('opens local search with Command-K and handles an empty result', async () => {
    render(<MainWindow />);
    const button = screen.getByRole('button', { name: 'Search' });
    expect(
      button.parentElement?.querySelector('[data-sidebar="menu-badge"] kbd')?.textContent,
    ).toBe('⌘K');
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(await screen.findByRole('dialog')).toBeTruthy();
    await userEvent.type(
      screen.getByLabelText('Search notes and transcripts on this Mac'),
      'absent',
    );
    expect(await screen.findByText('Nothing on this Mac matches.')).toBeTruthy();
    expect(model.invoke).toHaveBeenCalledWith('search:query', { query: 'absent' });
  });

  it('keeps page search hits read-only and opens meeting hits', async () => {
    model.searchHits = [
      {
        documentId: 'page-id',
        updatedAt: '2026-11-20T00:00:00.000Z',
        kind: 'page',
        title: 'Project page',
        snippet: 'Read only',
        in: 'note',
        segmentId: null,
        startMs: null,
      },
      {
        documentId: 'meeting-id',
        updatedAt: '2026-11-20T00:00:00.000Z',
        kind: 'meeting',
        title: 'Project meeting',
        snippet: 'Open meeting',
        in: 'note',
        segmentId: null,
        startMs: null,
      },
    ];
    render(<MainWindow />);
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await userEvent.type(
      screen.getByLabelText('Search notes and transcripts on this Mac'),
      'project',
    );
    const pageHit = await screen.findByText('Project page');
    expect(pageHit.closest('button')).toBeNull();
    expect(pageHit.closest('[data-selectable]')).not.toBeNull();
    await userEvent.click(pageHit);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByTestId('meeting-content').getAttribute('data-document-id')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Project meeting/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('meeting-content').getAttribute('data-document-id')).toBe(
      'meeting-id',
    );
  });

  it('exposes desktop actions through the account menu', async () => {
    render(<MainWindow />);
    for (const [name, channel] of [
      ['Show meeting widget', 'window:open-widget'],
      ['Check connection', 'api:me'],
      ['Sign out', 'auth:sign-out'],
    ]) {
      await userEvent.click(screen.getByTestId('user-menu'));
      await userEvent.click(await screen.findByRole('menuitem', { name }));
      await waitFor(() => expect(model.invoke).toHaveBeenCalledWith(channel));
    }
    expect(screen.getByTestId('api-me').textContent).toBe('Connected as alex@example.test');
    await userEvent.click(screen.getByTestId('user-menu'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Settings' }));
    expect(screen.getByTestId('settings')).toBeTruthy();
  });

  it('surfaces a failed account action', async () => {
    render(<MainWindow />);
    model.invoke.mockRejectedValueOnce(new Error('offline'));
    await userEvent.click(screen.getByTestId('user-menu'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Check connection' }));
    expect(await screen.findByText('Something went wrong.')).toBeTruthy();
  });
});
