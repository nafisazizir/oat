// @vitest-environment jsdom
import { createOatClient, type OatRequest, type OatTransport } from '@oat/client';
import { SidebarProvider } from '@oat/ui/components/sidebar';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
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
  return (
    <>
      <button onClick={() => void actions.newPage()}>Create page</button>
      <button onClick={() => void actions.newFolder({})}>Create folder</button>
    </>
  );
}

function setup(value = data, fail = false) {
  const transport = vi.fn<OatTransport>(async (request: OatRequest) => {
    if (fail)
      return {
        status: 403,
        json: async () => ({ error: { code: 'forbidden', message: 'Not allowed' } }),
      };
    return {
      status: 200,
      json: async () =>
        request.path === '/api/folders'
          ? { ...node, id: 'new-folder', name: 'New folder' }
          : { ...node, id: 'new-page', folderId: null, version: 1 },
    };
  });
  const client = createOatClient(transport);
  const host: WorkspaceHost = {
    platform: 'web',
    appOrigin: 'https://oat.example',
    client,
    route: { view: 'home' },
    hrefOf,
    navigate: vi.fn(),
    refresh: vi.fn(),
    online: true,
    Link: ({ route, ...props }) => <a href={hrefOf(route)} {...props} />,
  };
  const create = vi.spyOn(client.documents, 'create');
  const folder = vi.spyOn(client.folders, 'create');
  const restore = vi.spyOn(client.documents, 'restore');
  render(
    <WorkspaceHost value={host}>
      <ShellDataProvider value={value}>
        <SidebarProvider>
          <TreeActionsProvider>
            <AppSidebar />
            <Actions />
          </TreeActionsProvider>
        </SidebarProvider>
      </ShellDataProvider>
    </WorkspaceHost>,
  );
  return { host, create, folder, restore, user: userEvent.setup() };
}

describe('shared workspace shell', () => {
  it('renders the Private and Shared trees', () => {
    setup();
    expect(screen.getByText('Private')).toBeTruthy();
    expect(screen.getByText('Shared')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Private page' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Shared page' })).toBeTruthy();
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
    await user.click(screen.getByTestId('open-trash'));
    await user.click(await screen.findByRole('button', { name: 'Restore' }));
    expect(restore).toHaveBeenCalledWith('t');
    await waitFor(() => expect(host.refresh).toHaveBeenCalled());
    expect(screen.queryByTestId('trash-item')).toBeNull();
  });
  it('shows an empty trash', async () => {
    const { user } = setup({ ...data, documents: [], trash: [] });
    await user.click(screen.getByTestId('open-trash'));
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
