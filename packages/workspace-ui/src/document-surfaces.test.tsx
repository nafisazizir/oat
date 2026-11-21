// @vitest-environment jsdom
import { createOatClient, type OatRequest, type OatTransport } from '@oat/client';
import type { DocumentDetail, DocumentSharing, FolderSummary } from '@oat/services/dto/api-types';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { FolderView, ShellFolderView } from './folder-view';
import { WorkspaceHost } from './host';
import { PageEditor, PageEditorSurface, usePageEditor } from './page-editor';
import { hrefOf } from './routes';
import { ShareDialog } from './share-dialog';
import { ShellDataProvider } from './shell-data';
import { TreeActionsProvider } from './tree-actions';
import { documentNode, folderNode, type ShellData } from './tree';
import type { SaveDocument } from './use-autosave';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() } }));

const content = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      attrs: { id: 'block-1' },
      content: [{ type: 'text', text: 'Original body' }],
    },
  ],
};
const doc: DocumentDetail = {
  id: 'doc',
  workspaceId: 'w',
  folderId: 'f',
  ownerId: 'u',
  kind: 'page',
  title: 'Page title',
  visibility: 'private',
  version: 1,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
  deletedAt: null,
  access: { edit: true, delete: true },
  contentJson: content,
};
const folder: FolderSummary = {
  id: 'f',
  workspaceId: 'w',
  name: 'Projects',
  parentId: null,
  ownerId: 'u',
  visibility: 'workspace',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
  access: { edit: true, delete: true },
};
const sharing: DocumentSharing = {
  documentId: 'doc',
  kind: 'page',
  visibility: 'private',
  sharePath: null,
  shareTranscript: false,
  canShare: true,
  inPrivateFolder: false,
  owner: { id: 'u', name: 'User' },
  workspace: { id: 'w', name: 'Work', memberCount: 2 },
};
const workspace = { id: 'w', name: 'Work', role: 'owner' as const, members: 2 };
const shell: ShellData = {
  user: { id: 'u', name: 'User', email: 'u@test.com', image: null },
  workspace,
  workspaces: [workspace],
  documents: [folderNode(folder), documentNode(doc)],
  trash: [],
  canJoin: false,
};

function fake(
  mode:
    'success' | 'conflict' | 'rebase' | 'error' | 'share-error' | 'share-update-error' = 'success',
) {
  let current = doc;
  let access = sharing;
  let updates = 0;
  const transport = vi.fn<OatTransport>(async (request: OatRequest) => {
    let body: unknown = current;
    if (request.path.endsWith('/share')) {
      if (mode === 'share-error' || (mode === 'share-update-error' && request.method === 'PATCH'))
        return {
          status: 403,
          json: async () => ({ error: { code: 'forbidden', message: 'Sharing denied' } }),
        };
      if (request.method === 'PATCH') access = { ...access, ...(request.body as object) };
      body = access;
    } else if (request.method === 'PATCH') {
      updates++;
      if (mode === 'error')
        return {
          status: 403,
          json: async () => ({ error: { code: 'forbidden', message: 'Save denied' } }),
        };
      if (mode === 'conflict' || (mode === 'rebase' && updates === 1)) {
        current = { ...doc, version: 2, title: mode === 'conflict' ? 'Remote title' : doc.title };
        return {
          status: 409,
          json: async () => ({
            error: { code: 'stale_version', message: 'Changed elsewhere' },
            document: current,
          }),
        };
      }
      const patch = request.body as { title?: string; contentJson?: DocumentDetail['contentJson'] };
      current = { ...current, ...patch, version: current.version + 1 };
      body = current;
    }
    return { status: 200, json: async () => body };
  });
  const client = createOatClient(transport);
  const host: WorkspaceHost = {
    platform: 'desktop',
    client,
    route: { view: 'document', id: doc.id },
    hrefOf,
    online: true,
    navigate: vi.fn(),
    refresh: vi.fn(),
    Link: ({ route, ...props }) => <a href={hrefOf(route)} {...props} />,
  };
  const update = vi.spyOn(client.documents, 'update');
  const updateSharing = vi.spyOn(client.documents, 'updateSharing');
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <WorkspaceHost value={host}>
        <ShellDataProvider value={shell}>
          <TreeActionsProvider>{children}</TreeActionsProvider>
        </ShellDataProvider>
      </WorkspaceHost>
    );
  }
  return { host, update, updateSharing, Wrapper };
}

