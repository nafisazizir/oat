// @vitest-environment jsdom
import { ThemeProvider } from '@oat/settings-ui';
import { TooltipProvider } from '@oat/ui/components/tooltip';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsView } from './settings-view.tsx';

const model = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../bridge.ts', () => ({
  call: model.invoke,
  bridge: () => ({
    subscribe: () => () => {},
    invoke: async (channel: string, input: { path: string }) => {
      if (channel !== 'api:request') throw new Error(channel);
      const body =
        input.path === '/api/profile'
          ? {
              name: 'Ada',
              email: 'ada@example.test',
              role: '',
              team: '',
              about: '',
              vocabulary: [],
              updatedAt: null,
            }
          : input.path === '/api/workspaces/team'
            ? {
                workspace: { id: 'team', name: 'Design', slug: 'design', icon: null },
                members: [],
                invites: [],
                joinRequests: [],
                inviteRoles: [],
                approveRoles: [],
                role: 'member',
                canManage: false,
                canLeave: true,
                restoreDays: 30,
              }
            : {};
      return { ok: true, value: { status: 200, body } };
    },
  }),
  BridgeCallError: class extends Error {},
}));
vi.mock('../onboarding/onboarding-state.ts', () => ({ usePermissions: () => null }));

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  Element.prototype.scrollIntoView = () => {};
  model.invoke.mockReset().mockImplementation(async (channel, value) => {
    if (channel === 'autostop:get-settings') return { enabled: true, inPerson: false };
    if (channel === 'autostop:set-settings') return { enabled: true, inPerson: false, ...value };
    if (channel === 'storage:list')
      return {
        totalBytes: 0,
        meetingCount: 0,
        deletedMeetings: 0,
        meetings: [],
        policy: { kind: 'forever' },
        lastSweep: null,
        otherAccounts: { meetings: 0, bytes: 0 },
      };
    return undefined;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(overrides: Partial<Parameters<typeof SettingsView>[0]> = {}) {
  return render(
    <TooltipProvider>
      <ThemeProvider>
        <SettingsView
          initialSection="preferences"
          workspace={{ id: 'team', name: 'Design' }}
          onClose={vi.fn()}
          onOpenSetup={vi.fn()}
          onWorkspaceExited={vi.fn()}
          {...overrides}
        />
      </ThemeProvider>
    </TooltipProvider>,
  );
}

describe('grouped desktop settings', () => {
  it('keeps native settings mounted across section navigation, including empty storage', async () => {
    show();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Appearance');
    expect(screen.getByRole('navigation', { name: 'Settings sections' }).textContent).toContain(
      'Account',
    );
    expect(screen.getByRole('navigation', { name: 'Settings sections' }).textContent).toContain(
      'Workspace',
    );
    await screen.findByTestId('autostop-enabled');
    await userEvent.click(screen.getByTestId('settings-section-recording'));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Recording');
    await userEvent.click(screen.getByTestId('autostop-enabled'));
    await waitFor(() =>
      expect(model.invoke).toHaveBeenCalledWith('autostop:set-settings', { enabled: false }),
    );
    await userEvent.click(screen.getByTestId('settings-section-storage'));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Storage');
    expect(screen.getByText('No recordings on this Mac')).toBeTruthy();
    expect(document.querySelector('[data-slot="card"]')).toBeNull();
    await userEvent.click(screen.getByTestId('settings-section-recording'));
    expect(
      (screen.getByTestId('autostop-enabled') as HTMLInputElement).getAttribute('aria-checked'),
    ).toBe('false');
    expect(model.invoke.mock.calls.filter(([c]) => c === 'storage:list')).toHaveLength(1);
  });

  it('preserves setup and Escape/Back actions', async () => {
    const close = vi.fn();
    const setup = vi.fn();
    show({ onClose: close, onOpenSetup: setup });
    await userEvent.click(screen.getByTestId('settings-section-setup'));
    expect(screen.getByTestId('setup-settings').querySelector('[aria-busy]')).toBeTruthy();
    await userEvent.click(screen.getByTestId('open-setup'));
    expect(setup).toHaveBeenCalledOnce();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByTestId('settings-close'));
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('offers General and Members for every workspace (D-36: one kind)', async () => {
    show();
    await screen.findByTestId('autostop-enabled');
    expect(screen.getByRole('button', { name: 'General' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Members' })).toBeTruthy();
  });

  it('renders profile and workspace panels natively and supports starting on Members', async () => {
    show({ initialSection: 'members' });
    expect(await screen.findByRole('heading', { name: 'Members', level: 1 })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Profile' }));
    expect(((await screen.findByLabelText('Name')) as HTMLInputElement).value).toBe('Ada');
    await userEvent.click(screen.getByRole('button', { name: 'General' }));
    expect(await screen.findByRole('heading', { name: 'Danger zone' })).toBeTruthy();
  });

  it('retains storage and recording load errors in their sections', async () => {
    model.invoke.mockRejectedValue(new Error('offline'));
    show();
    await userEvent.click(screen.getByTestId('settings-section-recording'));
    expect(await screen.findByText('Couldn’t load the recording settings.')).toBeTruthy();
    await userEvent.click(screen.getByTestId('settings-section-storage'));
    expect(await screen.findByText('Something went wrong.')).toBeTruthy();
  });
});
