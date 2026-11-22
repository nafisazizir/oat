// @vitest-environment jsdom
import type { SearchHitSnapshot, MeetingNoteSummary } from '@oat/core/bridge';
import type { OatRequest } from '@oat/client';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MainWindow from './main-window.tsx';

const model = vi.hoisted(() => {
  const user = { id: 'user', name: 'Alex', email: 'alex@example.test' };
  const sync = {
    state: 'idle',
    pending: 0,
    parked: 0,
    lastSyncedAt: null as number | null,
    error: null,
  };
  return {
    invoke: vi.fn(),
    searchHits: [] as SearchHitSnapshot[],
    workspacesReady: true,
    offline: false,
    apiFailure: false,
    showFolder: false,
    folderName: 'Projects',
    notes: [] as MeetingNoteSummary[],
    snapshot: {
      activeId: 'workspace',
      targetId: 'workspace',
      workspaces: [
        { id: 'workspace', name: 'Ada’s workspace', role: 'owner' as const, canCreate: true },
      ],
    },
    page: {
      id: 'page',
      workspaceId: 'workspace',
      folderId: null,
      ownerId: 'user',
      kind: 'page',
      title: 'Project page',
      visibility: 'private',
      version: 1,
      deletedAt: null,
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-20T00:00:00.000Z',
      access: { edit: true, delete: true },
      contentJson: { type: 'doc', content: [{ type: 'paragraph' }] },
    },
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
  bridge: () => ({
    subscribe: () => () => {},
    invoke: async (...args: unknown[]) => {
      try {
        return { ok: true, value: await model.invoke(...args) };
      } catch {
        return { ok: false, error: { code: 'network', message: 'Offline' } };
      }
    },
  }),
  BridgeCallError: class extends Error {},
}));
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
  SettingsView: ({ initialSection }: { initialSection: string }) => (
    <section data-testid="settings" data-settings-section={initialSection}>
      Settings content
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
    snapshot: model.workspacesReady ? model.snapshot : null,
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
  model.workspacesReady = true;
  model.offline = false;
  model.apiFailure = false;
  model.showFolder = false;
  model.folderName = 'Projects';
  model.sync.lastSyncedAt = null;
  model.notes = [];
  model.recording.status = 'idle';
  model.invoke.mockReset().mockImplementation(async (channel: string, request?: OatRequest) => {
    if (channel === 'app:info')
      return {
        appOrigin: 'https://web.oat.example',
        version: '0',
        platform: 'darwin',
        dev: true,
        packaged: false,
        coldStartMs: null,
      };
    if (channel === 'api:request') {
      if (model.offline) throw new Error('Offline');
      if (model.apiFailure)
        return { status: 500, body: { error: { code: 'internal', message: 'Unavailable' } } };
      let body: unknown = [];
      if (request?.path === '/api/folders' && model.showFolder)
        body = [
          {
            id: 'folder',
            workspaceId: 'workspace',
            ownerId: 'user',
            parentId: null,
            name: model.folderName,
            visibility: 'private',
            createdAt: '2026-11-20T00:00:00.000Z',
            updatedAt: '2026-11-20T00:00:00.000Z',
            access: { edit: true, delete: true },
          },
        ];
      if (request?.path === '/api/workspaces')
        body = {
          activeWorkspaceId: 'workspace',
          workspaces: [{ ...model.snapshot.workspaces[0], memberCount: 1 }],
        };
      if (request?.path === '/api/workspaces/joinable') body = { invites: [], workspaces: [] };
      if (request?.path === '/api/documents' && !request.query?.trash) body = [model.page];
      if (request?.path === '/api/documents/page') body = model.page;
      return { status: 200, body };
    }
    if (channel === 'recording:options')
      return { defaultInput: 'sidecar', defaultFixture: null, fixtures: [] };
    if (channel === 'conflicts:list') return { conflicts: [] };
    if (channel === 'search:query') return { hits: model.searchHits };
    if (channel === 'api:me') return { user: model.user };
    return undefined;
  });
});
afterEach(() => {
  toast.dismiss();
  cleanup();
  vi.unstubAllGlobals();
});

