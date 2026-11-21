import type { Role } from '@oat/core';

/** The members page's list state while a mutation is in flight (`useOptimistic` reducer). */
export interface MembersState<M extends { userId: string; role: Role }, I extends { id: string }> {
  members: M[];
  invites: I[];
}

export type MembersAction =
  | { type: 'role'; userId: string; role: Role }
  | { type: 'remove-member'; userId: string }
  | { type: 'remove-invite'; inviteId: string };

/** Applies one optimistic change; React drops it again when the transition ends (rollback on failure). */
export function applyMembersAction<
  M extends { userId: string; role: Role },
  I extends { id: string },
>(state: MembersState<M, I>, action: MembersAction): MembersState<M, I> {
  switch (action.type) {
    case 'role':
      return {
        ...state,
        members: state.members.map((m) =>
          m.userId === action.userId ? { ...m, role: action.role } : m,
        ),
      };
    case 'remove-member':
      return { ...state, members: state.members.filter((m) => m.userId !== action.userId) };
    case 'remove-invite':
      return { ...state, invites: state.invites.filter((i) => i.id !== action.inviteId) };
  }
}

/**
 * Runs a server action behind an optimistic update: applies `optimistic`, awaits `action`, and on a
 * refusal or a thrown error reports it through `onError` (the optimistic state is rolled back by React
 * when the surrounding transition settles). Resolves to whether the action succeeded.
 */
export async function runOptimistic(
  optimistic: () => void,
  action: () => Promise<{ ok: true } | { ok: false; error: string }>,
  onError: (message: string) => void,
): Promise<boolean> {
  optimistic();
  try {
    const result = await action();
    if (!result.ok) {
      onError(result.error);
      return false;
    }
    return true;
  } catch {
    onError('You’re offline or the server can’t be reached.');
    return false;
  }
}
