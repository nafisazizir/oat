// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createOatClient, type OatClient, type OatRequest } from '@oat/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NotionExportButton } from './notion-export-button';

const model = vi.hoisted(() => ({
  client: {} as OatClient,
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('./provider', () => ({ useFeatureUi: () => ({ client: model.client }) }));
vi.mock('sonner', () => ({ toast: model.toast }));
afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());
function setup(
  options: {
    configured?: boolean;
    connection?: 'none' | 'reconnect' | 'target';
    exported?: boolean;
    fail?: boolean;
  } = {},
) {
  const beforeSend = vi.fn<() => Promise<boolean | void>>().mockResolvedValue(true);
  const settings = vi.fn();
  const open = vi.fn();
  const status = {
    configured: options.configured !== false,
    connection:
      options.connection === 'none'
        ? null
        : {
            needsReconnect: options.connection === 'reconnect',
            target:
              options.connection === 'target' ? null : { title: 'Notes', type: 'page', id: 'n' },
          },
    export: options.exported
      ? { url: 'https://notion.so/n', pushedAt: '2026-11-22T00:00:00Z', changedSince: true }
      : null,
  };
  const transport = vi.fn(async (req: OatRequest) => ({
    status: req.method === 'POST' && options.fail ? 409 : 200,
    json: async () =>
      req.method !== 'POST'
        ? status
        : options.fail
          ? { error: { code: 'notion_reconnect', message: 'Reconnect first' } }
          : {
              url: 'https://notion.so/n',
              pushedAt: '2026-11-22T00:00:00Z',
              pushedVersion: 3,
              created: !options.exported,
            },
  }));
  model.client = createOatClient(transport);
  render(
    <NotionExportButton
      documentId="d"
      beforeSend={beforeSend}
      onOpenIntegrations={settings}
      openExternal={open}
      fallback={<p>No control</p>}
    />,
  );
  return { beforeSend, settings, open, transport };
}
it('settles before sending and offers the returned external Notion URL', async () => {
  const env = setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Send to Notion' }));
  await waitFor(() => expect(model.toast.success).toHaveBeenCalled());
  const post = env.transport.mock.calls.findIndex(([req]) => req.method === 'POST');
  expect(env.beforeSend.mock.invocationCallOrder[0]).toBeLessThan(
    env.transport.mock.invocationCallOrder[post]!,
  );
  const options = model.toast.success.mock.calls[0]![1] as { action: { onClick(): void } };
  options.action.onClick();
  expect(env.open).toHaveBeenCalledWith('https://notion.so/n');
  expect(screen.getByRole('button', { name: 'Update in Notion' })).toBeTruthy();
});
it('updates an existing export and opens its older copy through the host', async () => {
  const env = setup({ exported: true });
  fireEvent.click(await screen.findByRole('link', { name: 'Notion copy is older' }));
  expect(env.open).toHaveBeenCalledWith('https://notion.so/n');
  fireEvent.click(screen.getByRole('button', { name: 'Update in Notion' }));
  await waitFor(() =>
    expect(model.toast.success).toHaveBeenCalledWith('Updated in Notion', expect.anything()),
  );
});
it.each([false, 'offline'])('does not send when preflight returns %s', async (failure) => {
  const env = setup();
  if (failure === false) env.beforeSend.mockResolvedValue(false);
  else env.beforeSend.mockRejectedValue(new Error('Offline'));
  fireEvent.click(await screen.findByRole('button', { name: 'Send to Notion' }));
  await waitFor(() => expect(model.toast.error).toHaveBeenCalled());
  expect(env.transport.mock.calls.some(([req]) => req.method === 'POST')).toBe(false);
});
it.each(['none', 'reconnect', 'target'] as const)(
  'routes %s connection recovery to host integrations without sending',
  async (connection) => {
    const env = setup({ connection });
    fireEvent.click(await screen.findByRole('button', { name: 'Send to Notion' }));
    const options = model.toast.error.mock.calls[0]![1] as { action: { onClick(): void } };
    options.action.onClick();
    expect(env.settings).toHaveBeenCalledOnce();
    expect(env.beforeSend).not.toHaveBeenCalled();
  },
);
it('keeps the fallback when the service is unconfigured', async () => {
  const env = setup({ configured: false });
  await waitFor(() => expect(env.transport).toHaveBeenCalledOnce());
  expect(screen.getByText('No control')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});
it('refreshes revoked connection state and exposes native settings recovery', async () => {
  const env = setup({ fail: true });
  fireEvent.click(await screen.findByRole('button', { name: 'Send to Notion' }));
  await waitFor(() =>
    expect(model.toast.error).toHaveBeenCalledWith('Couldn’t send to Notion', expect.anything()),
  );
  expect(env.transport.mock.calls.filter(([req]) => req.method === 'GET')).toHaveLength(2);
  const options = model.toast.error.mock.calls[0]![1] as { action: { onClick(): void } };
  options.action.onClick();
  expect(env.settings).toHaveBeenCalledOnce();
});
