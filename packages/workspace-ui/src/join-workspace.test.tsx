// @vitest-environment jsdom
import { createOatClient, type OatTransport } from '@oat/client';
import type { JoinChoices } from '@oat/services/dto/workspaces';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { JoinWorkspace } from './join-workspace';
import { joinChoices } from './join-choices';

const choices: JoinChoices = {
  invites: [
    {
      token: 'token',
      role: 'admin',
      invitedBy: 'Owner',
      workspace: { id: 'invite', name: 'Invited', logo: null },
    },
  ],
  workspaces: [
    { id: 'open', name: 'Open', logo: null, memberCount: 1, option: 'join' },
    { id: 'ask', name: 'Ask', logo: null, memberCount: 2, option: 'request' },
    { id: 'waiting', name: 'Waiting', logo: null, memberCount: 2, option: 'requested' },
  ],
};
const empty: JoinChoices = { invites: [], workspaces: [] };

function setup({ member = false, initial = true, data = choices } = {}) {
  let current = structuredClone(data);
  const transport = vi.fn<OatTransport>(async (req) => {
    if (req.method === 'GET')
      return {
        status: 200,
        json: async () =>
          req.path.endsWith('/joinable')
            ? current
            : { workspaces: member ? [{ id: 'mine' }] : [], activeWorkspaceId: null },
      };
    if (req.path === '/api/invites/decline') current = { ...current, invites: [] };
    if (req.path.endsWith('/request-access'))
      current.workspaces = current.workspaces.map((w) =>
        w.id === 'ask' ? { ...w, option: 'requested' } : w,
      );
    return { status: 200, json: async () => ({ ok: true }) };
  });
  const client = createOatClient(transport);
  const onHome = vi.fn();
  const view = render(
    <JoinWorkspace
      client={client}
      email="me@company.test"
      onHome={onHome}
      initial={initial ? { member, choices: current } : undefined}
    />,
  );
  return { transport, client, onHome, ...view };
}

