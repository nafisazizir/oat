import type { ComponentProps } from 'react';
import type { InviteResponse } from '@oat/workspace-ui';
import type { InviteLanding } from '@oat/services/dto/workspaces';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { WebInviteResponse } from './invite-response';

const model = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
  signOut: vi.fn(),
  invite: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => model }));
vi.mock('@/lib/auth-client', () => ({ authClient: { signOut: model.signOut } }));
vi.mock('@oat/workspace-ui', () => ({
  InviteResponse: (props: unknown) => {
    model.invite(props);
    return null;
  },
}));
afterEach(() => vi.clearAllMocks());

it('keeps the browser destination default and provides only canonical native invite links', async () => {
  const token = 'a'.repeat(32);
  const initial: InviteLanding = { state: 'invalid' };
  renderToStaticMarkup(<WebInviteResponse token={token} initial={initial} />);
  const props = model.invite.mock.lastCall![0] as ComponentProps<typeof InviteResponse>;
  expect(props.initial).toEqual(initial);
  expect(props.desktopUrl).toBe('oat://invite/' + token);
  await props.onHome(true);
  expect(model.replace).toHaveBeenLastCalledWith('/home');
  await props.onSwitchAccount();
  expect(model.signOut).toHaveBeenCalledOnce();
  expect(model.replace).toHaveBeenLastCalledWith('/sign-in?next=%2Finvite%2F' + token);
  renderToStaticMarkup(<WebInviteResponse token="javascript:alert(1)" initial={initial} />);
  expect(model.invite.mock.lastCall![0].desktopUrl).toBeUndefined();
});
