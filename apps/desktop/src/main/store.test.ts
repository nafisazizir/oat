import { initialMainState, type MainStateSnapshot } from '@oat/core/bridge';
import { describe, expect, it } from 'vitest';

import { MainStore } from './store.ts';

describe('MainStore', () => {
  it('starts at seq 0 with auth restoring and nothing live', () => {
    const store = new MainStore();
    expect(store.snapshot()).toEqual({ seq: 0, state: initialMainState() });
    expect(store.state.auth.status).toBe('restoring');
  });

  it('bumps seq by one per change and notifies with the new snapshot', () => {
    const store = new MainStore();
    const seen: MainStateSnapshot[] = [];
    store.subscribe((s) => seen.push(s));
    store.update((s) => ({ ...s, auth: { status: 'signed-out', error: null } }));
    store.update((s) => ({ ...s, activeMeetingId: 'm1' }));
    expect(seen.map((s) => s.seq)).toEqual([1, 2]);
    expect(seen[1]!.state).toMatchObject({
      auth: { status: 'signed-out' },
      activeMeetingId: 'm1',
    });
  });

  it('returning the same object is a no-op', () => {
    const store = new MainStore();
    let calls = 0;
    store.subscribe(() => calls++);
    store.update((s) => s);
    expect(store.snapshot().seq).toBe(0);
    expect(calls).toBe(0);
  });

  it('rejects an invalid state and keeps the old one', () => {
    const store = new MainStore();
    expect(() =>
      store.update((s) => ({ ...s, recording: { status: 'exploded' } }) as never),
    ).toThrow();
    expect(store.snapshot()).toEqual({ seq: 0, state: initialMainState() });
  });

  it('strips fields that are not part of the state (e.g. a token)', () => {
    const store = new MainStore();
    store.update(
      (s) =>
        ({
          ...s,
          auth: { status: 'signed-in', user: { id: 'u', email: 'e', name: null }, token: 'x' },
        }) as never,
    );
    expect(JSON.stringify(store.snapshot())).not.toContain('token');
  });

  it('unsubscribe stops notifications; snapshots are frozen', () => {
    const store = new MainStore();
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.update((s) => ({ ...s, activeMeetingId: 'a' }));
    off();
    store.update((s) => ({ ...s, activeMeetingId: 'b' }));
    expect(calls).toBe(1);
    expect(Object.isFrozen(store.state)).toBe(true);
  });
});
