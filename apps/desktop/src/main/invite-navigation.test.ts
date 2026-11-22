import { expect, it, vi } from 'vitest';
import { InviteNavigation } from './invite-navigation';

it('retains a validated invitation until completion, including across renderer/sign-in readiness', () => {
  const notify = vi.fn();
  const navigation = new InviteNavigation(notify);
  expect(navigation.route).toBeNull();
  expect(navigation.open('https://evil.test')).toBe(false);
  expect(notify).not.toHaveBeenCalled();
  const token = 'a'.repeat(32);
  expect(navigation.open(`oat://invite/${token}`)).toBe(true);
  expect(notify).toHaveBeenCalledOnce();
  expect(navigation.route).toEqual({ view: 'invite', token });
  expect(navigation.route).toEqual({ view: 'invite', token });
  expect(navigation.open('oat://invite/invalid')).toBe(false);
  expect(navigation.route?.token).toBe(token);
  navigation.clear();
  expect(navigation.route).toBeNull();
});