describe('join choices', () => {
  it('keeps a single primary invitation and quiet supporting actions', () => {
    setup();
    expect(
      screen.getByRole('button', { name: 'Accept the invitation to Invited' }).className,
    ).toContain('bg-gray-1000');
    for (const name of [
      'Decline the invitation to Invited',
      'Join Open',
      'Request access to Ask',
    ]) {
      expect(screen.getByRole('button', { name }).className).toContain('bg-gray-100 ');
    }
  });
  it('maps roles, member counts, pending and invalid icons without platform dependencies', () => {
    const rows = joinChoices(choices);
    expect(rows[0]?.detail).toBe('Owner invited you as an admin');
    expect(rows[1]?.detail).toBe('1 member · open to your domain');
    expect(rows[2]?.detail).toBe('2 members · needs approval');
    expect(rows[3]?.detail).toBe('Waiting for approval');
    expect(joinChoices(empty)).toEqual([]);
  });

  it.each([
    ['Accept the invitation to Invited', '/api/invites/accept', { token: 'token' }],
    ['Join Open', '/api/workspaces/open/join', undefined],
    ['Create my own workspace', '/api/workspaces/mine', undefined],
  ])('uses the typed endpoint and navigates home: %s', async (name, path, body) => {
    const { transport, onHome } = setup();
    fireEvent.click(screen.getByRole('button', { name }));
    await waitFor(() => expect(onHome).toHaveBeenCalledOnce());
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({ path, method: 'POST', ...(body ? { body } : {}) }),
    );
  });

  it('declines without leaving and refetches current invitations', async () => {
    const { transport, onHome } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Decline the invitation to Invited' }));
    await waitFor(() => expect(screen.queryByText('Invited')).toBeNull());
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/invites/decline', body: { token: 'token' } }),
    );
    expect(onHome).not.toHaveBeenCalled();
  });

  it('requests access, displays the pending badge and confirmation, and offers Back to members', async () => {
    const { onHome } = setup({ member: true });
    expect(screen.queryByText('Create my own workspace')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Request access to Ask' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Request access to Ask' })).toBeNull(),
    );
    expect(screen.getAllByText('Requested')).toHaveLength(2);
    expect(screen.getByRole('status').textContent).toContain('Request sent to Ask');
    const back = screen.getByRole<HTMLButtonElement>('button', { name: 'Back to Oat' });
    await waitFor(() => expect(back.disabled).toBe(false));
    fireEvent.click(back);
    await waitFor(() => expect(onHome).toHaveBeenCalledOnce());
  });

  it('keeps failures visible and re-enables actions without navigating', async () => {
    const { transport, onHome } = setup();
    transport.mockResolvedValueOnce({
      status: 400,
      json: async () => ({ error: { code: 'bad_request', message: 'Invitation expired' } }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Accept the invitation to Invited' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Invitation expired');
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Join Open' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(onHome).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'disables every action while an acceptance is pending (member=%s)',
    async (member) => {
      const { transport, onHome } = setup({ member });
      let finish!: (value: Awaited<ReturnType<OatTransport>>) => void;
      transport.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Accept the invitation to Invited' }));
      for (const button of screen.getAllByRole('button'))
        expect((button as HTMLButtonElement).disabled).toBe(true);
      if (member) {
        fireEvent.click(screen.getByRole('button', { name: 'Back to Oat' }));
        expect(onHome).not.toHaveBeenCalled();
      }
      await act(async () => {
        finish({ status: 200, json: async () => ({ ok: true }) });
      });
      expect(onHome).toHaveBeenCalledOnce();
    },
  );
});

describe('join loading and bootstrap', () => {
  it('loads through list/joinable when no server snapshot was supplied', async () => {
    const { transport } = setup({ initial: false });
    expect(screen.getByRole('status').textContent).toContain('Loading workspaces');
    await screen.findByText('Invited');
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/workspaces', method: 'GET' }),
    );
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/workspaces/joinable', method: 'GET' }),
    );
  });

  it.each([false, true])('empty choices create only for a newcomer (member=%s)', async (member) => {
    const { transport, onHome } = setup({ initial: false, data: empty, member });
    await waitFor(() => expect(onHome).toHaveBeenCalledOnce());
    expect(
      transport.mock.calls.filter(([req]) => req.path === '/api/workspaces/mine'),
    ).toHaveLength(member ? 0 : 1);
  });

  it('shows a load error and supports retry', async () => {
    const transport = vi.fn<OatTransport>().mockRejectedValueOnce(new Error('Offline'));
    const client = createOatClient(transport);
    render(<JoinWorkspace client={client} email="me@company.test" onHome={vi.fn()} />);
    expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t reach Oat');
    transport.mockImplementation(async (req) => ({
      status: 200,
      json: async () => (req.path.endsWith('/joinable') ? choices : { workspaces: [] }),
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('Invited');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reports bootstrap failures rather than navigating to an empty Home', async () => {
    const transport = vi.fn<OatTransport>(async (req) =>
      req.method === 'POST'
        ? {
            status: 500,
            json: async () => ({
              error: { code: 'failed', message: 'Couldn’t create your workspace.' },
            }),
          }
        : {
            status: 200,
            json: async () => (req.path.endsWith('/joinable') ? empty : { workspaces: [] }),
          },
    );
    const onHome = vi.fn();
    render(
      <JoinWorkspace client={createOatClient(transport)} email="me@company.test" onHome={onHome} />,
    );
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Couldn’t create your workspace.',
    );
    expect(onHome).not.toHaveBeenCalled();
  });

  it('does not navigate or create after unmount during loading', async () => {
    let finish!: (value: Awaited<ReturnType<OatTransport>>) => void;
    const transport = vi.fn<OatTransport>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const onHome = vi.fn();
    const { unmount } = render(
      <JoinWorkspace client={createOatClient(transport)} email="me@company.test" onHome={onHome} />,
    );
    unmount();
    await act(async () => {
      finish({ status: 200, json: async () => empty });
    });
    expect(onHome).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
