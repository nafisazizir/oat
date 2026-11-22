// @vitest-environment jsdom
import { createOatClient, type OatTransport } from '@oat/client';
import type { InviteLanding } from '@oat/services/dto/workspaces';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { InviteResponse } from './invite-response';

const initial: InviteLanding = {
  state: 'pending',
  workspace: { id: 'w', name: 'Acme' },
  inviter: 'Alex',
  email: 'me@acme.test',
  role: 'member',
  viewerEmail: 'me@acme.test',
  access: 'invited',
};
const token = 'a'.repeat(32);
function setup(
  value: InviteLanding | undefined = initial,
  transport = vi.fn<OatTransport>(async () => ({ status: 200, json: async () => initial })),
) {
  const onHome = vi.fn();
  const onSwitchAccount = vi.fn();
  render(
    <InviteResponse
      client={createOatClient(transport)}
      token={token}
      initial={value}
      onHome={onHome}
      onSwitchAccount={onSwitchAccount}
    />,
  );
  return { transport, onHome, onSwitchAccount };
}
it.each([
  ['Accept invitation', 'accept', true],
  ['Decline', 'decline', undefined],
] as const)('responds through the typed client: %s', async (label, decision, joined) => {
  const { transport, onHome } = setup();
  fireEvent.click(screen.getByRole('button', { name: label }));
  await waitFor(() => expect(onHome).toHaveBeenCalledOnce());
  expect(onHome.mock.calls[0]).toEqual(joined ? [true] : []);
  expect(transport).toHaveBeenCalledWith(
    expect.objectContaining({ path: '/api/invites/' + decision, body: { token } }),
  );
});
it.each([
  [{ state: 'invalid' }, 'This invitation isn’t valid'],
  [{ ...initial, state: 'expired' }, 'This invitation has expired'],
  [{ ...initial, state: 'canceled' }, 'This invitation was revoked'],
  [{ ...initial, state: 'rejected' }, 'Invitation declined'],
  [{ ...initial, state: 'accepted' }, 'This invitation was already used'],
] as [InviteLanding, string][])('shows unavailable state %j', (value, title) => {
  setup(value);
  expect(screen.getByRole('heading', { name: title })).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Accept invitation' })).toBeNull();
});
it('offers account switching without accepting under the wrong identity', () => {
  const { onSwitchAccount, transport } = setup({ ...initial, access: 'wrong-account' });
  expect(
    screen.getByRole('button', { name: 'Sign in with a different account' }).className,
  ).toContain('bg-gray-100 ');
  fireEvent.click(screen.getByRole('button', { name: 'Sign in with a different account' }));
  expect(onSwitchAccount).toHaveBeenCalledOnce();
  expect(transport).not.toHaveBeenCalled();
});
it('switches an existing member into the workspace', async () => {
  const { transport, onHome } = setup({ ...initial, access: 'member' });
  fireEvent.click(screen.getByRole('button', { name: 'Open workspace' }));
  await waitFor(() => expect(onHome).toHaveBeenCalledWith(true));
  expect(transport).toHaveBeenCalledWith(
    expect.objectContaining({ path: '/api/workspaces/active', body: { workspaceId: 'w' } }),
  );
});
it('shows action errors and allows retry', async () => {
  const transport = vi.fn<OatTransport>().mockResolvedValueOnce({
    status: 403,
    json: async () => ({
      error: { code: 'forbidden', message: 'Invitation no longer available' },
    }),
  });
  const { onHome } = setup(initial, transport);
  fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Invitation no longer available',
  );
  expect(onHome).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Accept invitation' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
});
it('loads the invitation on desktop and retries offline failures', async () => {
  const transport = vi.fn<OatTransport>().mockRejectedValueOnce(new Error('offline'));
  render(
    <InviteResponse
      client={createOatClient(transport)}
      token={token}
      onHome={vi.fn()}
      onSwitchAccount={vi.fn()}
    />,
  );
  expect(screen.getByRole('status').textContent).toContain('Loading invitation');
  await screen.findByRole('alert');
  transport.mockResolvedValue({ status: 200, json: async () => initial });
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByRole('button', { name: 'Accept invitation' });
  expect(transport).toHaveBeenCalledWith(
    expect.objectContaining({ path: '/api/invites/lookup', body: { token } }),
  );
});
