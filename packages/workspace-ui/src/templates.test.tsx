// @vitest-environment jsdom
import { createOatClient, type OatTransport } from '@oat/client';
import type { TemplateDetail, TemplateDto, TemplateList } from '@oat/services/dto/templates';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { DeleteTemplateDialog } from './delete-template-dialog';
import { DuplicateButton } from './duplicate-button';
import { WorkspaceHost } from './host';
import { hrefOf } from './routes';
import { ShellDataProvider } from './shell-data';
import { TemplatePicker } from './template-picker';
import { TemplatesGallery } from './templates-gallery';
import { NewTemplateView, TemplateView } from './template-view';
import type { ShellData } from './tree';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const builtin: TemplateDto = {
  id: 'general',
  workspaceId: null,
  name: 'General',
  instructions: 'A useful summary',
  sections: [{ heading: 'Summary', instructions: 'Keep it short' }],
  isBuiltin: true,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};
const custom: TemplateDto = {
  ...builtin,
  id: 'custom',
  name: 'Team sync',
  workspaceId: 'w',
  isBuiltin: false,
};
const list: TemplateList = { builtins: [builtin], custom: [custom], canCreate: true };
const detail: TemplateDetail = { template: builtin, canEdit: false, canDuplicate: true };
const workspace = { id: 'w', name: 'Work', role: 'owner' as const, members: 1 };
const shell: ShellData = {
  user: { id: 'u', name: 'User', email: 'u@example.com', image: null },
  workspace,
  workspaces: [workspace],
  documents: [],
  trash: [],
  canJoin: false,
};

function fake(fail = false) {
  const transport = vi.fn<OatTransport>(async (request) => {
    if (fail)
      return {
        status: 403,
        json: async () => ({ error: { code: 'forbidden', message: 'Templates denied' } }),
      };
    if (request.method === 'DELETE') return { status: 204, json: async () => undefined };
    const body =
      request.method === 'POST'
        ? { ...detail, template: { ...custom, id: 'copy', name: 'General (copy)' } }
        : request.path.endsWith('/general')
          ? detail
          : list;
    return { status: 200, json: async () => body };
  });
  const client = createOatClient(transport);
  const host: WorkspaceHost = {
    platform: 'desktop',
    appOrigin: 'https://oat.example',
    client,
    route: { view: 'templates' },
    hrefOf,
    online: true,
    navigate: vi.fn(),
    refresh: vi.fn(),
    Link: ({ route, ...props }) => <a href={hrefOf(route)} {...props} />,
  };
  const load = vi.spyOn(client.templates, 'list');
  const get = vi.spyOn(client.templates, 'get');
  const duplicate = vi.spyOn(client.templates, 'duplicate');
  const remove = vi.spyOn(client.templates, 'delete');
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <WorkspaceHost value={host}>
        <ShellDataProvider value={shell}>{children}</ShellDataProvider>
      </WorkspaceHost>
    );
  }
  return { Wrapper, host, load, get, duplicate, remove };
}

