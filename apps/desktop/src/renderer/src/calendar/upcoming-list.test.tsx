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

it('opens native Integrations from the empty Google CTA, without calling main', () => {
  render(<UpcomingList snapshot={snapshot} onOpen={vi.fn()} />);
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

it("says nothing is coming up, under today's date, when a readable calendar has no meetings", () => {
  render(<UpcomingList snapshot={{ ...snapshot, eventkit: 'full_access' }} onOpen={vi.fn()} />);
  expect(screen.getByRole('heading', { name: /^Today, \d+ \w+, \w+$/ })).toBeDefined();
  expect(screen.getByTestId('upcoming-empty').textContent).toContain('Nothing coming up');
  fireEvent.click(screen.getByRole('button', { name: 'Calendar settings' }));
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({ view: 'settings', section: 'setup' });
});

it('renders nothing when no calendar is readable and there is nothing to connect', () => {
  const { container } = render(
    <UpcomingList snapshot={{ ...snapshot, google: 'signed_out' }} onOpen={vi.fn()} />,
  );
  expect(container.childElementCount).toBe(0);
});

it('lists meetings under their day, each with its time range', () => {
  const start = new Date();
  start.setHours(start.getHours() + 1, 0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60_000);
  render(
    <UpcomingList
      snapshot={{
        ...snapshot,
        eventkit: 'full_access',
        events: [
          {
            id: 'e1',
            source: 'eventkit',
            title: 'Design review',
            start: start.toISOString(),
            end: end.toISOString(),
            calendarTitle: 'Work',
            calendarColor: null,
            others: 1,
            conferenceUrl: null,
            conferenceProvider: null,
            documentId: null,
          },
        ],
      }}
      onOpen={vi.fn()}
    />,
  );
  expect(screen.getAllByTestId('coming-up-day')).toHaveLength(1);
  expect(screen.getByTestId('upcoming-event').textContent).toMatch(/Design review\d+:00 – \d+:30/);
  expect(screen.queryByTestId('upcoming-empty')).toBeNull();
});