describe('desktop shell', () => {
  it('keeps new meeting recording behavior for click and shortcut', async () => {
    render(<MainWindow />);
    const button = screen.getByTestId('new-meeting');
    const search = screen.getByRole('button', { name: 'Search' });
    const menu = button.closest('[data-sidebar="menu"]');
    expect(menu).toBe(search.closest('[data-sidebar="menu"]'));
    expect(menu?.querySelector('button')).toBe(button);
    expect(button.getAttribute('data-sidebar')).toBe('menu-button');
    expect(button.className).toContain('text-brand-900');
    expect(button.className).toContain('hover:text-brand-1000');
    expect(button.parentElement?.querySelector('kbd')?.textContent).toBe('⌘N');
    expect(button.className).not.toContain('rounded-full');
    expect(button.closest('[data-sidebar="header"]')).not.toBeNull();
    expect(document.querySelector('[data-sidebar="header"] [data-testid="new-meeting"]')).toBe(
      button,
    );
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

  it.each(['metaKey', 'ctrlKey'] as const)(
    'lets editor link handling consume %s+K before global search',
    (modifier) => {
      render(<MainWindow />);
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
    const pageHit = await within(screen.getByRole('dialog')).findByText('Project page');
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

  it('exposes workspace and account actions through one footer menu', async () => {
    render(<MainWindow />);
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

  it.each([
    ['Invite members', 'members'],
    ['Workspace settings', 'workspace'],
    ['Profile', 'profile'],
  ])('opens %s in shared desktop settings', async (name, section) => {
    render(<MainWindow />);
    await userEvent.click(screen.getByTestId('workspace-switcher'));
    await userEvent.click(await screen.findByRole('menuitem', { name }));
    expect(screen.getByTestId('settings').getAttribute('data-settings-section')).toBe(section);
  });

  it('surfaces a failed account action', async () => {
    render(<MainWindow />);
    const invoke = model.invoke.getMockImplementation()!;
    model.invoke.mockImplementation((channel: string, ...args: unknown[]) =>
      channel === 'api:me' ? Promise.reject(new Error('offline')) : invoke(channel, ...args),
    );
    await userEvent.click(screen.getByTestId('workspace-switcher'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Check connection' }));
    expect(
      await screen.findByText('Something went wrong.', { selector: 'p[role="status"]' }),
    ).toBeTruthy();
  });

  it('keeps the header borderless and the sync and settings controls in the footer', async () => {
    render(<MainWindow />);
    const header = document.querySelector('header.app-drag')!;
    expect(header.className).not.toContain('border-b');
    expect(document.querySelector('[data-slot="sidebar"] .app-drag')?.className).not.toContain(
      'border-b',
    );
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
    const footer = screen.getByTestId('signed-in');
    expect(footer.contains(screen.getByTestId('workspace-switcher'))).toBe(true);
    expect(footer.contains(screen.getByTestId('sync-status'))).toBe(true);
    await userEvent.click(screen.getByRole('link', { name: 'Settings' }));
    expect(screen.getByTestId('settings')).toBeTruthy();
  });

  it('keeps new meeting pending and reports a failure from the header', async () => {
    render(<MainWindow />);
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
    await userEvent.click(screen.getByTestId('new-meeting'));
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
    render(<MainWindow />);
    expect(screen.getByTestId('workspace-switcher').textContent).toContain('Alex');
    await userEvent.click(screen.getByTestId('workspace-switcher'));
    expect(
      await screen.findByText('Account', { selector: '[data-slot="dropdown-menu-label"]' }),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(model.invoke).toHaveBeenCalledWith('auth:sign-out');
  });

  it('loads the shared tree through the proxy and opens a page in PageEditor', async () => {
    render(<MainWindow />);
    const page = await screen.findByRole('link', { name: 'Project page' });
    expect(page.getAttribute('href')).toBe('#/d/page');
    await userEvent.click(page);
    expect(((await screen.findByTestId('document-title')) as HTMLInputElement).value).toBe(
      'Project page',
    );
    expect(screen.queryByTestId('meeting-content')).toBeNull();
    expect(model.invoke).toHaveBeenCalledWith(
      'api:request',
      expect.objectContaining({ method: 'GET', path: '/api/documents/page' }),
    );
  });

  it('shows a clear page error for a server refusal, not an offline state', async () => {
    const invoke = model.invoke.getMockImplementation()!;
    model.invoke.mockImplementation((channel: string, request?: OatRequest) =>
      channel === 'api:request' && request?.path === '/api/documents/page'
        ? Promise.resolve({
            status: 404,
            body: { error: { code: 'not_found', message: 'Page not found' } },
          })
        : invoke(channel, request),
    );
    render(<MainWindow />);
    await userEvent.click(await screen.findByRole('link', { name: 'Project page' }));
    expect(await screen.findByRole('heading', { name: 'Page unavailable' })).toBeTruthy();
    expect(screen.getByText('Page not found')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'You’re offline' })).toBeNull();
  });

  it('opens an empty shared folder view and follows shell changes after sync', async () => {
    model.showFolder = true;
    const { rerender } = render(<MainWindow />);
    await userEvent.click(await screen.findByRole('link', { name: 'Projects' }));
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'This folder is empty' })).toBeTruthy();
    model.folderName = 'Renamed projects';
    model.sync.lastSyncedAt = 1;
    rerender(<MainWindow />);
    expect(await screen.findByRole('heading', { name: 'Renamed projects' })).toBeTruthy();
  });

  it('keeps recording controls available while browsing server-only routes', async () => {
    model.recording.status = 'recording';
    render(<MainWindow />);
    await userEvent.click(screen.getByTestId('nav-tasks'));
    expect(await screen.findByTestId('recording-bar')).toBeTruthy();
    expect(screen.getByText('Coming to the desktop app soon.')).toBeTruthy();
  });

  it('keeps local-only meetings in Private and opens the local-first MeetingView', async () => {
    model.notes = [
      {
        documentId: 'local',
        meetingId: null,
        workspaceId: 'workspace',
        ownerId: 'user',
        title: 'Local meeting',
        visibility: 'private',
        startedAt: null,
        endedAt: null,
        createdAt: '2026-11-20T00:00:00.000Z',
      },
    ];
    render(<MainWindow />);
    const meeting = await screen.findByRole('link', { name: 'Local meeting' });
    expect(meeting.closest('[data-testid="tree-section-private"]')).not.toBeNull();
    await userEvent.click(meeting);
    expect(screen.getByTestId('meeting-content').getAttribute('data-document-id')).toBe('local');
    expect(
      model.invoke.mock.calls.some(
        ([channel, req]) => channel === 'api:request' && req.path === '/api/documents/local',
      ),
    ).toBe(false);
  });

  it('keeps local notes on a cold offline load and routes tasks to the C3 slot', async () => {
    model.offline = true;
    model.notes = [
      {
        documentId: 'local',
        meetingId: null,
        workspaceId: 'workspace',
        ownerId: 'user',
        title: 'Offline meeting',
        visibility: 'private',
        startedAt: null,
        endedAt: null,
        createdAt: '2026-11-20T00:00:00.000Z',
      },
    ];
    render(<MainWindow />);
    expect(await screen.findByRole('link', { name: 'Offline meeting' })).toBeTruthy();
    await userEvent.click(screen.getByTestId('nav-tasks'));
    expect(screen.getByRole('heading', { name: 'My tasks' })).toBeTruthy();
    expect(screen.getByText('Coming to the desktop app soon.')).toBeTruthy();
    await userEvent.click(screen.getByRole('link', { name: 'Templates' }));
    expect(await screen.findByRole('heading', { name: 'You’re offline' })).toBeTruthy();
  });

  it('shows a calm page offline state without losing local notes, then retries', async () => {
    model.notes = [
      {
        documentId: 'local',
        meetingId: null,
        workspaceId: 'workspace',
        ownerId: 'user',
        title: 'Local meeting',
        visibility: 'private',
        startedAt: null,
        endedAt: null,
        createdAt: '2026-11-20T00:00:00.000Z',
      },
    ];
    render(<MainWindow />);
    const page = await screen.findByRole('link', { name: 'Project page' });
    model.offline = true;
    await userEvent.click(page);
    expect(await screen.findByRole('heading', { name: 'You’re offline' })).toBeTruthy();
    const status = screen.getByTestId('sync-status');
    expect(status.getAttribute('data-state')).toBe('offline');
    expect(status.getAttribute('aria-label')).toContain('Offline');
    expect(status.querySelector('svg')?.getAttribute('class')).toContain('tabler-icon-cloud-off');
    expect(status.querySelector('svg')?.getAttribute('class')).toContain('text-amber-900');
    expect(screen.queryByRole('button', { name: 'All changes synced' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Local meeting' })).toBeTruthy();
    model.offline = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('document-title')).toBeTruthy();
    expect(screen.getByTestId('sync-status').getAttribute('data-state')).toBe('idle');
  });

  it('shows offline trash and share without issuing server-only calls', async () => {
    model.offline = true;
    model.notes = [
      {
        documentId: 'local',
        meetingId: null,
        workspaceId: 'workspace',
        ownerId: 'user',
        title: 'Local meeting',
        visibility: 'private',
        startedAt: null,
        endedAt: null,
        createdAt: '2026-11-20T00:00:00.000Z',
      },
    ];
    render(<MainWindow />);
    await screen.findByText('Offline', { selector: '[role="status"]' });
    await userEvent.click(screen.getByTestId('open-trash'));
    expect(await screen.findByRole('heading', { name: 'You’re offline' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(screen.getByRole('link', { name: 'Local meeting' }));
    await userEvent.click(screen.getByTestId('share-button'));
    expect(await screen.findByRole('heading', { name: 'You’re offline' })).toBeTruthy();
    expect(
      model.invoke.mock.calls.some(
        ([channel, req]) => channel === 'api:request' && req.path.endsWith('/share'),
      ),
    ).toBe(false);
  });

  it('falls back to local notes when the shell API returns an error', async () => {
    model.apiFailure = true;
    model.notes = [
      {
        documentId: 'local',
        meetingId: null,
        workspaceId: 'workspace',
        ownerId: 'user',
        title: 'Kept on this Mac',
        visibility: 'private',
        startedAt: null,
        endedAt: null,
        createdAt: '2026-11-20T00:00:00.000Z',
      },
    ];
    render(<MainWindow />);
    expect(await screen.findByRole('link', { name: 'Kept on this Mac' })).toBeTruthy();
    expect(await screen.findByText('Offline', { selector: '[role="status"]' })).toBeTruthy();
  });
});
