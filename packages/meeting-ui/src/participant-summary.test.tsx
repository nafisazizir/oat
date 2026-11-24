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
    await userEvent.click(screen.getByRole('button', { name: 'Attendees: Riley' }));
    expect(screen.getByTestId('participant-details').textContent).toContain('Riley');
  });
  it('keeps adding attendees reachable on an empty meeting', async () => {
    render(<ParticipantSummary participants={[]} editable onAdd={async () => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add attendees' }));
    expect(screen.getByTestId('add-participant')).toBeTruthy();
  });
  it('shows nothing for a solo meeting I cannot edit', () => {
    const { container } = render(<ParticipantSummary participants={[]} editable={false} />);
    expect(container.innerHTML).toBe('');
  });
  it('shows faces and names, folding the rest into a count', () => {
    const people = ['Ana Lee', 'Ben Ito', 'Cy Park', 'Di Wu', 'Eve Ng'].map((name, i) => ({
      ...participant,
      id: String(i),
      name,
    }));
    render(<ParticipantSummary participants={people} editable={false} />);
    const trigger = screen.getByRole('button', { name: 'Attendees: Ana, Ben +3' });
    expect(trigger.textContent).toBe('ALBI+3Ana, Ben +3');
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
    await userEvent.click(screen.getByRole('button', { name: 'Attendees: Riley' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove Riley' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Try again');
  });
});