function Capture({ onChange }: { onChange: (state: ReturnType<typeof usePageEditor>) => void }) {
  const state = usePageEditor();
  useEffect(() => onChange(state), [onChange, state]);
  return null;
}

describe('ShareDialog', () => {
  it('changes visibility through the host client', async () => {
    const { Wrapper, updateSharing, host } = fake();
    render(<ShareDialog documentId={doc.id} />, { wrapper: Wrapper });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Share' }));
    await user.click(await screen.findByRole('radio', { name: /Workspace Everyone/ }));
    await waitFor(() =>
      expect(updateSharing).toHaveBeenCalledWith('doc', { visibility: 'workspace' }),
    );
    expect(await screen.findByText('Everyone in Work can open this.')).toBeTruthy();
    expect(host.refresh).toHaveBeenCalled();
  });
  it('reports a sharing load error', async () => {
    const { Wrapper } = fake('share-error');
    render(<ShareDialog documentId={doc.id} />, { wrapper: Wrapper });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Share' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Sharing denied');
  });
  it('rolls back a failed visibility change', async () => {
    const { Wrapper, host } = fake('share-update-error');
    render(<ShareDialog documentId={doc.id} />, { wrapper: Wrapper });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Share' }));
    await user.click(await screen.findByRole('radio', { name: /Workspace Everyone/ }));
    await waitFor(() =>
      expect(
        screen.getByRole('radio', { name: /Private Only you/ }).getAttribute('aria-checked'),
      ).toBe('true'),
    );
    expect(toast.error).toHaveBeenCalledWith('Sharing denied');
    expect(host.refresh).not.toHaveBeenCalled();
  });
});