describe('TemplatesGallery', () => {
  it('renders server data with host links without fetching', () => {
    const { Wrapper, load } = fake();
    render(<TemplatesGallery initialData={list} />, { wrapper: Wrapper });
    expect(screen.getAllByTestId('template-card')).toHaveLength(2);
    expect(
      screen.getByRole('link', { name: 'GeneralBuilt-in A useful summary Summary' }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: /General/ }).getAttribute('href')).toBe(
      '/templates/general',
    );
    expect(screen.getByRole('link', { name: 'New template' }).getAttribute('href')).toBe(
      '/templates/new',
    );
    expect(load).not.toHaveBeenCalled();
  });
  it('loads the active workspace templates without initial data', async () => {
    const { Wrapper, load } = fake();
    render(<TemplatesGallery />, { wrapper: Wrapper });
    expect(screen.getByRole('status').textContent).toBe('Loading templates…');
    expect(await screen.findByRole('link', { name: /Team sync/ })).toBeTruthy();
    expect(load).toHaveBeenCalledWith('w');
  });
  it('shows the empty viewer state without creation controls', () => {
    const { Wrapper } = fake();
    render(<TemplatesGallery initialData={{ builtins: [], custom: [], canCreate: false }} />, {
      wrapper: Wrapper,
    });
    expect(screen.getByText('No custom templates yet')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'New template' })).toBeNull();
  });
  it('shows load errors and retries', async () => {
    const { Wrapper, load } = fake(true);
    render(<TemplatesGallery />, { wrapper: Wrapper });
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('Templates denied'),
    );
    load.mockResolvedValue(list);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: /General/ })).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('TemplateView and mutations', () => {
  it('loads a detail and duplicates through the client before navigating', async () => {
    const { Wrapper, get, duplicate, host } = fake();
    render(<TemplateView templateId="general" />, { wrapper: Wrapper });
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Duplicate to customize' }));
    await waitFor(() =>
      expect(host.navigate).toHaveBeenCalledWith({ view: 'template', id: 'copy' }),
    );
    expect(get).toHaveBeenCalledWith('general', 'w');
    expect(duplicate).toHaveBeenCalledWith({ workspaceId: 'w', fromTemplateId: 'general' });
    expect(host.refresh).toHaveBeenCalled();
  });
  it('renders editable initial data without fetching', () => {
    const { Wrapper, get } = fake();
    render(
      <TemplateView
        templateId="custom"
        initialData={{ template: custom, canEdit: true, canDuplicate: true }}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getByRole('textbox', { name: 'Template name' })).toHaveProperty(
      'value',
      'Team sync',
    );
    expect(get).not.toHaveBeenCalled();
  });
  it('reports detail errors', async () => {
    const { Wrapper } = fake(true);
    render(<TemplateView templateId="missing" />, { wrapper: Wrapper });
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('Templates denied'),
    );
  });
  it('does not navigate when duplication fails', async () => {
    const { Wrapper, host } = fake(true);
    render(<DuplicateButton workspaceId="w" templateId="general" />, { wrapper: Wrapper });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Duplicate' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Templates denied'));
    expect(host.navigate).not.toHaveBeenCalled();
  });
  it('deletes through the client then returns to the gallery', async () => {
    const { Wrapper, host, remove } = fake();
    const close = vi.fn();
    render(
      <DeleteTemplateDialog open onOpenChange={close} templateId="custom" name="Team sync" />,
      { wrapper: Wrapper },
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Delete template' }));
    await waitFor(() => expect(host.navigate).toHaveBeenCalledWith({ view: 'templates' }));
    expect(remove).toHaveBeenCalledWith('custom');
    expect(close).toHaveBeenCalledWith(false);
    expect(host.refresh).toHaveBeenCalled();
  });
  it('keeps the delete dialog open on failure', async () => {
    const { Wrapper, host } = fake(true);
    const close = vi.fn();
    render(
      <DeleteTemplateDialog open onOpenChange={close} templateId="custom" name="Team sync" />,
      { wrapper: Wrapper },
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Delete template' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Templates denied'));
    expect(host.navigate).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalledWith(false);
  });
  it('creates from a blank form with a replace navigation', async () => {
    const { Wrapper, host } = fake();
    const create = vi.spyOn(host.client.templates, 'create');
    render(<NewTemplateView initialData={{ canCreate: true }} />, { wrapper: Wrapper });
    fireEvent.change(screen.getByRole('textbox', { name: 'Template name' }), {
      target: { value: 'New format' },
    });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create template' }));
    await waitFor(() =>
      expect(host.navigate).toHaveBeenCalledWith(
        { view: 'template', id: 'copy' },
        { replace: true },
      ),
    );
    expect(create).toHaveBeenCalledWith({
      workspaceId: 'w',
      name: 'New format',
      instructions: '',
      sections: [{ heading: 'Summary', instructions: '' }],
    });
  });
  it('loads creation permissions and blocks viewers', async () => {
    const { Wrapper, load } = fake();
    load.mockResolvedValue({ ...list, canCreate: false });
    render(<NewTemplateView />, { wrapper: Wrapper });
    expect(await screen.findByText('You can’t create templates here')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Template name' })).toBeNull();
  });
});

describe('TemplatePicker', () => {
  it('handles an empty template list without offering a selection', async () => {
    const { Wrapper, load } = fake();
    load.mockResolvedValue({ builtins: [], custom: [], canCreate: false });
    render(
      <TemplatePicker
        workspaceId="w"
        label="Enhance with template"
        trigger={<button>Pick a template</button>}
        onSelect={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Pick a template' }));
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    expect(screen.queryAllByTestId('enhance-template')).toHaveLength(0);
  });
  it('loads lazily and passes the selected template to the note action', async () => {
    const { Wrapper, load } = fake();
    const select = vi.fn();
    render(
      <TemplatePicker
        workspaceId="w"
        label="Enhance with template"
        trigger={<button>Pick a template</button>}
        onSelect={select}
      />,
      { wrapper: Wrapper },
    );
    expect(load).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Pick a template' }));
    expect((await screen.findByRole('menu')).getAttribute('data-size')).toBe('sm');
    await userEvent.setup().click(await screen.findByRole('menuitem', { name: 'Team sync' }));
    expect(load).toHaveBeenCalledWith('w');
    expect(select).toHaveBeenCalledWith('custom');
  });
  it('shows load errors without applying a template', async () => {
    const { Wrapper } = fake(true);
    const select = vi.fn();
    render(
      <TemplatePicker
        workspaceId="w"
        label="Enhance with template"
        trigger={<button>Pick a template</button>}
        onSelect={select}
      />,
      { wrapper: Wrapper },
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Pick a template' }));
    expect(await screen.findByText('Couldn’t load templates')).toBeTruthy();
    expect(select).not.toHaveBeenCalled();
  });
});
