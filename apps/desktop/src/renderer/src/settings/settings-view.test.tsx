// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsView } from './settings-view.tsx';

const model = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../bridge.ts', () => ({
  call: model.invoke,
  bridge: () => ({ subscribe: () => () => {} }),
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

describe('grouped desktop settings', () => {
  it('keeps native settings mounted across section navigation, including empty storage', async () => {
    render(<SettingsView onClose={vi.fn()} onOpenSetup={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Preferences');
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
    render(<SettingsView onClose={close} onOpenSetup={setup} />);
    expect(screen.getByTestId('setup-settings').querySelector('[aria-busy]')).toBeTruthy();
    await userEvent.click(screen.getByTestId('open-setup'));
    expect(setup).toHaveBeenCalledOnce();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByTestId('settings-close'));
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('deep-links web-managed account/workspace settings and reports an open failure', async () => {
    render(<SettingsView onClose={vi.fn()} onOpenSetup={vi.fn()} />);
    await screen.findByTestId('autostop-enabled');
    for (const [label, section] of [
      ['Profile', 'profile'],
      ['Integrations', 'integrations'],
      ['General', 'workspace'],
      ['Members', 'members'],
    ]) {
      await userEvent.click(screen.getByRole('button', { name: `${label} (opens in browser)` }));
      await waitFor(() =>
        expect(model.invoke).toHaveBeenCalledWith('settings:open-web', { section }),
      );
    }
    model.invoke.mockRejectedValueOnce(new Error('browser unavailable'));
    await userEvent.click(screen.getByRole('button', { name: 'General (opens in browser)' }));
    expect(await screen.findByText('Something went wrong.')).toBeTruthy();
  });

  it('retains storage and recording load errors in their sections', async () => {
    model.invoke.mockRejectedValue(new Error('offline'));
    render(<SettingsView onClose={vi.fn()} onOpenSetup={vi.fn()} />);
    await userEvent.click(screen.getByTestId('settings-section-recording'));
    expect(await screen.findByText('Couldn’t load the recording settings.')).toBeTruthy();
    await userEvent.click(screen.getByTestId('settings-section-storage'));
    expect(await screen.findByText('Something went wrong.')).toBeTruthy();
  });
});