describe('PageEditor', () => {
  it('autosaves title and real editor body changes with the current baseVersion', async () => {
    const { Wrapper, update, host } = fake();
    let state: ReturnType<typeof usePageEditor> | undefined;
    render(
      <PageEditor document={doc} workspace={workspace}>
        <PageEditorSurface />
        <Capture
          onChange={(next) => {
            state = next;
          }}
        />
      </PageEditor>,
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(state?.editorRef.current).toBeTruthy());
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'New title' },
    });
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('doc', { baseVersion: 1, title: 'New title' }),
    );
    await waitFor(() => expect(screen.getByTestId('save-status').dataset.state).toBe('saved'));
    act(() => {
      state!.editorRef.current!.commands.insertContent('Edited body ');
    });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls[1]).toMatchObject([
      'doc',
      { baseVersion: 2, contentJson: { type: 'doc' } },
    ]);
    expect(JSON.stringify(update.mock.calls[1]![1].contentJson)).toContain('Edited body');
    expect(host.refresh).toHaveBeenCalledTimes(1);
  });
  it('rebases a non-overlapping stale-version save', async () => {
    const { Wrapper, update } = fake('rebase');
    render(<PageEditor document={doc} workspace={workspace} />, { wrapper: Wrapper });
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Local title' },
    });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls[1]).toEqual(['doc', { baseVersion: 2, title: 'Local title' }]);
    expect(screen.getByTestId('save-status').dataset.state).toBe('saved');
  });
  it('stops a conflicting save and reloads the server copy through the host client', async () => {
    const { Wrapper, update } = fake('conflict');
    render(<PageEditor document={doc} workspace={workspace} />, { wrapper: Wrapper });
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Local title' },
    });
    expect(await screen.findByText('Changed elsewhere')).toBeTruthy();
    expect(update).toHaveBeenCalledTimes(1);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Title' })).toHaveProperty(
        'value',
        'Remote title',
      ),
    );
    expect(screen.queryByTestId('save-status')).toBeNull();
    expect(toast.dismiss).toHaveBeenCalledWith('conflict-doc');
  });
  it('reports a failed conflict reload', async () => {
    const { Wrapper, host } = fake('conflict');
    vi.spyOn(host.client.documents, 'get').mockRejectedValue(new Error('Offline'));
    render(<PageEditor document={doc} workspace={workspace} />, { wrapper: Wrapper });
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Local title' },
    });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Couldn’t reload this page. Try again.'),
    );
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveProperty('value', 'Local title');
  });
  it('renders a read-only trash banner and restores through the host client', async () => {
    const { Wrapper, host } = fake();
    const restore = vi.spyOn(host.client.documents, 'restore').mockResolvedValue(doc);
    render(<PageEditor document={{ ...doc, deletedAt: '2026-01-02' }} workspace={workspace} />, {
      wrapper: Wrapper,
    });
    expect(screen.getByTestId('trash-banner')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveProperty('readOnly', true);
    expect(screen.queryByTestId('document-actions')).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith('doc'));
    expect(host.refresh).toHaveBeenCalled();
  });
  it('keeps failed edits visible and exposes retry', async () => {
    const { Wrapper, update } = fake('error');
    render(<PageEditor document={doc} workspace={workspace} />, { wrapper: Wrapper });
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Unsaved title' },
    });
    expect(await screen.findByText('Couldn’t save')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveProperty('value', 'Unsaved title');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  });
  it('renders empty, read-only pages without saving', async () => {
    const { Wrapper, update } = fake();
    render(
      <PageEditor
        document={{
          ...doc,
          title: '',
          contentJson: { type: 'doc', content: [] },
          access: { edit: false, delete: false },
        }}
        workspace={workspace}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveProperty('readOnly', true);
    expect(screen.getByText('View only')).toBeTruthy();
    expect(
      (await screen.findByRole('textbox', { name: 'Note' })).getAttribute('contenteditable'),
    ).toBe('false');
    expect(update).not.toHaveBeenCalled();
  });
  it('passes the keepalive hint to the optional save override on unmount', async () => {
    const { Wrapper } = fake();
    const save = vi.fn<SaveDocument>().mockResolvedValue({ ...doc, version: 2 });
    const { unmount } = render(<PageEditor document={doc} workspace={workspace} save={save} />, {
      wrapper: Wrapper,
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Leaving' },
    });
    unmount();
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        'doc',
        { baseVersion: 1, title: 'Leaving' },
        { keepalive: true },
      ),
    );
  });
});

describe('FolderView', () => {
  it('lists children using the host Link', () => {
    const { Wrapper } = fake();
    render(<FolderView folder={folder} children={[documentNode(doc)]} workspace={workspace} />, {
      wrapper: Wrapper,
    });
    expect(screen.getByTestId('folder-contents')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Page title/ }).getAttribute('href')).toBe('/d/doc');
    expect(screen.getByRole('heading', { name: 'Projects' })).toBeTruthy();
  });
  it('derives children from shell data for desktop', () => {
    const { Wrapper } = fake();
    render(<ShellFolderView folder={folder} />, { wrapper: Wrapper });
    expect(screen.getByRole('link', { name: /Page title/ })).toBeTruthy();
  });
  it('shows an empty folder without a list', () => {
    const { Wrapper } = fake();
    render(<FolderView folder={folder} children={[]} workspace={workspace} />, {
      wrapper: Wrapper,
    });
    expect(screen.getByText('This folder is empty')).toBeTruthy();
    expect(screen.queryByTestId('folder-contents')).toBeNull();
  });
});
