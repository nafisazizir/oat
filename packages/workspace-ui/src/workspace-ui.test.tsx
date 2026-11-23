// @vitest-environment jsdom
import { createOatClient, type OatRequest, type OatTransport } from '@oat/client';
import { SidebarProvider } from '@oat/ui/components/sidebar';
import { ThemeProvider } from '@oat/settings-ui';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { LeaveWorkspaceDialog } from './leave-workspace-dialog';
import { useState } from 'react';
import { AppSidebar } from './app-sidebar';
import { WorkspaceHost } from './host';
import { hrefOf } from './routes';
import { ShellDataProvider } from './shell-data';
import { TreeActionsProvider, useTreeActions } from './tree-actions';
import type { ShellData } from './tree';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

beforeAll(() => {
  window.matchMedia = vi.fn().mockImplementation(() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});

const node = {
  id: 'p',
  title: 'Private page',
  kind: 'page' as const,
  visibility: 'private' as const,
  parentId: null,
  ownerId: 'u',
  updatedAt: '2026-01-01',
  access: { edit: true, delete: true },
};
const workspace = { id: 'w', name: 'Workspace', members: 1, role: 'owner' as const };
const data: ShellData = {
  user: { id: 'u', name: 'User', email: 'user@test.com', image: null },
  workspace,
  workspaces: [workspace],
  canJoin: false,
  documents: [node, { ...node, id: 's', title: 'Shared page', visibility: 'workspace' }],
  trash: [{ ...node, id: 't', title: 'Deleted page', deletedAt: '2026-01-01' }],
};

function Actions() {
  const actions = useTreeActions();
  const [leaveOpen, setLeaveOpen] = useState(false);
  return (
    <>
      <button onClick={() => setLeaveOpen(true)}>Test leave dialog</button>
      <LeaveWorkspaceDialog workspace={workspace} open={leaveOpen} onOpenChange={setLeaveOpen} />
      <button onClick={() => void actions.newPage()}>Create page</button>
      <button onClick={() => void actions.newFolder({})}>Create folder</button>
    </>
  );
}

function setup(
  value = data,
  fail = false,
  platform: WorkspaceHost['platform'] = 'web',
  overrides: Partial<WorkspaceHost> = {},
) {
  const transport = vi.fn<OatTransport>(async (request: OatRequest) => {
    if (fail)
      return {
        status: 403,
        json: async () => ({ error: { code: 'forbidden', message: 'Not allowed' } }),
      };
    return {
      status: 200,
      json: async () =>
        request.path === '/api/chat/threads'
          ? { threads: [] }
          : request.path === '/api/folders'
            ? { ...node, id: 'new-folder', name: 'New folder' }
            : { ...node, id: 'new-page', folderId: null, version: 1 },
    };
  });
  const client = createOatClient(transport);
  const host: WorkspaceHost = {
    platform,
    appOrigin: 'https://oat.example',
    client,
    route: { view: 'home' },
    hrefOf,
    navigate: vi.fn(),
    refresh: vi.fn(),
    online: true,
    Link: ({ route, ...props }) => <a href={hrefOf(route)} {...props} />,
    ...overrides,
  };
  const create = vi.spyOn(client.documents, 'create');
  const folder = vi.spyOn(client.folders, 'create');
  const restore = vi.spyOn(client.documents, 'restore');
  render(
    <WorkspaceHost value={host}>
      <ShellDataProvider value={value}>
        <SidebarProvider>
          <TreeActionsProvider>
            <ThemeProvider>
              <AppSidebar />
            </ThemeProvider>
            <Actions />
          </TreeActionsProvider>
        </SidebarProvider>
      </ShellDataProvider>
    </WorkspaceHost>,
  );
  return { host, create, folder, restore, user: userEvent.setup() };
}

describe('shared workspace shell', () => {
  it('shares aligned navigation and an account menu with reachable settings', async () => {
    setup();
    expect(screen.getByTestId('sidebar-header-trigger')).toBeTruthy();
    expect(screen.getByTestId('workspace-switcher').textContent).toContain('Workspace');
    expect(screen.getByRole('button', { name: 'Workspace' })).toBeTruthy();
    expect(screen.queryByTestId('theme-menu')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Templates' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
    await userEvent.click(screen.getByTestId('workspace-switcher'));
    expect(await screen.findByRole('menuitem', { name: /^Settings/ })).toBeTruthy();
    const menu = screen.getByRole('menu');
    expect(menu.querySelector('strong')?.textContent).toBe('User');
    expect(menu.textContent?.match(/user@test.com/g)).toHaveLength(1);
    expect(
      Array.from(menu.querySelectorAll('[role="menuitem"]'))
        .slice(0, 1)
        .map((item) => item.textContent),
    ).toEqual(['Settings⌘,']);
  });

  it('shows an account name fallback when the profile has no distinct name', async () => {
    setup({ ...data, user: { ...data.user, name: data.user.email } });
    await userEvent.click(screen.getByTestId('workspace-switcher'));
    const menu = await screen.findByRole('menu');
    expect(menu.querySelector('strong')?.textContent).toBe('user');
    expect(menu.textContent?.match(/user@test.com/g)).toHaveLength(1);
  });

  it('delegates cached offline switching to the host instead of REST', async () => {
    const switchWorkspace = vi.fn().mockResolvedValue(undefined);
    const { user, host } = setup(
      { ...data, workspaces: [workspace, { ...workspace, id: 'cached', name: 'Cached' }] },
      false,
      'desktop',
      { online: false, switchWorkspace },
    );
    const remote = vi.spyOn(host.client.workspaces, 'switchActive');
    await user.click(screen.getByTestId('workspace-switcher'));
    await user.click(await screen.findByRole('menuitem', { name: /Cached/ }));
    expect(switchWorkspace).toHaveBeenCalledWith('cached');
    expect(remote).not.toHaveBeenCalled();
    expect(host.refresh).toHaveBeenCalled();
  });
  it.each([4, 0, null])('exports desktop notes through the host (count %s)', async (count) => {
    const exportNotes = vi.fn().mockResolvedValue(count);
    const { user, host } = setup(
      { ...data, workspaces: [workspace, { ...workspace, id: 'other' }] },
      false,
      'desktop',
      { exportNotes },
    );
    const textExport = vi.spyOn(host.client.workspaces, 'export');
    await user.click(screen.getByRole('button', { name: 'Test leave dialog' }));
    await user.click(screen.getByTestId('export-notes'));
    expect(exportNotes).toHaveBeenCalledWith('w');
    expect(textExport).not.toHaveBeenCalled();
    if (count === null) expect(screen.queryByText(/Saved|file is empty/)).toBeNull();
    else
      expect(screen.getByRole('status').textContent).toContain(
        count === 0 ? 'file is empty' : 'Saved 4 notes to a ZIP file',
      );
  });
  it('shows native export failures without leaving the workspace', async () => {
    const { user, host } = setup(
      { ...data, workspaces: [workspace, { ...workspace, id: 'other' }] },
      false,
      'desktop',
      {
        exportNotes: vi.fn().mockRejectedValue(new Error('Couldn’t save the ZIP.')),
      },
    );
    const leave = vi.spyOn(host.client.workspaces, 'leave');
    await user.click(screen.getByRole('button', { name: 'Test leave dialog' }));
    await user.click(screen.getByTestId('export-notes'));
    expect(screen.getByTestId('export-error').textContent).toContain('Couldn’t save the ZIP.');
    expect(leave).not.toHaveBeenCalled();
  });
  it('keeps the web download confirmation while desktop uses a ZIP file', async () => {
    const { user } = setup(
      { ...data, workspaces: [workspace, { ...workspace, id: 'other' }] },
      false,
      'web',
      { exportNotes: vi.fn().mockResolvedValue(3) },
    );
    await user.click(screen.getByRole('button', { name: 'Test leave dialog' }));
    await user.click(screen.getByTestId('export-notes'));
    expect(screen.getByRole('status').textContent).toBe(
      'Saved 3 notes to your downloads. Check the file before you leave.',
    );
  });
  it('blocks leaving while recording without blocking export', async () => {
    const { user } = setup(
      { ...data, workspaces: [workspace, { ...workspace, id: 'other' }] },
      false,
      'desktop',
      {
        workspaceExitBlockedReason: 'Stop recording before leaving or deleting a workspace.',
      },
    );
    await user.click(screen.getByRole('button', { name: 'Test leave dialog' }));
    expect(
      (screen.getByRole('button', { name: 'Leave workspace' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByTestId('export-notes') as HTMLButtonElement).disabled).toBe(false);
  });
  it('renders the Private and Shared trees', () => {
    setup();
    expect(screen.getByText('Private')).toBeTruthy();
    expect(screen.getByText('Shared')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Private page' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Shared page' })).toBeTruthy();
  });
  it('collapses Private and Shared independently by click and keyboard', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Private' }));
    expect(screen.queryByRole('link', { name: 'Private page' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Shared page' })).toBeTruthy();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('link', { name: 'Private page' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Shared' }));
    expect(screen.queryByRole('link', { name: 'Shared page' })).toBeNull();
  });
  it('creates pages and folders with the host client and navigates to the page', async () => {
    const { user, create, folder, host } = setup();
    await user.click(screen.getByRole('button', { name: 'Create page' }));
    expect(create).toHaveBeenCalledWith({
      workspaceId: 'w',
      folderId: null,
      kind: 'page',
      visibility: 'private',
    });
    await waitFor(() =>
      expect(host.navigate).toHaveBeenCalledWith({ view: 'document', id: 'new-page' }),
    );
    await user.click(screen.getByRole('button', { name: 'Create folder' }));
    expect(folder).toHaveBeenCalledWith({
      workspaceId: 'w',
      parentId: null,
      name: 'New folder',
      visibility: 'private',
    });
    expect(await screen.findByRole('textbox', { name: 'Rename New folder' })).toBeTruthy();
  });
  it('restores trash with client.documents.restore', async () => {
    const { user, restore, host } = setup();
    await user.click(screen.getByTestId('workspace-switcher'));
    await user.click(await screen.findByTestId('open-trash'));
    await user.click(await screen.findByRole('button', { name: 'Restore' }));
    expect(restore).toHaveBeenCalledWith('t');
    await waitFor(() => expect(host.refresh).toHaveBeenCalled());
    expect(screen.queryByTestId('trash-item')).toBeNull();
  });
  it('shows an empty trash', async () => {
    const { user } = setup({ ...data, documents: [], trash: [] });
    await user.click(screen.getByTestId('workspace-switcher'));
    await user.click(await screen.findByTestId('open-trash'));
    expect(await screen.findByText('The trash is empty')).toBeTruthy();
  });
  it('rolls back a failed creation and reports the error', async () => {
    const { user, host } = setup(data, true);
    await user.click(screen.getByRole('button', { name: 'Create folder' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Couldn’t create the folder', {
        description: 'Not allowed',
      }),
    );
    expect(screen.queryByText('New folder')).toBeNull();
    expect(host.refresh).not.toHaveBeenCalled();
  });
});
