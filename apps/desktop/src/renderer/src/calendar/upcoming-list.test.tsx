// @vitest-environment jsdom
import type { CalendarSnapshot } from '@oat/core/bridge';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { UpcomingList } from './upcoming-list';

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), call: vi.fn() }));
vi.mock('@oat/workspace-ui', () => ({ useWorkspaceHost: () => ({ navigate: mocks.navigate }) }));
vi.mock('../bridge.ts', () => ({ call: mocks.call, BridgeCallError: class extends Error {} }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const snapshot: CalendarSnapshot = {
  seq: 1,
  updatedAt: null,
  events: [],
  eventkit: 'off',
  google: 'not_connected',
};

it('opens native Integrations from the empty compact Google CTA, without calling main', () => {
  render(<UpcomingList snapshot={snapshot} compact onOpen={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Connect Google Calendar' }));
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({
    view: 'settings',
    section: 'integrations',
  });
  expect(mocks.call).not.toHaveBeenCalled();
});

it('still asks main for native EventKit access', async () => {
  mocks.call.mockResolvedValue(snapshot);
  render(<UpcomingList snapshot={{ ...snapshot, eventkit: 'not_determined' }} onOpen={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /Connect.*calendar/i }));
  await waitFor(() =>
    expect(mocks.call).toHaveBeenCalledWith('calendar:connect', { provider: 'eventkit' }),
  );
  expect(mocks.navigate).not.toHaveBeenCalled();
});

it('shows native permission errors without leaving the app', async () => {
  mocks.call.mockRejectedValue(new Error('denied'));
  render(<UpcomingList snapshot={{ ...snapshot, eventkit: 'not_determined' }} onOpen={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /Connect.*calendar/i }));
  expect(await screen.findByText('Couldn’t connect the calendar.')).toBeDefined();
  expect(mocks.navigate).not.toHaveBeenCalled();
});

it('does not render before a calendar snapshot is available', () => {
  const { container } = render(<UpcomingList snapshot={null} onOpen={vi.fn()} />);
  expect(container.childElementCount).toBe(0);
});
