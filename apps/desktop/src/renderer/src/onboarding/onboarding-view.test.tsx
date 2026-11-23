// @vitest-environment jsdom
import type { PermissionsSnapshot } from '@oat/core/bridge';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BridgeCallError } from '../bridge.ts';
import { OnboardingView } from './onboarding-view.tsx';

const model = vi.hoisted(() => ({
  permissions: null as PermissionsSnapshot | null,
  call: vi.fn(),
}));
vi.mock('../bridge.ts', () => ({
  call: model.call,
  BridgeCallError: class extends Error {
    constructor(_code: string, message: string) {
      super(message);
    }
  },
}));
vi.mock('./onboarding-state.ts', () => ({
  usePermissions: () => model.permissions,
  useTestRecording: () => null,
}));
const props = { firstRun: true, input: 'sidecar', onDone: vi.fn() };
beforeEach(() => {
  model.permissions = {
    microphone: 'not_determined',
    systemAudio: 'not_determined',
    systemAudioSupported: true,
    calendar: 'not_determined',
    google: 'not_connected',
  };
  model.call.mockReset();
});
afterEach(cleanup);

describe('calm setup', () => {
  it('shows one step in a dialog and keeps skip, back and focus navigation', async () => {
    render(<OnboardingView {...props} />);
    expect(screen.getByRole('dialog', { name: 'Set up Oat' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Your microphone' })).toBeTruthy();
    await userEvent.click(screen.getByTestId('onboarding-next'));
    expect(screen.queryByRole('heading', { name: 'Your microphone' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'The other side of the call' })).toBe(
      document.activeElement,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Go back' }));
    expect(screen.getByRole('heading', { name: 'Your microphone' })).toBeTruthy();
  });
  it('keeps blocked permission settings and errors reachable', async () => {
    model.permissions!.microphone = 'denied';
    model.call.mockRejectedValueOnce(new BridgeCallError('unavailable', 'Settings unavailable'));
    render(<OnboardingView {...props} />);
    await userEvent.click(screen.getByTestId('permission-open-settings'));
    expect(model.call).toHaveBeenCalledWith('permissions:open-settings', { kind: 'microphone' });
    expect(screen.getByText('Settings unavailable')).toBeTruthy();
    expect(screen.getByTestId('onboarding-next')).toBeTruthy();
  });
  it('keeps loading accessible until permissions arrive', () => {
    model.permissions = null;
    render(<OnboardingView {...props} />);
    expect(screen.getByLabelText('Loading')).toBeTruthy();
    expect(screen.getByTestId('onboarding').querySelector('[aria-busy=true]')).toBeTruthy();
    expect(screen.queryByTestId('permission-allow')).toBeNull();
  });
  it.each([
    ['not_determined', 'not_connected'],
    ['not_determined', 'ok'],
    ['denied', 'not_connected'],
    ['off', 'not_connected'],
    ['full_access', 'not_connected'],
  ] as const)('keeps one primary calendar action (%s / %s)', async (calendar, google) => {
    Object.assign(model.permissions!, { calendar, google });
    render(<OnboardingView {...props} />);
    await userEvent.click(screen.getByTestId('onboarding-nav-calendar'));
    expect(document.body.querySelectorAll('button.bg-gray-1000')).toHaveLength(1);
  });
});
