// @vitest-environment jsdom
import { THEME_STORAGE_KEY } from '@oat/settings-ui/theme';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as ReactDOMClient from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const app = vi.hoisted(() => ({ root: undefined as ReactDOMClient.Root | undefined }));

vi.mock('react-dom/client', async (importOriginal) => {
  const client = await importOriginal<typeof ReactDOMClient>();
  return {
    ...client,
    createRoot: (...args: Parameters<typeof client.createRoot>) =>
      (app.root = client.createRoot(...args)),
  };
});
vi.mock('./bridge.ts', () => ({ bridge: () => ({ send: vi.fn() }) }));
vi.mock('./windows/main-window.tsx', async () => {
  const { createOatClient } = await import('@oat/client');
  const { SettingsPanel } = await import('@oat/settings-ui');
  const profile = {
    name: 'Ada',
    email: 'ada@example.test',
    role: '',
    team: '',
    about: '',
    vocabulary: [],
    updatedAt: null,
  };
  const client = createOatClient(async () => ({ status: 200, json: async () => profile }));
  return {
    default: () => (
      <SettingsPanel
        active="profile"
        workspaceName=""
        theme="dark"
        setTheme={() => {}}
        services={{
          client,
          workspaceId: '',
          exportNotes: async () => null,
          connect: async () => {},
          onWorkspaceExited: () => {},
        }}
      />
    ),
  };
});

afterEach(() => {
  act(() => app.root?.unmount());
  app.root = undefined;
  document.getElementById('root')?.remove();
  localStorage.removeItem(THEME_STORAGE_KEY);
  document.documentElement.classList.remove('dark');
  vi.unstubAllGlobals();
});

it('shows desktop settings notifications with the app theme', async () => {
  const container = document.createElement('div');
  container.id = 'root';
  document.body.appendChild(container);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  localStorage.setItem(THEME_STORAGE_KEY, 'dark');

  await act(async () => {
    await import('./main.tsx');
  });
  await userEvent.type(await screen.findByLabelText('Name'), ' Lovelace');
  await userEvent.click(screen.getByTestId('profile-save'));
  const toast = await screen.findByText('Profile saved');
  expect(toast.closest('[data-sonner-toaster]')?.getAttribute('data-sonner-theme')).toBe('dark');
});
