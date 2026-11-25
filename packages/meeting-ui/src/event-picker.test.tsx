// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EventChoices } from './event-picker.tsx';
import { MeetingTime } from './meeting-time.tsx';

afterEach(cleanup);

const STARTED = '2026-11-16T19:02:00.000Z';
const events = [
  {
    id: 'google:cal/review',
    title: 'Design review',
    start: '2026-11-16T19:00:00.000Z',
    end: '2026-11-16T19:30:00.000Z',
  },
  { id: 'google:cal/sync', title: '', start: '2026-11-16T20:00:00.000Z', end: STARTED },
];
const choices = (overrides: Partial<EventChoices> = {}): EventChoices => ({
  connected: true,
  state: 'ok',
  linked: false,
  linkedEventId: null,
  events,
  ...overrides,
});

function setup(load: () => Promise<EventChoices>, handlers: Partial<Record<string, unknown>> = {}) {
  const onLink = vi.fn(async () => undefined);
  const onUnlink = vi.fn(async () => undefined);
  render(
    <MeetingTime
      startedAt={STARTED}
      endedAt="2026-11-16T19:40:00.000Z"
      timeZone="UTC"
      events={{ load, onLink, onUnlink, ...handlers }}
    />,
  );
  return { onLink, onUnlink, user: userEvent.setup() };
}

describe('MeetingTime with an event picker', () => {
  it('stays a plain fact without `events`', () => {
    render(<MeetingTime startedAt={STARTED} endedAt={null} timeZone="UTC" />);
    expect(screen.getByTestId('meeting-time').tagName).toBe('SPAN');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('lists the events around the note and links the one picked', async () => {
    const load = vi.fn(async () => choices());
    const { onLink, user } = setup(load);
    const pill = screen.getByRole('button', { name: 'Calendar event' });
    expect(pill.getAttribute('data-testid')).toBe('meeting-time');
    await user.click(pill);
    const options = await screen.findAllByTestId('event-option');
    expect(load).toHaveBeenCalledTimes(1);
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('Design review'),
      expect.stringContaining('Untitled event'),
    ]);
    expect(options[0]!.textContent).toContain('7:00');
    expect(screen.queryByTestId('event-unlink')).toBeNull();
    await user.click(options[0]!);
    expect(onLink).toHaveBeenCalledWith(events[0]);
    // Linked: the menu closes.
    await waitFor(() => expect(screen.queryByTestId('event-picker')).toBeNull());
  });

  it('marks the linked event and unlinks it', async () => {
    const { onLink, onUnlink, user } = setup(async () =>
      choices({ linked: true, linkedEventId: events[0]!.id }),
    );
    await user.click(screen.getByRole('button', { name: 'Calendar event' }));
    const linked = (await screen.findAllByTestId('event-option'))[0]!;
    expect(linked.getAttribute('data-linked')).toBe('true');
    // Picking the linked one again does nothing.
    await user.click(linked);
    expect(onLink).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('event-unlink'));
    expect(onUnlink).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('event-picker')).toBeNull());
  });

  it('offers to unlink an event that is no longer among the choices', async () => {
    const { user } = setup(async () => choices({ linked: true, events: [] }));
    await user.click(screen.getByRole('button', { name: 'Calendar event' }));
    expect((await screen.findByTestId('event-picker-hint')).textContent).toBe(
      'No calendar events around this time.',
    );
    expect(screen.getByTestId('event-unlink')).toBeTruthy();
  });

  it.each([
    [choices({ connected: false, state: null, events: [] }), 'Connect a calendar in Settings'],
    [choices({ state: 'reconnect', events: [] }), 'Reconnect your calendar in Settings'],
    [choices({ state: 'error', events: [] }), 'Couldn’t read your calendar'],
  ])('explains why there is nothing to pick', async (result, text) => {
    const { user } = setup(async () => result);
    await user.click(screen.getByRole('button', { name: 'Calendar event' }));
    expect((await screen.findByTestId('event-picker-hint')).textContent).toContain(text);
    expect(screen.queryByTestId('event-option')).toBeNull();
  });

  it('keeps the menu open and says why when linking or loading fails', async () => {
    const onLink = vi.fn(async () => {
      throw new Error('That event isn’t in your calendar anymore.');
    });
    const { user } = setup(async () => choices(), { onLink });
    await user.click(screen.getByRole('button', { name: 'Calendar event' }));
    await user.click((await screen.findAllByTestId('event-option'))[0]!);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'That event isn’t in your calendar anymore.',
    );
    expect(screen.getByTestId('event-picker')).toBeTruthy();
    cleanup();

    const failing = setup(async () => {
      throw new Error('You can’t edit this note.');
    });
    await failing.user.click(screen.getByRole('button', { name: 'Calendar event' }));
    expect((await screen.findByRole('alert')).textContent).toBe('You can’t edit this note.');
  });
});
