// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { ParticipantSummary } from './participants.tsx';

afterEach(cleanup);
const participant = { id: 'riley', name: 'Riley', email: null, source: 'manual' as const };
describe('participant summary', () => {
  it('keeps attendee details behind one metadata chip', async () => {
    render(<ParticipantSummary participants={[participant]} editable={false} />);
    expect(screen.queryByTestId('participant-chip')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '1 attendee' }));
    expect(screen.getByText('Riley')).toBeTruthy();
  });
  it('keeps adding attendees reachable on an empty meeting', async () => {
    render(<ParticipantSummary participants={[]} editable onAdd={async () => {}} />);
    await userEvent.click(screen.getByRole('button', { name: '0 attendees' }));
    expect(screen.getByTestId('add-participant')).toBeTruthy();
  });
  it('keeps removal errors visible inside the details', async () => {
    render(
      <ParticipantSummary
        participants={[participant]}
        editable
        onRemove={async () => {
          throw new Error('Try again');
        }}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '1 attendee' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove Riley' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Try again');
  });
});
