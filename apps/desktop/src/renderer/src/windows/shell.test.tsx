// @vitest-environment jsdom
import type { SearchHitSnapshot, MeetingNoteSummary } from '@oat/core/bridge';
import { OatApiError, type OatTransport } from '@oat/client';
import { ThemeProvider } from '@oat/settings-ui';
import { THEME_STORAGE_KEY } from '@oat/settings-ui/theme';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MainWindow from './main-window.tsx';

const model = vi.hoisted(() => {
  const user = { id: 'user', name: 'Alex' as string | null, email: 'alex@example.test' };
  const sync = { state: 'idle', pending: 0, parked: 0, lastSyncedAt: null, error: null };
  return {
    invoke: vi.fn(),
    send: vi.fn(),
    apiTransport: vi.fn<OatTransport>(),
    notes: [] as MeetingNoteSummary[],
    searchHits: [] as SearchHitSnapshot[],
    workspacesReady: true,
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
  bridge: () => ({ subscribe: () => () => {}, send: model.send }),
  BridgeCallError: class extends Error {},
}));
vi.mock('../lib/api.ts', async () => {
  const { createOatClient } = await import('@oat/client');
  return { api: createOatClient(model.apiTransport), apiTransport: model.apiTransport };
});
vi.mock('../main-state.ts', () => ({
  useMainState: () => ({
    auth: { status: 'signed-in', user: model.user },
    recording: { status: model.recording.status },
    activeMeetingId: null,
    sync: model.sync,
  }),
}));
vi.mock('../recording-state.ts', () => ({ useRecording: () => model.recording }));
vi.mock('../meetings/meetings-state.ts', () => ({
  useMeetingNotes: () => model.notes,
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
  SettingsView: ({ initialSection, onClose }: { initialSection: string; onClose(): void }) => (
    <section data-testid="settings" data-section={initialSection}>
      Settings content<button onClick={onClose}>Back to notes</button>
    </section>
  ),
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
    active: model.workspacesReady
      ? { id: 'workspace', name: 'Ada’s workspace', role: 'owner' }
      : null,
    snapshot: model.workspacesReady ? { workspaces: [] } : null,
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
  Element.prototype.scrollTo = () => {};
  model.searchHits = [];
  model.recording.status = 'idle';
  model.user.name = 'Alex';
  model.notes = [];
  model.send.mockReset();
  model.apiTransport.mockReset().mockImplementation(async (request) => {
    if (request.path === '/api/search') throw new OatApiError(0, 'unavailable', 'Offline');
    return {
      status: 200,
      json: async () =>
        request.path === '/api/chat/threads' ? { threads: [] } : { items: [], truncated: false },
    };
  });
  model.workspacesReady = true;
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
  localStorage.clear();
  document.documentElement.classList.remove('dark');
  vi.unstubAllGlobals();
});

describe('desktop shell', () => {
  it('uses the shared settings theme store from palette commands', async () => {
    render(<MainWindow />, { wrapper: ThemeProvider });
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await userEvent.type(screen.getByRole('combobox'), 'dark theme');
    await userEvent.click(screen.getByRole('option', { name: 'Dark theme' }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(true));
  });

  it('keeps in-app settings and feature navigation reachable together', async () => {
    render(<MainWindow />, { wrapper: ThemeProvider });
    await userEvent.click(screen.getByRole('button', { name: 'Assistant' }));
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await userEvent.type(screen.getByRole('combobox'), 'settings');
    await userEvent.click(screen.getByRole('option', { name: 'Settings' }));
    expect(screen.getByTestId('settings').getAttribute('data-section')).toBe('preferences');
    expect(screen.queryByTestId('chat-empty')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Back to notes' }));
    expect(await screen.findByTestId('chat-empty')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'My tasks' }));
    expect(await screen.findByRole('heading', { name: 'My tasks' })).toBeTruthy();
  });

  it('keeps recording controls available while browsing shared feature views', async () => {
    model.recording.status = 'recording';
    render(<MainWindow />, { wrapper: ThemeProvider });
    await userEvent.click(screen.getByRole('button', { name: 'Assistant' }));
    expect(await screen.findByRole('button', { name: 'Stop recording' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'My tasks' }));
    expect(screen.getByRole('button', { name: 'Stop recording' })).toBeTruthy();
  });

  it('uses the account email when the desktop display name is absent', async () => {
    model.user.name = null;
    render(<MainWindow />, { wrapper: ThemeProvider });
    await userEvent.click(screen.getByRole('button', { name: 'Assistant' }));
    expect(await screen.findByText('Ask across your meetings')).toBeTruthy();
    expect(screen.getByTestId('workspace-switcher').textContent).toContain('alex@example.test');
  });

  it('asks for a workspace before loading feature data while workspaces are unavailable', async () => {
    model.workspacesReady = false;
    render(<MainWindow />, { wrapper: ThemeProvider });
    await userEvent.click(screen.getByRole('button', { name: 'My tasks' }));
    expect(await screen.findByText('Choose a workspace to continue.')).toBeTruthy();
    expect(model.apiTransport).not.toHaveBeenCalled();
  });

  it('switches sidebar items to the shared Assistant and My tasks views', async () => {
    render(<MainWindow />, { wrapper: ThemeProvider });
    await userEvent.click(screen.getByRole('button', { name: 'Assistant' }));
    expect(await screen.findByText('Ask across your meetings')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'My tasks' }));
    expect(await screen.findByRole('heading', { name: 'My tasks' })).toBeTruthy();
    expect(await screen.findByText('Nothing assigned to you')).toBeTruthy();
    await userEvent.click(screen.getByTestId('home-nav'));
    expect(screen.getByTestId('meeting-content')).toBeTruthy();
  });

  it('opens full results from the shared palette with local query state', async () => {
    render(<MainWindow />, { wrapper: ThemeProvider });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    await userEvent.type(screen.getByRole('combobox'), 'project');
    await userEvent.click(await screen.findByText('Search all results for “project”'));
    expect(await screen.findByRole('heading', { name: 'Search' })).toBeTruthy();
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('project');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'new query' } });
    await waitFor(() =>
      expect(model.invoke).toHaveBeenCalledWith('search:query', { query: 'new query' }),
    );
  });

  it('cancels the assistant stream at the desktop transport when leaving the view', async () => {
    model.apiTransport.mockImplementation(async (request) => {
      if (request.path !== '/api/chat') return { status: 200, json: async () => ({ threads: [] }) };
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"start","messageId":"a1"}\n\ndata: {"type":"text-start","id":"text"}\n\ndata: {"type":"text-delta","id":"text","delta":"Streaming answer"}\n\n',
            ),
          );
          request.signal?.addEventListener(
            'abort',
            () => controller.error(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        },
      });
      return {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
        body,
        json: async () => null,
      };
    });
    render(<MainWindow />, { wrapper: ThemeProvider });
    await userEvent.click(screen.getByRole('button', { name: 'Assistant' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Ask the assistant' }), {
      target: { value: 'Hello' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Streaming answer')).toBeTruthy();
    const signal = model.apiTransport.mock.calls.find(
      ([request]) => request.path === '/api/chat',
    )?.[0].signal;
    expect(signal?.aborted).toBe(false);
    await userEvent.click(screen.getByTestId('home-nav'));
    expect(signal?.aborted).toBe(true);
  });

  it('keeps new meeting recording behavior for click and shortcut', async () => {
    render(<MainWindow />, { wrapper: ThemeProvider });
    const button = screen.getByTestId('new-meeting');
    expect(button.className).not.toContain('rounded-full');
    expect(button.closest('header')).not.toBeNull();
    expect(
      document.querySelector('[data-sidebar="header"] [data-testid="new-meeting"]'),
    ).toBeNull();
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

  it('opens the shared palette with Command-K and handles an offline empty result', async () => {
    render(<MainWindow />, { wrapper: ThemeProvider });
    const button = screen.getByRole('button', { name: 'Search' });
    expect(
      button.parentElement?.querySelector('[data-sidebar="menu-badge"] kbd')?.textContent,
    ).toBe('⌘K');
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(await screen.findByRole('dialog')).toBeTruthy();
    await userEvent.type(screen.getByRole('combobox'), 'absent');
    expect(await screen.findByText('No notes or transcripts match “absent”.')).toBeTruthy();
    expect(screen.getByText('Offline — showing notes on this device')).toBeTruthy();
    expect(model.invoke).toHaveBeenCalledWith('search:query', { query: 'absent' });
  });

  it.each(['metaKey', 'ctrlKey'] as const)(
    'lets editor link handling consume %s+K before global search',
    (modifier) => {
      render(<MainWindow />, { wrapper: ThemeProvider });
      const editor = document.createElement('div');
      editor.contentEditable = 'true';
      screen.getByTestId('meeting-content').append(editor);
      const editLink = vi.fn((event: KeyboardEvent) => {
        expect(event.defaultPrevented).toBe(false);
        event.preventDefault();
      });
      editor.addEventListener('keydown', editLink);
      const event = new KeyboardEvent('keydown', {
        key: 'k',
        [modifier]: true,
        bubbles: true,
        cancelable: true,
      });
      fireEvent(editor, event);
      expect(editLink).toHaveBeenCalledOnce();
      expect(event.defaultPrevented).toBe(true);
      expect(screen.queryByRole('dialog')).toBeNull();
      editor.removeEventListener('keydown', editLink);
      fireEvent.keyDown(editor, { key: 'k', [modifier]: true });
      expect(screen.getByRole('dialog')).toBeTruthy();
    },
  );

  it('opens uncached pages externally and cached meetings natively from shared search', async () => {
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
    model.notes = [
      {
        documentId: 'meeting-id',
        meetingId: 'm1',
        workspaceId: 'workspace',
        ownerId: 'user',
        title: 'Cached meeting',
        visibility: 'private',
        startedAt: null,
        endedAt: null,
        createdAt: '2026-11-20T00:00:00Z',
      },
    ];
    render(<MainWindow />, { wrapper: ThemeProvider });
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await userEvent.type(screen.getByRole('combobox'), 'project');
    const pageHit = await screen.findByText('Project page');
    await userEvent.click(pageHit);
    expect(model.send).toHaveBeenCalledWith('shell:open-external', { url: '/d/page-id' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('meeting-content').getAttribute('data-document-id')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await userEvent.type(screen.getByRole('combobox'), 'project');
    await userEvent.click(await screen.findByText('Project meeting'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('meeting-content').getAttribute('data-document-id')).toBe(
      'meeting-id',
    );
  });

  it('exposes workspace and account actions through one footer menu', async () => {
    render(<MainWindow />, { wrapper: ThemeProvider });
    for (const [name, channel] of [
      ['Show meeting widget', 'window:open-widget'],
      ['Check connection', 'api:me'],
      ['Sign out', 'auth:sign-out'],
    ]) {
      await userEvent.click(screen.getByTestId('workspace-switcher'));
      await userEvent.click(await screen.findByRole('menuitem', { name }));
      await waitFor(() => expect(model.invoke).toHaveBeenCalledWith(channel));
    }
    expect(screen.getByTestId('api-me').textContent).toBe('Connected as alex@example.test');
    await userEvent.click(screen.getByTestId('workspace-switcher'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Settings' }));
    expect(screen.getByTestId('settings')).toBeTruthy();
  });

  it('surfaces a failed account action', async () => {
    render(<MainWindow />, { wrapper: ThemeProvider });
    model.invoke.mockRejectedValueOnce(new Error('offline'));
    await userEvent.click(screen.getByTestId('workspace-switcher'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Check connection' }));
    expect(await screen.findByText('Something went wrong.')).toBeTruthy();
  });

  it('keeps the header borderless and the sync and settings controls in the footer', async () => {
    render(<MainWindow />, { wrapper: ThemeProvider });
    const header = screen.getByTestId('new-meeting').closest('header')!;
    expect(header.className).not.toContain('border-b');
    expect(document.querySelector('[data-slot="sidebar"] .app-drag')?.className).not.toContain(
      'border-b',
    );
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
    const footer = screen.getByTestId('signed-in');
    expect(footer.contains(screen.getByTestId('workspace-switcher'))).toBe(true);
    expect(footer.contains(screen.getByTestId('sync-status'))).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByTestId('settings')).toBeTruthy();
  });

  it('keeps new meeting pending and reports a failure from the header', async () => {
    render(<MainWindow />, { wrapper: ThemeProvider });
    let reject!: (error: Error) => void;
    model.invoke.mockImplementation((channel: string) =>
      channel === 'recording:start'
        ? new Promise((_, fail) => {
            reject = fail;
          })
        : Promise.resolve(),
    );
    await userEvent.click(screen.getByTestId('new-meeting'));
    expect(screen.getByTestId('new-meeting').hasAttribute('disabled')).toBe(true);
    fireEvent.keyDown(window, { key: 'n', metaKey: true });
    expect(
      model.invoke.mock.calls.filter(([channel]) => channel === 'recording:start'),
    ).toHaveLength(1);
    reject(new Error('offline'));
    expect(await screen.findByText('Something went wrong.')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('new-meeting').hasAttribute('disabled')).toBe(false),
    );
  });

  it('keeps account actions available before workspaces load', async () => {
    model.workspacesReady = false;
    render(<MainWindow />, { wrapper: ThemeProvider });
    expect(screen.getByTestId('workspace-switcher').textContent).toContain('Alex');
    await userEvent.click(screen.getByTestId('workspace-switcher'));
    expect(
      await screen.findByText('Account', { selector: '[data-slot="dropdown-menu-label"]' }),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(model.invoke).toHaveBeenCalledWith('auth:sign-out');
  });
});
