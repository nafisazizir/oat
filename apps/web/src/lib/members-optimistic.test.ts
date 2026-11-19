import { describe, expect, it, vi } from 'vitest';

import { applyMembersAction, runOptimistic } from './members-optimistic';

const state = {
  members: [
    { userId: 'a', role: 'owner' as const },
    { userId: 'b', role: 'member' as const },
  ],
  invites: [{ id: 'i1' }, { id: 'i2' }],
};

describe('applyMembersAction', () => {
  it('changes one member’s role and leaves the rest', () => {
    const next = applyMembersAction(state, { type: 'role', userId: 'b', role: 'admin' });
    expect(next.members).toEqual([
      { userId: 'a', role: 'owner' },
      { userId: 'b', role: 'admin' },
    ]);
    expect(next.invites).toBe(state.invites);
    expect(state.members[1]!.role).toBe('member');
  });

  it('removes a member', () => {
    const next = applyMembersAction(state, { type: 'remove-member', userId: 'a' });
    expect(next.members.map((m) => m.userId)).toEqual(['b']);
  });

  it('removes an invite', () => {
    const next = applyMembersAction(state, { type: 'remove-invite', inviteId: 'i1' });
    expect(next.invites).toEqual([{ id: 'i2' }]);
    expect(next.members).toBe(state.members);
  });

  it('ignores unknown ids', () => {
    expect(applyMembersAction(state, { type: 'remove-member', userId: 'zz' }).members).toEqual(
      state.members,
    );
  });
});

describe('runOptimistic', () => {
  it('applies the change first and reports success', async () => {
    const calls: string[] = [];
    const onError = vi.fn();
    const ok = await runOptimistic(
      () => calls.push('optimistic'),
      async () => {
        calls.push('action');
        return { ok: true };
      },
      onError,
    );
    expect(ok).toBe(true);
    expect(calls).toEqual(['optimistic', 'action']);
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports a refusal so the caller can roll back and toast', async () => {
    const onError = vi.fn();
    const ok = await runOptimistic(
      () => {},
      async () => ({ ok: false, error: 'A workspace always keeps at least one owner.' }),
      onError,
    );
    expect(ok).toBe(false);
    expect(onError).toHaveBeenCalledWith('A workspace always keeps at least one owner.');
  });

  it('reports a network failure', async () => {
    const onError = vi.fn();
    const ok = await runOptimistic(
      () => {},
      () => Promise.reject(new Error('fetch failed')),
      onError,
    );
    expect(ok).toBe(false);
    expect(onError).toHaveBeenCalledWith('You’re offline or the server can’t be reached.');
  });
});
