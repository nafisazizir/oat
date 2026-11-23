// @vitest-environment jsdom
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { NEW_WORKSPACE_CHAT_EVENT } from '@oat/ui/lib/assistant-events';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SidebarProvider } from '@oat/ui/components/sidebar';
import { ChatsSection } from './sidebar-chats';
import { hrefOf, type AppRoute } from './routes';

const model = vi.hoisted(() => ({
  threads: vi.fn(),
  workspace: 'w',
  online: true,
  route: { view: 'assistant', threadId: 't6' } as AppRoute,
}));
vi.mock('./host', () => ({
  useWorkspaceHost: () => ({
    client,
    online: model.online,
    route: model.route,
    Link: ({ route, ...props }: { route: AppRoute }) => <a href={hrefOf(route)} {...props} />,
  }),
}));
const client = { chat: { threads: model.threads } };
vi.mock('./shell-data', () => ({ useShellData: () => ({ workspace: { id: model.workspace } }) }));
beforeAll(() => {
  window.matchMedia = vi
    .fn()
    .mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} });
});
afterEach(() => {
  cleanup();
  model.threads.mockReset();
  model.workspace = 'w';
  model.online = true;
  model.route = { view: 'assistant', threadId: 't6' };
});
const renderChats = () =>
  render(
    <SidebarProvider>
      <ChatsSection key={model.workspace} />
    </SidebarProvider>,
  );
describe('sidebar chats', () => {
  it.each([
    [{ view: 'assistant', threadId: 'saved' }, {}],
    [{ view: 'home' }, {}],
    [{ view: 'assistant' }, { ctrlKey: true }],
    [{ view: 'assistant' }, { metaKey: true }],
  ] as const)('preserves normal link navigation for %j with %j', (route, modifiers) => {
    model.route = route;
    model.threads.mockResolvedValue({ threads: [] });
    renderChats();
    const reset = vi.fn();
    const navigation = vi.fn();
    const intercept = (event: MouseEvent) => {
      navigation(event.defaultPrevented);
      event.preventDefault();
    };
    window.addEventListener(NEW_WORKSPACE_CHAT_EVENT, reset);
    window.addEventListener('click', intercept);
    const link = screen.getByRole('link', { name: 'New chat' });
    expect(link.getAttribute('href')).toBe('/assistant');
    fireEvent.click(link, modifiers);
    expect(navigation).toHaveBeenCalledWith(false);
    expect(reset).not.toHaveBeenCalled();
    window.removeEventListener('click', intercept);
    window.removeEventListener(NEW_WORKSPACE_CHAT_EVENT, reset);
  });
  it('requests a fresh chat even when already on the empty assistant route', () => {
    model.route = { view: 'assistant' };
    model.threads.mockResolvedValue({ threads: [] });
    renderChats();
    const reset = vi.fn();
    window.addEventListener(NEW_WORKSPACE_CHAT_EVENT, reset);
    const link = screen.getByRole('link', { name: 'New chat' });
    fireEvent.click(link);
    expect(reset).toHaveBeenCalledOnce();
    expect((reset.mock.calls[0]![0] as CustomEvent).detail).toEqual({ workspaceId: 'w' });
    window.removeEventListener(NEW_WORKSPACE_CHAT_EVENT, reset);
  });
  it('shows five newest threads, active selection and new/all links; collapses independently', async () => {
    model.threads.mockResolvedValue({
      threads: Array.from({ length: 7 }, (_, i) => ({
        id: `t${i}`,
        title: `Chat ${i}`,
        updatedAt: `2026-01-0${i + 1}`,
      })),
    });
    renderChats();
    await screen.findByText('Chat 6');
    expect(screen.queryByText('Chat 1')).toBeNull();
    expect(screen.getByRole('link', { name: 'Chat 6' }).getAttribute('href')).toBe(
      '/assistant?thread=t6',
    );
    expect(screen.getByRole('link', { name: 'Chat 6' }).hasAttribute('data-active')).toBe(true);
    expect(screen.getByRole('link', { name: 'New chat' }).getAttribute('href')).toBe('/assistant');
    expect(screen.getByRole('link', { name: 'View all' }).getAttribute('href')).toBe('/assistant');
    await userEvent.click(screen.getByRole('button', { name: 'Chats' }));
    expect(screen.queryByText('Chat 6')).toBeNull();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByText('Chat 6')).toBeTruthy();
    expect(model.threads).toHaveBeenCalledWith(
      { workspaceId: 'w' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
  it.each(['empty', 'error', 'offline'])('keeps stable navigation when %s', async (state) => {
    model.online = state !== 'offline';
    if (state === 'error') model.threads.mockRejectedValue(new Error('offline'));
    else model.threads.mockResolvedValue({ threads: [] });
    renderChats();
    if (state !== 'offline') await waitFor(() => expect(model.threads).toHaveBeenCalled());
    expect(screen.getByTestId('nav-assistant').getAttribute('href')).toBe('/assistant');
    expect(screen.getByRole('link', { name: 'New chat' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'View all' })).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
    if (state === 'offline') expect(model.threads).not.toHaveBeenCalled();
  });
  it('hides "View all" when every chat is already listed', async () => {
    model.threads.mockResolvedValue({
      threads: Array.from({ length: 5 }, (_, i) => ({
        id: `t${i}`,
        title: `Chat ${i}`,
        updatedAt: `2026-01-0${i + 1}`,
      })),
    });
    renderChats();
    await screen.findByText('Chat 0');
    expect(screen.queryByRole('link', { name: 'View all' })).toBeNull();
  });
  it('refreshes recent threads on navigation after a conversation is saved', async () => {
    model.threads
      .mockResolvedValueOnce({ threads: [] })
      .mockResolvedValue({ threads: [{ id: 'new', title: 'New conversation', updatedAt: '' }] });
    const view = renderChats();
    await waitFor(() => expect(model.threads).toHaveBeenCalledTimes(1));
    model.route = { view: 'home' };
    view.rerender(
      <SidebarProvider>
        <ChatsSection key={model.workspace} />
      </SidebarProvider>,
    );
    expect(await screen.findByText('New conversation')).toBeTruthy();
    expect(model.threads).toHaveBeenCalledTimes(2);
  });
  it('aborts stale requests and resets threads on workspace change', async () => {
    let resolve!: (value: unknown) => void;
    model.threads
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      )
      .mockResolvedValue({ threads: [] });
    const view = renderChats();
    const signal = model.threads.mock.calls[0]![1].signal as AbortSignal;
    model.workspace = 'other';
    view.rerender(
      <SidebarProvider>
        <ChatsSection key={model.workspace} />
      </SidebarProvider>,
    );
    resolve({ threads: [{ id: 'old', title: 'Stale chat', updatedAt: '' }] });
    await waitFor(() => expect(model.threads).toHaveBeenCalledTimes(2));
    expect(signal.aborted).toBe(true);
    expect(screen.queryByText('Stale chat')).toBeNull();
  });
});
